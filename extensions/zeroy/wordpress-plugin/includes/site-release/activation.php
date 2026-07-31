<?php

defined('ABSPATH') || exit;

function zeroy_runtime_activate_site_release(string $release_id): array|WP_Error
{
    $result = zeroy_runtime_transaction(function () use ($release_id) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_site_release_lease();
        if (is_wp_error($lease)) return $lease;
        $release = zeroy_runtime_site_release_row($release_id);
        if ($release === null || $release['state'] !== 'prepared' || $release['proof_id'] === null) return zeroy_runtime_error('zeroy_site_release_not_prepared', 'SiteRelease must be prepared with a matching VerificationProof.', 409);
        $active = zeroy_runtime_active_site_release();
        if (($active['active_release_id'] ?? null) !== ($release['expected_active_release_id'] ?: null)) return zeroy_runtime_error('zeroy_active_site_release_changed', 'The active SiteRelease changed after verification.', 409, ['activeReleaseId' => $active['active_release_id'] ?? null]);
        $proof_row = zeroy_runtime_site_release_proof_row((string) $release['proof_id']);
        $proof = $proof_row === null ? null : zeroy_runtime_decode_json((string) $proof_row['proof_json']);
        if (!is_array($proof) || !zeroy_runtime_site_release_proof_valid($release, $proof)) return zeroy_runtime_error('zeroy_site_release_proof_stale', 'VerificationProof does not exactly bind this SiteRelease candidate.', 409);
        $fault = apply_filters('zeroy_runtime_site_release_fault', null, 'activation.before-active-pointer');
        if (is_wp_error($fault)) return $fault;
        $now = current_time('mysql', true);
        if ($active !== null && $wpdb->update(zeroy_runtime_table('site_releases'), ['state' => 'superseded'], ['release_id' => $active['active_release_id'], 'state' => 'active']) === false) return zeroy_runtime_error('zeroy_site_release_activate_failed', $wpdb->last_error ?: 'Could not supersede active SiteRelease.', 500);
        if ($wpdb->update(zeroy_runtime_table('site_releases'), ['state' => 'active', 'activated_at' => $now], ['release_id' => $release_id, 'state' => 'prepared']) !== 1) return zeroy_runtime_error('zeroy_site_release_activate_failed', 'Could not activate prepared SiteRelease.', 409);
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
