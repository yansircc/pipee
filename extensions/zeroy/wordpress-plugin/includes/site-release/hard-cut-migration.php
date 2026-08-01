<?php

defined('ABSPATH') || exit;

/**
 * The SiteDraft hard cut changes the reader fact from artifact identifiers to
 * an immutable DraftSnapshot. This is the only transition writer for an
 * already-active pre-SiteDraft release. It never becomes a request-time
 * fallback: successful conversion activates a normal snapshot-backed release
 * and removes the unreadable historical rows.
 */
function zeroy_runtime_migrate_active_site_release_snapshot(): true|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if ($active === null) return true;

    $stored_snapshot = trim((string) ($active['snapshot_json'] ?? ''));
    if ($stored_snapshot !== '') {
        $snapshot = zeroy_runtime_site_release_snapshot($active);
        return is_wp_error($snapshot)
            ? zeroy_runtime_error(
                'zeroy_site_release_snapshot_corrupt',
                'The active SiteRelease has a snapshot payload but it is invalid; it cannot be rebuilt from mutable facts.',
                409,
                ['releaseId' => $active['active_release_id'] ?? null, 'cause' => $snapshot->get_error_code()],
            )
            : true;
    }

    $source_release_id = (string) ($active['active_release_id'] ?? '');
    $theme_artifact_id = (string) ($active['theme_artifact_id'] ?? '');
    $site_logic_artifact_id = (string) ($active['site_logic_artifact_id'] ?? '');
    if ($source_release_id === '' || $theme_artifact_id === '' || $site_logic_artifact_id === '') {
        return zeroy_runtime_error('zeroy_site_release_snapshot_migration_invalid', 'The active pre-SiteDraft release has no complete artifact identity.', 409);
    }

    // This converts an immutable release description into the first immutable
    // snapshot. It does not apply user content operations, therefore it does
    // not create a user SiteDraft or invent a Pi session owner.
    $prepared = zeroy_runtime_prepare_site_release(
        $theme_artifact_id,
        $site_logic_artifact_id,
        $source_release_id,
        [
            'source' => 'hard-cut-snapshot-migration',
            'fromReleaseId' => $source_release_id,
            'message' => 'Convert the active pre-SiteDraft release into one snapshot-backed SiteRelease.',
        ],
    );
    if (is_wp_error($prepared)) return $prepared;
    if (($prepared['state'] ?? null) !== 'prepared') {
        return zeroy_runtime_error(
            'zeroy_site_release_snapshot_migration_blocked',
            'The active pre-SiteDraft release cannot satisfy the current SiteRelease contract.',
            409,
            [
                'fromReleaseId' => $source_release_id,
                'releaseId' => $prepared['releaseId'] ?? null,
                'diagnostics' => $prepared['diagnostics'] ?? null,
            ],
        );
    }
    $activated = zeroy_runtime_activate_site_release((string) $prepared['releaseId']);
    if (is_wp_error($activated)) return $activated;
    if (($activated['state'] ?? null) !== 'active') {
        return zeroy_runtime_error('zeroy_site_release_snapshot_migration_failed', 'The snapshot-backed SiteRelease did not activate.', 500, ['releaseId' => $prepared['releaseId'] ?? null]);
    }
    return zeroy_runtime_delete_pre_snapshot_site_releases();
}

/**
 * A hard cut retains migrated site facts in the active snapshot and source
 * provenance, not as a second release schema in history. Leaving rows without
 * a snapshot would make the release-history API emit objects outside its own
 * contract and would recreate a legacy-reader pressure path.
 */
function zeroy_runtime_delete_pre_snapshot_site_releases(): true|WP_Error
{
    global $wpdb;
    $release_table = zeroy_runtime_table('site_releases');
    $proof_table = zeroy_runtime_table('verification_proofs');
    $legacy_ids = $wpdb->get_col("SELECT release_id FROM {$release_table} WHERE snapshot_json IS NULL OR snapshot_json = ''");
    if (!is_array($legacy_ids) || $legacy_ids === []) return true;
    foreach ($legacy_ids as $release_id) {
        if (!is_string($release_id) || $release_id === '') continue;
        $proofs = $wpdb->delete($proof_table, ['release_id' => $release_id], ['%s']);
        if ($proofs === false) return zeroy_runtime_error('zeroy_site_release_snapshot_history_cleanup_failed', $wpdb->last_error ?: 'Could not remove pre-SiteDraft proofs.', 500, ['releaseId' => $release_id]);
        $deleted = $wpdb->delete($release_table, ['release_id' => $release_id], ['%s']);
        if ($deleted !== 1) return zeroy_runtime_error('zeroy_site_release_snapshot_history_cleanup_failed', $wpdb->last_error ?: 'Could not remove a pre-SiteDraft release.', 500, ['releaseId' => $release_id]);
    }
    return true;
}
