<?php

defined('ABSPATH') || exit;

function zeroy_site_release_upgrade_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

/**
 * Simulate the exact prior SiteRelease row shape after a current release has
 * been produced. The test must run only on a disposable site: it drops the
 * release history deliberately to prove that the hard-cut importer does not
 * need an old request-time reader.
 */
$source = zeroy_runtime_active_site_release();
zeroy_site_release_upgrade_assert(is_array($source), 'Upgrade acceptance needs a baseline active SiteRelease.');
zeroy_site_release_upgrade_assert(!is_wp_error(zeroy_runtime_site_release_snapshot($source)), 'Baseline active SiteRelease has no valid DraftSnapshot.');

global $wpdb;
$release_table = zeroy_runtime_table('site_releases');
$proof_table = zeroy_runtime_table('verification_proofs');
$source_release_id = (string) $source['active_release_id'];
$dropped = $wpdb->query("DROP TABLE {$release_table}");
zeroy_site_release_upgrade_assert($dropped !== false, 'Could not replace the SiteRelease table with its prior hard-cut shape.');
$created = $wpdb->query(
    "CREATE TABLE {$release_table} (
        release_id CHAR(36) NOT NULL,
        theme_artifact_id VARCHAR(71) NOT NULL,
        site_logic_artifact_id VARCHAR(71) NOT NULL,
        theme_contract_hash CHAR(64) NOT NULL,
        site_logic_contract_hash CHAR(64) NOT NULL,
        storage_epoch BIGINT UNSIGNED NOT NULL,
        expected_active_release_id CHAR(36) NULL,
        state VARCHAR(16) NOT NULL,
        proof_id VARCHAR(64) NULL,
        provenance_json LONGTEXT NOT NULL,
        diagnostics_json LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        activated_at DATETIME NULL,
        PRIMARY KEY (release_id)
    )",
);
zeroy_site_release_upgrade_assert($created !== false, 'Could not create the prior SiteRelease table shape.');
$legacy_written = $wpdb->insert(
    $release_table,
    [
        'release_id' => $source_release_id,
        'theme_artifact_id' => $source['theme_artifact_id'],
        'site_logic_artifact_id' => $source['site_logic_artifact_id'],
        'theme_contract_hash' => $source['theme_contract_hash'],
        'site_logic_contract_hash' => $source['site_logic_contract_hash'],
        'storage_epoch' => $source['storage_epoch'],
        'expected_active_release_id' => $source['expected_active_release_id'],
        'state' => 'active',
        'proof_id' => $source['proof_id'],
        'provenance_json' => $source['provenance_json'],
        'diagnostics_json' => $source['diagnostics_json'],
        'created_at' => $source['created_at'],
        'activated_at' => $source['activated_at'],
    ],
);
zeroy_site_release_upgrade_assert($legacy_written === 1, 'Could not seed the prior active SiteRelease row.');
update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, '5.1.0', false);

update_option('zeroy_site_release_hard_cut_upgrade_acceptance_seed', ['fromReleaseId' => $source_release_id], false);
WP_CLI::log(wp_json_encode(['ok' => true, 'seededFromReleaseId' => $source_release_id]));
