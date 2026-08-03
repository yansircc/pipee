<?php

defined('ABSPATH') || exit;

/**
 * Convert the one active pre-checkout release in place. The immutable active
 * artifacts are the source; mutable runtime state is used only to compile the
 * first SiteSnapshot. Once the snapshot exists, the ordinary checkout
 * projection seeds its SiteCommit and the ordinary verifier binds the proof.
 * No request-time legacy reader or second release is introduced.
 */
function zeroy_runtime_migrate_active_site_release_snapshot(): true|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if ($active === null) return true;

    $stored_snapshot = trim((string) ($active['snapshot_json'] ?? ''));
    if ($stored_snapshot !== '') {
        $stored = zeroy_runtime_decode_json($stored_snapshot);
        $snapshot = zeroy_runtime_site_release_snapshot($active);
        if (!is_wp_error($snapshot)) {
            $commit = is_string($active['commit_hash'] ?? null) ? zeroy_checkout_commit_row($active['commit_hash']) : null;
            $proof_row = is_string($active['proof_id'] ?? null) ? zeroy_runtime_site_release_proof_row($active['proof_id']) : null;
            $proof = is_array($proof_row) ? zeroy_runtime_decode_json((string) $proof_row['proof_json']) : null;
            if (is_array($commit) && is_array($proof) && zeroy_runtime_site_release_proof_valid($active, $proof)) return zeroy_runtime_delete_pre_checkout_site_releases();
            return zeroy_runtime_error('zeroy_site_release_snapshot_incomplete', 'The active SiteSnapshot is not bound to one valid SiteCommit and VerificationProof.', 409, ['releaseId' => $active['active_release_id'] ?? null]);
        }
        if (!is_array($stored) || ($stored['contract'] ?? null) !== 'zeroy/draft-snapshot@1') {
            return zeroy_runtime_error(
                'zeroy_site_release_snapshot_corrupt',
                'The active SiteRelease has a snapshot payload but it is invalid; it cannot be rebuilt from mutable facts.',
                409,
                ['releaseId' => $active['active_release_id'] ?? null, 'cause' => $snapshot->get_error_code()],
            );
        }
    }

    $source_release_id = (string) ($active['active_release_id'] ?? '');
    $theme_artifact_id = (string) ($active['theme_artifact_id'] ?? '');
    $site_logic_artifact_id = (string) ($active['site_logic_artifact_id'] ?? '');
    if ($source_release_id === '' || $theme_artifact_id === '' || $site_logic_artifact_id === '') {
        return zeroy_runtime_error('zeroy_site_release_snapshot_migration_invalid', 'The active pre-SiteCheckout release has no complete artifact identity.', 409);
    }
    $previous_proof_id = is_string($active['proof_id'] ?? null) && $active['proof_id'] !== '' ? (string) $active['proof_id'] : null;
    $previous_proof_row = $previous_proof_id !== null
        ? zeroy_runtime_site_release_proof_row($previous_proof_id)
        : null;
    $previous_proof = is_array($previous_proof_row) ? zeroy_runtime_decode_json((string) $previous_proof_row['proof_json']) : null;
    $browser_checks = is_array($previous_proof) && is_array($previous_proof['themeProof']['browserChecks'] ?? null)
        ? $previous_proof['themeProof']['browserChecks']
        : null;
    if (!is_array($browser_checks) || ($browser_checks['kind'] ?? null) !== 'browser-executed' || ($browser_checks['failures'] ?? null) !== []) {
        return zeroy_runtime_error('zeroy_site_release_snapshot_migration_witness_missing', 'The active pre-checkout release has no reusable successful browser witness.', 409, ['releaseId' => $source_release_id]);
    }

    $compiled = zeroy_runtime_compile_theme_contract($theme_artifact_id, $site_logic_artifact_id);
    if (is_wp_error($compiled)) return $compiled;
    $snapshot = zeroy_runtime_compile_base_snapshot($compiled['contract'], $compiled['schema']);
    if (is_wp_error($snapshot)) return $snapshot;
    $snapshot_hash = zeroy_runtime_hash($snapshot);
    $snapshot['snapshotHash'] = $snapshot_hash;
    $migration = [
        'source' => 'hard-cut-site-checkout-migration',
        'fromReleaseId' => $source_release_id,
        'state' => 'converted-in-place',
    ];
    $release = [
        ...$active,
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => (int) $compiled['siteLogicContract']['storageEpoch'],
        'snapshot_hash' => $snapshot_hash,
        'snapshot_json' => zeroy_runtime_json($snapshot),
        'provenance_json' => zeroy_runtime_json($migration),
    ];
    $commit_hash = zeroy_checkout_store_release_commit($release);
    if (is_wp_error($commit_hash)) return $commit_hash;
    $release['commit_hash'] = $commit_hash;
    $foundation = zeroy_runtime_verify_site_release_foundation($release, $compiled);
    $scenario_hash = zeroy_runtime_hash($foundation['declaredScenarios']);
    $previous_theme = is_array($previous_proof['themeProof'] ?? null) ? $previous_proof['themeProof'] : null;
    $previous_logic = is_array($previous_proof['siteLogicProof'] ?? null) ? $previous_proof['siteLogicProof'] : null;
    $runtime_checks = is_array($previous_theme['runtimeChecks']['executedScenarios'] ?? null) ? $previous_theme['runtimeChecks']['executedScenarios'] : null;
    $html_checks = is_array($previous_theme['htmlChecks'] ?? null) ? $previous_theme['htmlChecks'] : null;
    if (
        !is_array($previous_theme)
        || !is_array($previous_logic)
        || ($previous_proof['blockingFailures'] ?? null) !== []
        || ($previous_theme['artifactId'] ?? null) !== $theme_artifact_id
        || ($previous_theme['themeContractHash'] ?? null) !== $compiled['hash']
        || ($previous_theme['siteLogicContractHash'] ?? null) !== $compiled['siteLogicContractHash']
        || ($previous_theme['runtimeVersion'] ?? null) !== ZEROY_RUNTIME_VERSION
        || ($previous_theme['verifierVersion'] ?? null) !== ZEROY_SITE_RELEASE_VERIFIER_VERSION
        || ($previous_theme['scenarioSetHash'] ?? null) !== $scenario_hash
        || ($previous_logic['artifactId'] ?? null) !== $site_logic_artifact_id
        || ($previous_logic['contractHash'] ?? null) !== $compiled['siteLogicContractHash']
        || ($previous_logic['storageEpoch'] ?? null) !== (int) $compiled['siteLogicContract']['storageEpoch']
        || !is_array($runtime_checks)
        || !is_array($html_checks)
        || ($html_checks['failures'] ?? null) !== []
    ) return zeroy_runtime_error('zeroy_site_release_snapshot_migration_witness_stale', 'The pre-checkout VerificationProof does not bind the migrated release foundation.', 409, ['releaseId' => $source_release_id]);
    $challenge = zeroy_runtime_browser_verification_challenge($release, $foundation['declaredScenarios']);
    if (is_wp_error($challenge) || !hash_equals((string) ($challenge['challengeHash'] ?? ''), (string) ($browser_checks['challengeHash'] ?? ''))) return zeroy_runtime_error('zeroy_site_release_snapshot_migration_witness_stale', 'The pre-checkout browser witness does not bind the migrated SiteSnapshot challenge.', 409, ['releaseId' => $source_release_id]);
    $proof = zeroy_runtime_build_site_release_proof(
        $release,
        $foundation,
        ['checks' => $runtime_checks, 'failures' => []],
        $html_checks,
        $browser_checks,
    );
    if (($proof['blockingFailures'] ?? []) !== []) return zeroy_runtime_error('zeroy_site_release_snapshot_migration_blocked', 'The converted active SiteRelease does not satisfy the current verifier.', 409, ['releaseId' => $source_release_id, 'blockingFailures' => array_slice($proof['blockingFailures'], 0, 20)]);
    $proof_id = zeroy_runtime_store_site_release_proof($source_release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $diagnostics = ['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration, 'proof' => $proof];
    global $wpdb;
    $bound = $wpdb->update(
        zeroy_runtime_table('site_releases'),
        [
            'commit_hash' => $commit_hash,
            'theme_contract_hash' => $compiled['hash'],
            'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
            'storage_epoch' => (int) $compiled['siteLogicContract']['storageEpoch'],
            'snapshot_hash' => $snapshot_hash,
            'snapshot_json' => zeroy_runtime_json($snapshot),
            'proof_id' => $proof_id,
            'provenance_json' => zeroy_runtime_json($migration),
            'diagnostics_json' => zeroy_runtime_json($diagnostics),
        ],
        ['release_id' => $source_release_id, 'commit_hash' => null],
    );
    if ($bound !== 1) {
        $wpdb->delete(zeroy_runtime_table('verification_proofs'), ['proof_id' => $proof_id], ['%s']);
        return zeroy_runtime_error('zeroy_site_release_snapshot_migration_failed', $wpdb->last_error ?: 'Could not atomically bind the SiteSnapshot, SiteCommit, and migration proof.', 500, ['releaseId' => $source_release_id]);
    }
    if ($previous_proof_id !== null && $previous_proof_id !== $proof_id) {
        $deleted = $wpdb->delete(zeroy_runtime_table('verification_proofs'), ['proof_id' => $previous_proof_id], ['%s']);
        if ($deleted !== 1) return zeroy_runtime_error('zeroy_site_release_snapshot_migration_failed', $wpdb->last_error ?: 'Could not remove the superseded pre-checkout proof.', 500, ['releaseId' => $source_release_id, 'proofId' => $previous_proof_id]);
    }
    return zeroy_runtime_delete_pre_checkout_site_releases();
}

/**
 * A hard cut retains migrated site facts in the active snapshot and source
 * provenance, not as a second release schema in history. Leaving rows without
 * a snapshot would make the release-history API emit objects outside its own
 * contract and would recreate a legacy-reader pressure path.
 */
function zeroy_runtime_delete_pre_checkout_site_releases(): true|WP_Error
{
    global $wpdb;
    $release_table = zeroy_runtime_table('site_releases');
    $proof_table = zeroy_runtime_table('verification_proofs');
    $legacy_ids = $wpdb->get_col("SELECT release_id FROM {$release_table} WHERE commit_hash IS NULL OR snapshot_json IS NULL OR snapshot_json = ''");
    if (!is_array($legacy_ids) || $legacy_ids === []) return true;
    foreach ($legacy_ids as $release_id) {
        if (!is_string($release_id) || $release_id === '') continue;
        $proofs = $wpdb->delete($proof_table, ['release_id' => $release_id], ['%s']);
        if ($proofs === false) return zeroy_runtime_error('zeroy_site_release_snapshot_history_cleanup_failed', $wpdb->last_error ?: 'Could not remove pre-checkout proofs.', 500, ['releaseId' => $release_id]);
        $deleted = $wpdb->delete($release_table, ['release_id' => $release_id], ['%s']);
        if ($deleted !== 1) return zeroy_runtime_error('zeroy_site_release_snapshot_history_cleanup_failed', $wpdb->last_error ?: 'Could not remove a pre-checkout release.', 500, ['releaseId' => $release_id]);
    }
    return true;
}
