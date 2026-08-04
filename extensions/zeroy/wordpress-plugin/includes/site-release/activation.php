<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_release_theme_schema(array $release): array|WP_Error
{
    $diagnostics = zeroy_runtime_decode_json((string) ($release['diagnostics_json'] ?? ''));
    $schema = is_array($diagnostics) ? ($diagnostics['themeSchema'] ?? null) : null;
    return is_array($schema) && ($schema['contract'] ?? null) === ZEROY_THEME_SCHEMA_CONTRACT && is_array($schema['schemas'] ?? null)
        ? $schema
        : zeroy_runtime_error('zeroy_site_release_schema_missing', 'Prepared SiteRelease no longer has a valid candidate ThemeSchema.', 409);
}

function zeroy_runtime_site_release_logic_contract(array $release): array|WP_Error
{
    $artifact = zeroy_runtime_site_logic_artifact_row((string) ($release['site_logic_artifact_id'] ?? ''));
    $contract = is_array($artifact) ? zeroy_runtime_decode_json((string) ($artifact['contract_json'] ?? '')) : null;
    return is_array($contract) && ($contract['contract'] ?? null) === ZEROY_SITE_LOGIC_CONTRACT
        ? $contract
        : zeroy_runtime_error('zeroy_site_release_logic_contract_missing', 'Prepared SiteRelease no longer has a valid SiteLogic contract.', 409);
}

function zeroy_runtime_site_release_activation_preflight(string $release_id): array|WP_Error
{
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null || $release['state'] !== 'proof-ready' || $release['proof_id'] === null) return zeroy_runtime_error('zeroy_site_release_not_proof_ready', 'SiteRelease must be proof-ready with a matching VerificationProof.', 409);
    $active = zeroy_runtime_active_site_release();
    if (($active['active_release_id'] ?? null) !== ($release['expected_active_release_id'] ?: null)) return zeroy_runtime_error('zeroy_active_site_release_changed', 'The active SiteRelease changed after verification.', 409, ['activeReleaseId' => $active['active_release_id'] ?? null]);
    $proof_row = zeroy_runtime_site_release_proof_row((string) $release['proof_id']);
    $proof = $proof_row === null ? null : zeroy_runtime_decode_json((string) $proof_row['proof_json']);
    if (!is_array($proof) || !zeroy_runtime_site_release_proof_valid($release, $proof)) return zeroy_runtime_error('zeroy_site_release_proof_stale', 'VerificationProof does not exactly bind this SiteRelease candidate.', 409);
    if (!zeroy_review_proof_ready_for_release($release)) return zeroy_runtime_error('zeroy_site_review_stale', 'Site Brief or Review is not proof-ready for this exact SiteRelease.', 409);
    $commit = zeroy_checkout_commit_row((string) ($release['commit_hash'] ?? ''));
    if ($commit === null || ($proof['commit'] ?? null) !== ($release['commit_hash'] ?? null) || ($commit['base_release_id'] ?: null) !== ($release['expected_active_release_id'] ?: null)) return zeroy_runtime_error('zeroy_site_release_commit_stale', 'SiteRelease, proof, commit, and active base do not identify one snapshot.', 409);
    $build_row = zeroy_build_row((string) ($release['build_id'] ?? ''));
    $build = is_array($build_row) ? zeroy_build_result_projection($build_row) : null;
    if (!is_array($build) || ($build['state'] ?? null) !== 'ready' || ($build['commit'] ?? null) !== ($release['commit_hash'] ?? null) || ($build['snapshotHash'] ?? null) !== ($release['snapshot_hash'] ?? null) || ($proof['buildId'] ?? null) !== ($build['buildId'] ?? null)) return zeroy_runtime_error('zeroy_site_release_build_stale', 'SiteRelease, proof, BuildResult, and snapshot do not identify one immutable build.', 409);
    $current_external_facts_hash = zeroy_build_external_facts_hash_for_commit((string) $release['commit_hash']);
    if (is_wp_error($current_external_facts_hash)) return $current_external_facts_hash;
    if (!hash_equals((string) $build['externalFactsHash'], $current_external_facts_hash)) return zeroy_runtime_error('zeroy_site_release_external_facts_stale', 'External facts changed after BuildResult verification.', 409, ['buildId' => $build['buildId']]);
    return ['release' => $release, 'active' => $active, 'proof' => $proof];
}

function zeroy_runtime_apply_verified_site_logic_migrations(array $release, ?array $active): array|WP_Error
{
    $contract = zeroy_runtime_site_release_logic_contract($release);
    if (is_wp_error($contract)) return $contract;
    $expected = zeroy_runtime_decode_json((string) ($release['diagnostics_json'] ?? ''));
    $expected_migration = is_array($expected) ? ($expected['migration'] ?? null) : null;
    $applied = zeroy_runtime_apply_site_logic_migrations($contract, $active);
    if (is_wp_error($applied)) return $applied;
    $expected_keys = is_array($expected_migration) && is_array($expected_migration['migrations'] ?? null) ? $expected_migration['migrations'] : null;
    if (
        !is_array($expected_migration)
        || !is_array($expected_keys)
        || ($expected_migration['fromEpoch'] ?? null) !== $applied['fromEpoch']
        || ($expected_migration['toEpoch'] ?? null) !== $applied['toEpoch']
        || $expected_keys !== $applied['migrations']
    ) return zeroy_runtime_error('zeroy_site_release_migration_plan_stale', 'SiteLogic migration plan changed after CandidateProof.', 409);
    return $applied;
}

function zeroy_runtime_activate_site_release_locked(string $release_id): array|WP_Error
{
    $preflight = zeroy_runtime_site_release_activation_preflight($release_id);
    if (is_wp_error($preflight)) return $preflight;
    // DDL is not transaction-safe in MySQL. It is deliberately after proof,
    // under the commit lock, and before the transactional active-pointer CAS.
    // All allowed migrations are additive and cannot change reader behavior.
    $migrated = zeroy_runtime_apply_verified_site_logic_migrations($preflight['release'], $preflight['active']);
    if (is_wp_error($migrated)) return $migrated;
    $result = zeroy_runtime_transaction(function () use ($release_id) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_site_release_lease();
        if (is_wp_error($lease)) return $lease;
        $content_lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($content_lease)) return $content_lease;
        $preflight = zeroy_runtime_site_release_activation_preflight($release_id);
        if (is_wp_error($preflight)) return $preflight;
        $release = $preflight['release'];
        $active = $preflight['active'];
        $schema = zeroy_runtime_site_release_theme_schema($release);
        if (is_wp_error($schema)) return $schema;
        $snapshot = zeroy_runtime_site_release_snapshot($release);
        if (is_wp_error($snapshot)) return $snapshot;
        $content_applied = zeroy_checkout_apply_materialization_plan($snapshot['materializationPlan'] ?? null, $schema);
        if (is_wp_error($content_applied)) return $content_applied;
        // Reconciliation observes the final materialized canonical state. The
        // active pointer remains last, so public readers only select the exact
        // immutable snapshot already bound by CandidateProof.
        $reconciled = zeroy_localization_apply_overlay_reconciliation($schema);
        if (is_wp_error($reconciled)) return $reconciled;
        $fault = apply_filters('zeroy_runtime_site_release_fault', null, 'activation.before-active-pointer');
        if (is_wp_error($fault)) return $fault;
        $now = current_time('mysql', true);
        if ($active !== null && $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => 'superseded'], ['release_id' => $active['active_release_id'], 'state' => 'active']) === false) return zeroy_runtime_error('zeroy_site_release_activate_failed', $wpdb->last_error ?: 'Could not supersede active SiteRelease.', 500);
        if ($wpdb->update(zeroy_runtime_table('site_releases'), ['state' => 'active', 'activated_at' => $now], ['release_id' => $release_id, 'state' => 'proof-ready']) !== 1) return zeroy_runtime_error('zeroy_site_release_activate_failed', 'Could not activate proof-ready SiteRelease.', 409);
        if ($active === null) {
            $state = $wpdb->insert(zeroy_runtime_table('site_release_state'), ['singleton' => 1, 'active_release_id' => $release_id, 'revision' => 1, 'activated_at' => $now]);
        } else {
            $state = $wpdb->update(zeroy_runtime_table('site_release_state'), ['active_release_id' => $release_id, 'revision' => (int) $active['revision'] + 1, 'activated_at' => $now], ['singleton' => 1, 'active_release_id' => $active['active_release_id'], 'revision' => $active['revision']]);
        }
        if ($state !== 1) return zeroy_runtime_error('zeroy_site_release_activate_failed', $wpdb->last_error ?: 'Could not move the active SiteRelease pointer.', 409);
        return zeroy_runtime_site_release_receipt($release_id);
    });
    if (!is_wp_error($result)) {
        wp_clean_themes_cache(true);
        flush_rewrite_rules(false);
    }
    return $result;
}

function zeroy_runtime_activate_site_release(string $release_id): array|WP_Error
{
    return zeroy_runtime_with_site_release_lock(static fn(): array|WP_Error => zeroy_runtime_activate_site_release_locked($release_id));
}
