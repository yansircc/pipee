<?php

defined('ABSPATH') || exit;

function zeroy_checkout_mark_tree_reachable(string $tree_hash, array &$objects, array &$issues): void
{
    if (isset($objects[$tree_hash])) return;
    $row = zeroy_checkout_object_row($tree_hash);
    if ($row === null || (string) $row['object_type'] !== 'tree') {
        $issues[] = ['code' => 'site_tree_missing', 'tree' => $tree_hash];
        return;
    }
    $objects[$tree_hash] = true;
    $entries = zeroy_checkout_tree_entries($tree_hash);
    if (is_wp_error($entries)) {
        $issues[] = ['code' => $entries->get_error_code(), 'tree' => $tree_hash];
        return;
    }
    foreach ($entries as $entry) {
        if ($entry['kind'] === 'tree') zeroy_checkout_mark_tree_reachable($entry['hash'], $objects, $issues);
        else {
            $blob = zeroy_checkout_object_row($entry['hash']);
            if ($blob === null || (string) $blob['object_type'] !== 'blob') $issues[] = ['code' => 'site_blob_missing', 'object' => $entry['hash'], 'tree' => $tree_hash];
            else $objects[$entry['hash']] = true;
        }
    }
}

function zeroy_checkout_reachability(): array
{
    global $wpdb;
    $roots = [];
    $build_roots = [];
    foreach ($wpdb->get_col('SELECT commit_hash FROM ' . zeroy_runtime_table('site_refs')) ?: [] as $hash) if (is_string($hash) && $hash !== '') $roots[$hash] = true;
    foreach ($wpdb->get_col('SELECT commit_hash FROM ' . zeroy_runtime_table('site_releases') . ' WHERE commit_hash IS NOT NULL') ?: [] as $hash) if (is_string($hash) && $hash !== '') $roots[$hash] = true;
    foreach ($wpdb->get_col('SELECT commit_hash FROM ' . zeroy_runtime_table('verification_proofs') . ' WHERE commit_hash IS NOT NULL') ?: [] as $hash) if (is_string($hash) && $hash !== '') $roots[$hash] = true;
    foreach ($wpdb->get_col('SELECT build_id FROM ' . zeroy_runtime_table('site_releases') . ' WHERE build_id IS NOT NULL') ?: [] as $id) if (is_string($id) && $id !== '') $build_roots[$id] = true;
    foreach ($wpdb->get_col('SELECT build_id FROM ' . zeroy_runtime_table('verification_proofs') . ' WHERE build_id IS NOT NULL') ?: [] as $id) if (is_string($id) && $id !== '') $build_roots[$id] = true;
    foreach ($wpdb->get_results('SELECT r.commit_hash, (SELECT b.build_id FROM ' . zeroy_runtime_table('site_builds') . ' b WHERE b.commit_hash = r.commit_hash ORDER BY b.created_at DESC LIMIT 1) AS build_id FROM ' . zeroy_runtime_table('site_refs') . ' r', ARRAY_A) ?: [] as $row) if (is_string($row['build_id'] ?? null)) $build_roots[$row['build_id']] = true;
    foreach (is_array(get_option('zeroy_checkout_pinned_commits', [])) ? get_option('zeroy_checkout_pinned_commits', []) : [] as $hash) if (is_string($hash) && preg_match('/\Asha256:[a-f0-9]{64}\z/', $hash) === 1) $roots[$hash] = true;
    $receipt_rows = $wpdb->get_col($wpdb->prepare('SELECT result_json FROM ' . zeroy_runtime_table('push_receipts') . ' WHERE created_at >= %s', gmdate('Y-m-d H:i:s', time() - 7 * DAY_IN_SECONDS)));
    foreach (is_array($receipt_rows) ? $receipt_rows : [] as $encoded) {
        $receipt = zeroy_runtime_decode_json((string) $encoded);
        if (is_array($receipt) && is_string($receipt['commit'] ?? null)) $roots[$receipt['commit']] = true;
        if (is_array($receipt) && is_string($receipt['build']['buildId'] ?? null)) $build_roots[$receipt['build']['buildId']] = true;
    }
    $commits = [];
    $objects = [];
    $issues = [];
    foreach (array_keys($roots) as $root) {
        $hash = $root;
        while ($hash !== null && !isset($commits[$hash])) {
            $row = zeroy_checkout_commit_row($hash);
            if ($row === null) {
                $issues[] = ['code' => 'site_commit_missing', 'commit' => $hash, 'root' => $root];
                break;
            }
            $commits[$hash] = true;
            zeroy_checkout_mark_tree_reachable((string) $row['tree_hash'], $objects, $issues);
            $hash = is_string($row['parent_hash'] ?? null) && $row['parent_hash'] !== '' ? $row['parent_hash'] : null;
        }
    }
    foreach ($wpdb->get_results('SELECT release_id, commit_hash, build_id, proof_id, state FROM ' . zeroy_runtime_table('site_releases'), ARRAY_A) ?: [] as $release) {
        if (!is_string($release['commit_hash'] ?? null) || zeroy_checkout_commit_row($release['commit_hash']) === null) $issues[] = ['code' => 'site_release_commit_missing', 'releaseId' => $release['release_id'], 'commit' => $release['commit_hash'] ?? null];
        $build = is_string($release['build_id'] ?? null) ? zeroy_build_row($release['build_id']) : null;
        if ($build === null || !hash_equals((string) ($build['commit_hash'] ?? ''), (string) ($release['commit_hash'] ?? ''))) $issues[] = ['code' => 'site_release_build_mismatch', 'releaseId' => $release['release_id'], 'buildId' => $release['build_id'] ?? null];
        if (is_string($release['proof_id'] ?? null) && $release['proof_id'] !== '') {
            $proof = zeroy_runtime_site_release_proof_row($release['proof_id']);
            if ($proof === null || !hash_equals((string) ($proof['commit_hash'] ?? ''), (string) ($release['commit_hash'] ?? '')) || !hash_equals((string) ($proof['build_id'] ?? ''), (string) ($release['build_id'] ?? ''))) $issues[] = ['code' => 'site_release_proof_commit_mismatch', 'releaseId' => $release['release_id'], 'proofId' => $release['proof_id']];
            elseif (in_array($release['state'], ['active', 'superseded'], true)) {
                $decoded = zeroy_runtime_decode_json((string) $proof['proof_json']);
                $row = zeroy_runtime_site_release_row((string) $release['release_id']);
                if (!is_array($decoded) || !is_array($row) || !zeroy_runtime_site_release_proof_valid($row, $decoded)) $issues[] = ['code' => 'site_release_proof_invalid', 'releaseId' => $release['release_id'], 'proofId' => $release['proof_id']];
            }
        } elseif (in_array($release['state'], ['active', 'superseded'], true)) {
            $issues[] = ['code' => 'site_release_proof_missing', 'releaseId' => $release['release_id']];
        }
    }
    return ['roots' => array_keys($roots), 'builds' => array_keys($build_roots), 'commits' => array_keys($commits), 'objects' => array_keys($objects), 'issues' => $issues];
}

function zeroy_checkout_gc(int $grace_seconds = 604800): array|WP_Error
{
    global $wpdb;
    $reachable = zeroy_checkout_reachability();
    if ($reachable['issues'] !== []) return zeroy_runtime_error('zeroy_checkout_gc_integrity_failed', 'Reachability GC refuses to run while canonical roots are invalid.', 409, ['issues' => $reachable['issues']]);
    $cutoff = gmdate('Y-m-d H:i:s', time() - max(DAY_IN_SECONDS, $grace_seconds));
    $commit_set = array_fill_keys($reachable['commits'], true);
    $object_set = array_fill_keys($reachable['objects'], true);
    $build_set = array_fill_keys($reachable['builds'], true);
    $deleted_commits = 0;
    foreach ($wpdb->get_results($wpdb->prepare('SELECT commit_hash FROM ' . zeroy_runtime_table('site_commits') . ' WHERE created_at < %s', $cutoff), ARRAY_A) ?: [] as $row) if (!isset($commit_set[$row['commit_hash']])) $deleted_commits += (int) $wpdb->delete(zeroy_runtime_table('site_commits'), ['commit_hash' => $row['commit_hash']], ['%s']);
    $deleted_objects = 0;
    foreach ($wpdb->get_results($wpdb->prepare('SELECT object_hash FROM ' . zeroy_runtime_table('site_objects') . ' WHERE created_at < %s', $cutoff), ARRAY_A) ?: [] as $row) if (!isset($object_set[$row['object_hash']])) $deleted_objects += (int) $wpdb->delete(zeroy_runtime_table('site_objects'), ['object_hash' => $row['object_hash']], ['%s']);
    $deleted_builds = 0;
    foreach ($wpdb->get_results($wpdb->prepare('SELECT build_id, diagnostics_hash, commit_hash FROM ' . zeroy_runtime_table('site_builds') . ' WHERE created_at < %s', $cutoff), ARRAY_A) ?: [] as $row) {
        if (isset($build_set[$row['build_id']])) continue;
        $deleted_builds += (int) $wpdb->delete(zeroy_runtime_table('site_builds'), ['build_id' => $row['build_id']], ['%s']);
        $used = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_builds') . ' WHERE diagnostics_hash = %s', $row['diagnostics_hash']));
        if ($used === 0) $wpdb->delete(zeroy_runtime_table('site_build_diagnostics'), ['diagnostics_hash' => $row['diagnostics_hash']], ['%s']);
    }
    $deleted_candidates = (int) $wpdb->query($wpdb->prepare('DELETE FROM ' . zeroy_runtime_table('site_build_candidates') . ' WHERE created_at < %s', $cutoff));
    return ['deletedCommits' => $deleted_commits, 'deletedObjects' => $deleted_objects, 'deletedBuilds' => $deleted_builds, 'deletedBuildCandidates' => max(0, $deleted_candidates), 'reachableCommits' => count($commit_set), 'reachableObjects' => count($object_set)];
}
