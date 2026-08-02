<?php

defined('ABSPATH') || exit;

function zeroy_runtime_prepare_site_release(string $theme_artifact_id, string $site_logic_artifact_id, ?string $expected_active_release_id, array $provenance, ?string $draft_id = null): array|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if (($active['active_release_id'] ?? null) !== $expected_active_release_id) return zeroy_runtime_error('zeroy_active_site_release_changed', 'The active SiteRelease changed after checkout.', 409, ['activeReleaseId' => $active['active_release_id'] ?? null]);
    $theme_integrity = zeroy_runtime_artifact_integrity($theme_artifact_id);
    $logic_integrity = zeroy_runtime_site_logic_artifact_integrity($site_logic_artifact_id);
    if (is_wp_error($theme_integrity) || ($theme_integrity['ok'] ?? false) !== true || is_wp_error($logic_integrity) || ($logic_integrity['ok'] ?? false) !== true) return zeroy_runtime_error('zeroy_release_artifact_invalid', 'Both immutable artifacts must exist and be intact.', 409);
    $compiled = zeroy_runtime_compile_theme_contract($theme_artifact_id, $site_logic_artifact_id);
    if (is_wp_error($compiled)) return $compiled;
    $draft = null;
    if ($draft_id !== null) {
        $draft = zeroy_runtime_site_draft_row($draft_id);
        if ($draft === null || !in_array((string) $draft['state'], ['open', 'committing'], true)) {
            return zeroy_runtime_error('zeroy_site_draft_not_preparable', 'SiteDraft must be open or committing before CandidateProof.', 409, ['draftId' => $draft_id, 'state' => $draft['state'] ?? null]);
        }
        $base = zeroy_runtime_site_draft_active_base($draft);
        if (is_wp_error($base)) return $base;
        if (($draft['base_release_id'] ?: null) !== ($expected_active_release_id ?: null)) {
            return zeroy_runtime_error('zeroy_site_draft_base_changed', 'SiteDraft base does not match the prepared SiteRelease.', 409, ['draftId' => $draft_id]);
        }
    }
    $snapshot = is_array($draft)
        ? zeroy_runtime_compile_draft_snapshot($draft, $compiled['contract'], $compiled['schema'])
        : zeroy_runtime_compile_base_snapshot($compiled['contract'], $compiled['schema']);
    if (is_wp_error($snapshot)) return $snapshot;
    $snapshot['operationsHash'] = is_array($draft) ? zeroy_runtime_hash(zeroy_runtime_site_draft_operations($draft)) : zeroy_runtime_hash([]);
    $snapshot['themeArtifactId'] = $theme_artifact_id;
    $snapshot['siteLogicArtifactId'] = $site_logic_artifact_id;
    unset($snapshot['snapshotHash']);
    $snapshot['snapshotHash'] = zeroy_runtime_hash($snapshot);
    // Candidate compilation may prove that a migration is valid, but it must
    // not mutate storage. MySQL DDL is applied only after this exact proof is
    // accepted, inside the serialized commit corridor immediately before the
    // active pointer CAS.
    $migration_plan = zeroy_runtime_site_logic_migration_plan(
        $compiled['siteLogicContract'],
        $active === null ? 0 : (int) $active['storage_epoch'],
    );
    if (is_wp_error($migration_plan)) return $migration_plan;
    $migration = [
        'fromEpoch' => $active === null ? 0 : (int) $active['storage_epoch'],
        'toEpoch' => (int) $compiled['siteLogicContract']['storageEpoch'],
        'migrations' => array_map(static fn(array $item): string => $item['idempotencyKey'], $migration_plan),
        'state' => 'pending-verified-commit',
    ];
    global $wpdb;
    if ($wpdb->update(zeroy_runtime_table('theme_artifacts'), ['schema_json' => zeroy_runtime_json($compiled['schema']), 'schema_hash' => $compiled['schemaHash']], ['artifact_id' => $theme_artifact_id]) === false) {
        return zeroy_runtime_error('zeroy_theme_contract_store_failed', $wpdb->last_error ?: 'Could not store derived ThemeSchema contract.', 500);
    }
    $release_id = wp_generate_uuid4();
    $written = $wpdb->insert(zeroy_runtime_table('site_releases'), [
        'release_id' => $release_id,
        'draft_id' => $draft_id,
        'theme_artifact_id' => $theme_artifact_id,
        'site_logic_artifact_id' => $site_logic_artifact_id,
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => $compiled['siteLogicContract']['storageEpoch'],
        'snapshot_hash' => $snapshot['snapshotHash'],
        'snapshot_json' => zeroy_runtime_json($snapshot),
        'expected_active_release_id' => $expected_active_release_id,
        'state' => 'preparing',
        'proof_id' => null,
        'provenance_json' => zeroy_runtime_json($provenance),
        'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration]),
        'created_at' => current_time('mysql', true),
        'activated_at' => null,
    ], ['%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s']);
    if ($written !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', $wpdb->last_error ?: 'Could not create SiteRelease candidate.', 500);
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Candidate release disappeared.', 500);
    $proof = zeroy_runtime_verify_candidate_site_release($release, $compiled);
    if (is_wp_error($proof)) return $proof;
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $state = $proof['blockingFailures'] === [] ? 'awaiting-browser' : 'failed';
    if ($wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration, 'proof' => $proof])], ['release_id' => $release_id]) !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Could not finalize candidate verification.', 500);
    if (is_array($draft)) {
        $bound = zeroy_runtime_bind_site_draft_proof(
            $draft,
            $release_id,
            $proof_id,
            $state,
            (string) $snapshot['operationsHash'],
            (string) $proof['verifiedAt'],
        );
        if (is_wp_error($bound)) return $bound;
    }
    return zeroy_runtime_site_release_receipt($release_id);
}

function zeroy_runtime_finalize_site_release_browser_evidence(string $release_id, mixed $browser_evidence, string $owner_id): array|WP_Error
{
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null || (string) $release['state'] !== 'awaiting-browser') {
        return zeroy_runtime_error('zeroy_site_release_not_awaiting_browser', 'SiteRelease is not awaiting browser evidence.', 409, ['releaseId' => $release_id, 'state' => $release['state'] ?? null]);
    }
    if (!empty($release['draft_id'])) {
        $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_id);
        if (is_wp_error($owned)) return $owned;
    }
    $evidence = zeroy_runtime_decode_browser_evidence($browser_evidence);
    if (is_wp_error($evidence)) return $evidence;
    $compiled = zeroy_runtime_compile_theme_contract((string) $release['theme_artifact_id'], (string) $release['site_logic_artifact_id']);
    if (is_wp_error($compiled)) return $compiled;
    $proof = zeroy_runtime_verify_candidate_site_release_with_browser($release, $compiled, $evidence);
    if (is_wp_error($proof)) return $proof;
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $diagnostics = zeroy_runtime_decode_json((string) $release['diagnostics_json']);
    if (!is_array($diagnostics)) return zeroy_runtime_error('zeroy_site_release_diagnostics_invalid', 'Candidate diagnostics are not readable.', 409, ['releaseId' => $release_id]);
    $diagnostics['proof'] = $proof;
    $state = $proof['blockingFailures'] === [] ? 'prepared' : 'failed';
    global $wpdb;
    $updated = $wpdb->update(
        zeroy_runtime_table('site_releases'),
        ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json($diagnostics)],
        ['release_id' => $release_id, 'state' => 'awaiting-browser'],
        ['%s', '%s', '%s'],
        ['%s', '%s'],
    );
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_browser_finalize_conflict', 'Candidate changed while browser evidence was being attached.', 409, ['releaseId' => $release_id]);
    if (!empty($release['draft_id'])) {
        $draft = zeroy_runtime_site_draft_row((string) $release['draft_id']);
        if (!is_array($draft)) return zeroy_runtime_error('zeroy_site_draft_missing', 'Candidate SiteDraft disappeared before browser evidence was attached.', 409, ['releaseId' => $release_id]);
        $operations = zeroy_runtime_site_draft_operations($draft);
        if (is_wp_error($operations)) return $operations;
        $bound = zeroy_runtime_bind_site_draft_proof($draft, $release_id, $proof_id, $state, zeroy_runtime_hash($operations), (string) $proof['verifiedAt']);
        if (is_wp_error($bound)) return $bound;
        if ($state === 'failed') zeroy_runtime_site_draft_reopen_after_commit_failure((string) $release['draft_id']);
    }
    return zeroy_runtime_site_release_receipt($release_id);
}
