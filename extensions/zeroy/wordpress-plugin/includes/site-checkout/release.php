<?php

defined('ABSPATH') || exit;

function zeroy_checkout_release_row_by_commit(string $commit_hash): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_releases') . ' WHERE commit_hash = %s ORDER BY created_at DESC LIMIT 1', $commit_hash), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_checkout_release_push_projection(array $release): array|WP_Error
{
    $state = (string) $release['state'];
    $proof_id = is_string($release['proof_id'] ?? null) && $release['proof_id'] !== '' ? $release['proof_id'] : null;
    if (in_array($state, ['active', 'superseded'], true)) return [
        'proof' => ['proofId' => $proof_id, 'state' => 'passed', 'failureCount' => 0],
        'release' => ['releaseId' => (string) $release['release_id'], 'state' => 'activated'],
    ];
    $receipt = zeroy_runtime_site_release_receipt((string) $release['release_id']);
    if (is_wp_error($receipt)) return $receipt;
    $failure_count = (int) ($receipt['diagnostics']['proof']['failureCount'] ?? 0);
    return [
        'proof' => ['proofId' => $proof_id, 'state' => $state === 'failed' ? 'blocked' : 'awaiting-browser', 'failureCount' => $failure_count],
        'candidate' => ['releaseId' => (string) $release['release_id'], 'state' => $state, 'browserVerification' => $receipt['browserVerification'] ?? null],
    ];
}

function zeroy_checkout_prepare_release_locked(string $commit_hash, string $ref_name, string $message, string $owner_principal): array|WP_Error
{
    $commit = zeroy_checkout_commit_row($commit_hash);
    if ($commit === null || !hash_equals((string) $commit['author_principal'], $owner_principal)) return zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit does not exist for this Connector principal.', 404);
    $ref = zeroy_checkout_ref_row($ref_name);
    if ($ref === null || !hash_equals((string) $ref['commit_hash'], $commit_hash)) return zeroy_runtime_error('zeroy_site_ref_changed', 'DraftRef no longer identifies the release commit.', 409, ['draftRef' => $ref_name]);
    $active = zeroy_runtime_active_site_release();
    $active_id = $active['active_release_id'] ?? null;
    if (($commit['base_release_id'] ?: null) !== $active_id) return zeroy_runtime_error('zeroy_active_site_release_changed', 'SiteCommit base does not match the active SiteRelease.', 409, ['commitBaseReleaseId' => $commit['base_release_id'] ?: null, 'activeReleaseId' => $active_id]);
    $existing = zeroy_checkout_release_row_by_commit($commit_hash);
    if ($existing !== null && (string) $existing['state'] !== 'preparing') return zeroy_checkout_release_push_projection($existing);
    $candidate = zeroy_checkout_compile_commit($commit_hash);
    if (is_wp_error($candidate)) return $candidate;
    $compiled = $candidate['compiled'];
    $snapshot = $candidate['snapshot'];
    if (!hash_equals((string) $commit['tree_hash'], (string) ($candidate['commit']['tree_hash'] ?? ''))) return zeroy_runtime_error('zeroy_candidate_materialization_mismatch', 'Candidate materialization root does not match SiteCommit tree.', 500);
    $migration_plan = zeroy_runtime_site_logic_migration_plan($compiled['siteLogicContract'], $active === null ? 0 : (int) $active['storage_epoch']);
    if (is_wp_error($migration_plan)) return $migration_plan;
    $migration = [
        'fromEpoch' => $active === null ? 0 : (int) $active['storage_epoch'],
        'toEpoch' => (int) $compiled['siteLogicContract']['storageEpoch'],
        'migrations' => array_map(static fn(array $item): string => $item['idempotencyKey'], $migration_plan),
        'state' => 'pending-verified-commit',
    ];
    global $wpdb;
    if ($wpdb->update(zeroy_runtime_table('theme_artifacts'), ['schema_json' => zeroy_runtime_json($compiled['schema']), 'schema_hash' => $compiled['schemaHash']], ['artifact_id' => $candidate['artifacts']['theme']['artifactId']]) === false) return zeroy_runtime_error('zeroy_theme_contract_store_failed', $wpdb->last_error ?: 'Could not store derived ThemeSchema.', 500);
    $release_id = $existing === null ? wp_generate_uuid4() : (string) $existing['release_id'];
    $release_values = [
        'commit_hash' => $commit_hash,
        'previous_release_id' => $active_id,
        'theme_artifact_id' => $candidate['artifacts']['theme']['artifactId'],
        'site_logic_artifact_id' => $candidate['artifacts']['siteLogic']['artifactId'],
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => $compiled['siteLogicContract']['storageEpoch'],
        'snapshot_hash' => $snapshot['snapshotHash'],
        'snapshot_json' => zeroy_runtime_json($snapshot),
        'expected_active_release_id' => $active_id,
        'state' => 'preparing',
        'proof_id' => null,
        'provenance_json' => zeroy_runtime_json(['source' => 'site-checkout', 'commit' => $commit_hash, 'draftRef' => $ref_name, 'message' => $message]),
        'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration]),
        'created_at' => current_time('mysql', true),
        'activated_at' => null,
    ];
    $written = $existing === null
        ? $wpdb->insert(zeroy_runtime_table('site_releases'), ['release_id' => $release_id, ...$release_values])
        : $wpdb->update(zeroy_runtime_table('site_releases'), $release_values, ['release_id' => $release_id]);
    if ($written === false || ($existing === null && $written !== 1)) return zeroy_runtime_error('zeroy_site_release_prepare_failed', $wpdb->last_error ?: 'Could not create commit-bound SiteRelease candidate.', 500);
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Candidate SiteRelease disappeared.', 500);
    $proof = zeroy_runtime_verify_candidate_site_release($release, $compiled);
    if (is_wp_error($proof)) return $proof;
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $state = $proof['blockingFailures'] === [] ? 'awaiting-browser' : 'failed';
    $updated = $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration, 'proof' => $proof])], ['release_id' => $release_id]);
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Could not finalize commit-bound CandidateProof.', 500);
    $release = zeroy_runtime_site_release_row($release_id);
    return $release === null ? zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Candidate SiteRelease disappeared.', 500) : zeroy_checkout_release_push_projection($release);
}

function zeroy_checkout_prepare_release(string $commit_hash, string $ref_name, string $message, string $owner_principal): array|WP_Error
{
    return zeroy_runtime_with_site_release_lock(
        static fn(): array|WP_Error => zeroy_checkout_prepare_release_locked($commit_hash, $ref_name, $message, $owner_principal),
    );
}

function zeroy_checkout_finalize_release(string $release_id, mixed $browser_evidence, string $owner_principal): array|WP_Error
{
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null || (string) $release['state'] !== 'awaiting-browser') return zeroy_runtime_error('zeroy_site_release_not_awaiting_browser', 'SiteRelease is not awaiting browser evidence.', 409, ['releaseId' => $release_id, 'state' => $release['state'] ?? null]);
    $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_principal);
    if (is_wp_error($owned)) return $owned;
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
    $updated = $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json($diagnostics)], ['release_id' => $release_id, 'state' => 'awaiting-browser'], ['%s', '%s', '%s'], ['%s', '%s']);
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_browser_finalize_conflict', 'Candidate changed while browser evidence was being attached.', 409, ['releaseId' => $release_id]);
    $prepared = zeroy_runtime_site_release_receipt($release_id);
    if (is_wp_error($prepared)) return $prepared;
    if (($prepared['state'] ?? null) !== 'prepared') return [
        'proof' => ['proofId' => $prepared['proofId'] ?? null, 'state' => 'blocked', 'failureCount' => (int) ($prepared['diagnostics']['proof']['failureCount'] ?? 0)],
    ];
    $active = zeroy_runtime_activate_site_release($release_id);
    if (is_wp_error($active)) return $active;
    return [
        'proof' => ['proofId' => $active['proofId'], 'state' => 'passed', 'failureCount' => 0],
        'release' => ['releaseId' => $release_id, 'state' => 'activated'],
    ];
}
