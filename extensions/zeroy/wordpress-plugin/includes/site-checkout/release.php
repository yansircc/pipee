<?php

defined('ABSPATH') || exit;

function zeroy_checkout_release_row_by_build(string $commit_hash, string $build_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_releases') . ' WHERE commit_hash = %s AND build_id = %s ORDER BY created_at DESC LIMIT 1', $commit_hash, $build_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_checkout_release_push_projection(array $release): array|WP_Error
{
    $state = (string) $release['state'];
    $proof_id = is_string($release['proof_id'] ?? null) && $release['proof_id'] !== '' ? $release['proof_id'] : null;
    if (in_array($state, ['active', 'superseded'], true)) return [
        'proof' => ['proofId' => $proof_id, 'state' => 'verified', 'failureCount' => 0],
        'release' => ['releaseId' => (string) $release['release_id'], 'state' => 'activated'],
    ];
    $receipt = zeroy_runtime_site_release_receipt((string) $release['release_id']);
    if (is_wp_error($receipt)) return $receipt;
    $failure_count = (int) ($receipt['diagnostics']['proof']['failureCount'] ?? 0);
    $preview = ['releaseId' => (string) $release['release_id'], 'url' => zeroy_runtime_admin_preview_url((string) $release['release_id']), 'state' => $state];
    if ($state === 'preview-awaiting-browser') return [
        'proof' => ['proofId' => $proof_id, 'state' => 'preview-awaiting-browser', 'failureCount' => $failure_count],
        'preview' => [...$preview, 'browserVerification' => $receipt['browserVerification'] ?? null],
    ];
    return [
        'proof' => ['proofId' => $proof_id, 'state' => $state === 'proof-ready' ? 'verified' : 'blocked', 'failureCount' => $failure_count],
        'preview' => $preview,
    ];
}

function zeroy_checkout_candidate_is_renderable(array $proof): bool
{
    $fatal_codes = ['candidate_runtime_unavailable', 'candidate_runtime_failed', 'candidate_php_error_output', 'candidate_cache_boundary_missing'];
    foreach (zeroy_runtime_site_release_proof_failures($proof) as $failure) {
        if (in_array($failure['code'] ?? null, $fatal_codes, true)) return false;
    }
    return true;
}

function zeroy_checkout_prepare_preview_locked(string $commit_hash, string $build_id, string $ref_name, string $message, string $owner_principal): array|WP_Error
{
    $commit = zeroy_checkout_commit_row($commit_hash);
    if ($commit === null || !hash_equals((string) $commit['author_principal'], $owner_principal)) return zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit does not exist for this Connector principal.', 404);
    $ref = zeroy_checkout_ref_row($ref_name);
    if ($ref === null || !hash_equals((string) $ref['commit_hash'], $commit_hash)) return zeroy_runtime_error('zeroy_site_ref_changed', 'DraftRef no longer identifies the release commit.', 409, ['draftRef' => $ref_name]);
    $active = zeroy_runtime_active_site_release();
    $active_id = $active['active_release_id'] ?? null;
    if (($commit['base_release_id'] ?: null) !== $active_id) return zeroy_runtime_error('zeroy_active_site_release_changed', 'SiteCommit base does not match the active SiteRelease.', 409, ['commitBaseReleaseId' => $commit['base_release_id'] ?: null, 'activeReleaseId' => $active_id]);
    $existing = zeroy_checkout_release_row_by_build($commit_hash, $build_id);
    if ($existing !== null && in_array((string) $existing['state'], ['preview-awaiting-browser', 'preview', 'proof-ready', 'active', 'superseded'], true)) return zeroy_checkout_release_push_projection($existing);
    $build_row = zeroy_build_row($build_id);
    $build = is_array($build_row) ? zeroy_build_result_projection($build_row) : null;
    if (!is_array($build) || ($build['commit'] ?? null) !== $commit_hash || !in_array($build['state'] ?? null, ['renderable', 'ready'], true)) return zeroy_runtime_error('zeroy_build_not_renderable', 'Preview requires the exact renderable BuildResult produced by Push.', 409, ['buildId' => $build_id]);
    $current_external_facts_hash = zeroy_build_external_facts_hash_for_commit($commit_hash);
    if (is_wp_error($current_external_facts_hash)) return $current_external_facts_hash;
    if (!hash_equals((string) $build['externalFactsHash'], $current_external_facts_hash)) return zeroy_runtime_error('zeroy_build_external_facts_changed', 'Relevant external facts changed after this Commit was built.', 409, ['buildId' => $build_id, 'next' => 'push another coherent repair slice']);
    $diagnostics = zeroy_build_diagnostics((string) $build_row['diagnostics_hash']);
    $candidate = is_array($diagnostics['candidate'] ?? null) ? $diagnostics['candidate'] : null;
    if (!is_array($candidate)) return zeroy_runtime_error('zeroy_build_candidate_missing', 'Ready BuildResult has no immutable candidate payload.', 500, ['buildId' => $build_id]);
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
        'build_id' => $build_id,
        'previous_release_id' => $active_id,
        'theme_artifact_id' => $candidate['artifacts']['theme']['artifactId'],
        'site_logic_artifact_id' => $candidate['artifacts']['siteLogic']['artifactId'],
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => $compiled['siteLogicContract']['storageEpoch'],
        'snapshot_hash' => $snapshot['snapshotHash'],
        'snapshot_json' => zeroy_runtime_json($snapshot),
        'expected_active_release_id' => $active_id,
        'review_brief_hash' => null,
        'state' => 'preview-awaiting-browser',
        'proof_id' => null,
        'provenance_json' => zeroy_runtime_json(['source' => 'site-checkout', 'commit' => $commit_hash, 'buildId' => $build_id, 'draftRef' => $ref_name, 'message' => $message]),
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
    $proof = is_array($candidate['verificationProof'] ?? null) ? $candidate['verificationProof'] : null;
    if (!is_array($proof) || !zeroy_checkout_candidate_is_renderable($proof)) {
        return zeroy_runtime_error('zeroy_build_not_renderable', 'BuildResult cannot produce a safe administrator PreviewRelease.', 409, ['buildId' => $build_id]);
    }
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $state = 'preview-awaiting-browser';
    $updated = $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration, 'proof' => $proof])], ['release_id' => $release_id]);
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Could not finalize commit-bound CandidateProof.', 500);
    $release = zeroy_runtime_site_release_row($release_id);
    return $release === null ? zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Candidate SiteRelease disappeared.', 500) : zeroy_checkout_release_push_projection($release);
}

function zeroy_checkout_prepare_preview(string $commit_hash, string $build_id, string $ref_name, string $message, string $owner_principal): array|WP_Error
{
    return zeroy_runtime_with_site_release_lock(
        static fn(): array|WP_Error => zeroy_checkout_prepare_preview_locked($commit_hash, $build_id, $ref_name, $message, $owner_principal),
    );
}

function zeroy_checkout_finalize_preview(string $release_id, mixed $browser_evidence, string $owner_principal): array|WP_Error
{
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404, ['releaseId' => $release_id]);
    $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_principal);
    if (is_wp_error($owned)) return $owned;
    if (zeroy_runtime_site_release_is_public($release) || in_array((string) $release['state'], ['preview', 'proof-ready'], true)) return zeroy_checkout_release_push_projection($release);
    if ((string) $release['state'] !== 'preview-awaiting-browser') return zeroy_runtime_error('zeroy_site_release_not_awaiting_browser', 'SiteRelease is not awaiting browser evidence.', 409, ['releaseId' => $release_id, 'state' => $release['state']]);
    $evidence = zeroy_runtime_decode_browser_evidence($browser_evidence);
    if (is_wp_error($evidence)) return $evidence;
    $prior_proof_row = is_string($release['proof_id'] ?? null) ? zeroy_runtime_site_release_proof_row((string) $release['proof_id']) : null;
    $prior_proof = is_array($prior_proof_row) ? zeroy_runtime_decode_json((string) $prior_proof_row['proof_json']) : null;
    if (!is_array($prior_proof) || ($prior_proof['buildId'] ?? null) !== ($release['build_id'] ?? null)) return zeroy_runtime_error('zeroy_build_verification_missing', 'Release has no exact BuildResult verification proof.', 409, ['buildId' => $release['build_id'] ?? null]);
    $proof = zeroy_runtime_attach_browser_evidence($release, $prior_proof, $evidence);
    if (is_wp_error($proof)) return $proof;
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $diagnostics = zeroy_runtime_decode_json((string) $release['diagnostics_json']);
    if (!is_array($diagnostics)) return zeroy_runtime_error('zeroy_site_release_diagnostics_invalid', 'Candidate diagnostics are not readable.', 409, ['releaseId' => $release_id]);
    $diagnostics['proof'] = $proof;
    $brief = zeroy_review_brief();
    $review_brief_hash = is_array($brief) ? zeroy_review_brief_hash($brief) : null;
    $state = $proof['blockingFailures'] === [] && $review_brief_hash !== null ? 'proof-ready' : 'preview';
    global $wpdb;
    $updated = $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'review_brief_hash' => $review_brief_hash, 'diagnostics_json' => zeroy_runtime_json($diagnostics)], ['release_id' => $release_id, 'state' => 'preview-awaiting-browser'], ['%s', '%s', '%s', '%s'], ['%s', '%s']);
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_browser_finalize_conflict', 'Candidate changed while browser evidence was being attached.', 409, ['releaseId' => $release_id]);
    $prepared = zeroy_runtime_site_release_row($release_id);
    return $prepared === null ? zeroy_runtime_error('zeroy_site_release_missing', 'PreviewRelease disappeared.', 500) : zeroy_checkout_release_push_projection($prepared);
}
