<?php

defined('ABSPATH') || exit;

function zeroy_runtime_prepare_site_release(string $theme_artifact_id, string $site_logic_artifact_id, ?string $expected_active_release_id, array $provenance): array|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if (($active['active_release_id'] ?? null) !== $expected_active_release_id) return zeroy_runtime_error('zeroy_active_site_release_changed', 'The active SiteRelease changed after checkout.', 409, ['activeReleaseId' => $active['active_release_id'] ?? null]);
    $theme_integrity = zeroy_runtime_artifact_integrity($theme_artifact_id);
    $logic_integrity = zeroy_runtime_site_logic_artifact_integrity($site_logic_artifact_id);
    if (is_wp_error($theme_integrity) || ($theme_integrity['ok'] ?? false) !== true || is_wp_error($logic_integrity) || ($logic_integrity['ok'] ?? false) !== true) return zeroy_runtime_error('zeroy_release_artifact_invalid', 'Both immutable artifacts must exist and be intact.', 409);
    $compiled = zeroy_runtime_compile_theme_contract($theme_artifact_id, $site_logic_artifact_id);
    if (is_wp_error($compiled)) return $compiled;
    $migration = zeroy_runtime_prepare_site_logic_migrations($compiled['siteLogicContract'], $active);
    if (is_wp_error($migration)) return $migration;
    global $wpdb;
    if ($wpdb->update(zeroy_runtime_table('theme_artifacts'), ['schema_json' => zeroy_runtime_json($compiled['schema']), 'schema_hash' => $compiled['schemaHash']], ['artifact_id' => $theme_artifact_id]) === false) {
        return zeroy_runtime_error('zeroy_theme_contract_store_failed', $wpdb->last_error ?: 'Could not store derived ThemeSchema contract.', 500);
    }
    $release_id = wp_generate_uuid4();
    $written = $wpdb->insert(zeroy_runtime_table('site_releases'), [
        'release_id' => $release_id,
        'theme_artifact_id' => $theme_artifact_id,
        'site_logic_artifact_id' => $site_logic_artifact_id,
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => $compiled['siteLogicContract']['storageEpoch'],
        'expected_active_release_id' => $expected_active_release_id,
        'state' => 'preparing',
        'proof_id' => null,
        'provenance_json' => zeroy_runtime_json($provenance),
        'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration]),
        'created_at' => current_time('mysql', true),
        'activated_at' => null,
    ]);
    if ($written !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', $wpdb->last_error ?: 'Could not create SiteRelease candidate.', 500);
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Candidate release disappeared.', 500);
    $proof = zeroy_runtime_verify_candidate_site_release($release, $compiled);
    if (is_wp_error($proof)) return $proof;
    $proof_id = zeroy_runtime_store_site_release_proof($release_id, $proof);
    if (is_wp_error($proof_id)) return $proof_id;
    $state = $proof['blockingFailures'] === [] ? 'prepared' : 'failed';
    if ($wpdb->update(zeroy_runtime_table('site_releases'), ['state' => $state, 'proof_id' => $proof_id, 'diagnostics_json' => zeroy_runtime_json(['themeContract' => $compiled['contract'], 'themeSchema' => $compiled['schema'], 'migration' => $migration, 'proof' => $proof])], ['release_id' => $release_id]) !== 1) return zeroy_runtime_error('zeroy_site_release_prepare_failed', 'Could not finalize candidate verification.', 500);
    return zeroy_runtime_site_release_receipt($release_id);
}
