<?php

defined('ABSPATH') || exit;

function zeroy_site_release_upgrade_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$seed = get_option('zeroy_site_release_hard_cut_upgrade_acceptance_seed', null);
zeroy_site_release_upgrade_assert(is_array($seed) && is_string($seed['fromReleaseId'] ?? null), 'Upgrade assertion has no seeded pre-SiteDraft release.');
$source_release_id = $seed['fromReleaseId'];
global $wpdb;
$release_table = zeroy_runtime_table('site_releases');
$proof_table = zeroy_runtime_table('verification_proofs');
$active = zeroy_runtime_active_site_release();
zeroy_site_release_upgrade_assert(is_array($active) && $active['active_release_id'] !== $source_release_id, 'Hard-cut migration did not activate a replacement SiteRelease.');
$snapshot = is_array($active) ? zeroy_runtime_site_release_snapshot($active) : null;
zeroy_site_release_upgrade_assert(is_array($snapshot), 'Hard-cut migration activated a release without a valid DraftSnapshot.');
$receipt = zeroy_runtime_site_release_receipt((string) $active['active_release_id']);
$provenance = is_array($receipt) && is_array($receipt['provenance'] ?? null) ? $receipt['provenance'] : [];
zeroy_site_release_upgrade_assert(
    !is_wp_error($receipt)
    && ($receipt['draftId'] ?? null) === null
    && ($provenance['source'] ?? null) === 'hard-cut-snapshot-migration'
    && ($provenance['fromReleaseId'] ?? null) === $source_release_id,
    'Hard-cut migration did not retain a compact source provenance on the replacement release.',
);
$legacy_row = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$release_table} WHERE release_id = %s", $source_release_id));
$legacy_proofs = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$proof_table} WHERE release_id = %s", $source_release_id));
zeroy_site_release_upgrade_assert((int) $legacy_row === 0 && (int) $legacy_proofs === 0, 'Pre-SiteDraft release rows or proofs remained readable after the hard cut.');
zeroy_site_release_upgrade_assert(zeroy_runtime_schema_is_current(), 'Schema currentness did not include the snapshot-bearing SiteRelease invariant.');
delete_option('zeroy_site_release_hard_cut_upgrade_acceptance_seed');

WP_CLI::log(wp_json_encode([
    'ok' => true,
    'fromReleaseId' => $source_release_id,
    'activeReleaseId' => $active['active_release_id'],
    'snapshotHash' => $active['snapshot_hash'],
]));
