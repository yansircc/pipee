<?php

defined('ABSPATH') || exit;

function zeroy_checkout_owner_principal(): string
{
    return 'site:' . zeroy_runtime_site_id();
}

function zeroy_checkout_object_row(string $hash): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_objects') . ' WHERE object_hash = %s', $hash), ARRAY_A);
    if (!is_array($row)) return null;
    $stored = $row['object_bytes'] ?? null;
    if (!is_string($stored) || !str_starts_with($stored, 'zeroy-b64-v1:')) return null;
    $decoded = base64_decode(substr($stored, strlen('zeroy-b64-v1:')), true);
    if (!is_string($decoded) || strlen($decoded) !== (int) $row['byte_count']) return null;
    $row['object_bytes'] = $decoded;
    return $row;
}

function zeroy_checkout_object_hash(string $type, string $bytes): string|WP_Error
{
    if ($type === 'blob') return zeroy_checkout_blob_hash($bytes);
    if ($type !== 'tree') return zeroy_runtime_error('zeroy_site_object_type_invalid', 'SiteObject type must be blob or tree.', 400);
    $decoded = zeroy_runtime_decode_json($bytes);
    if (is_wp_error($decoded)) return zeroy_runtime_error('zeroy_tree_invalid', 'Tree bytes must be canonical JSON.', 400);
    $canonical = zeroy_checkout_tree_bytes($decoded);
    if (is_wp_error($canonical) || !hash_equals($canonical, $bytes)) return zeroy_runtime_error('zeroy_tree_not_canonical', 'Tree bytes are not canonical.', 400);
    return zeroy_checkout_hash_bytes('tree', $bytes);
}

function zeroy_checkout_store_object(string $type, string $claimed_hash, string $bytes): array|WP_Error
{
    $actual = zeroy_checkout_object_hash($type, $bytes);
    if (is_wp_error($actual)) return $actual;
    if (!hash_equals($claimed_hash, $actual)) return zeroy_runtime_error('zeroy_site_object_hash_mismatch', 'Uploaded object bytes do not match the claimed hash.', 409, ['claimedHash' => $claimed_hash, 'actualHash' => $actual]);
    $existing = zeroy_checkout_object_row($actual);
    if ($existing !== null) {
        if ((string) $existing['object_type'] !== $type || (int) $existing['byte_count'] !== strlen($bytes) || !hash_equals((string) $existing['object_bytes'], $bytes)) {
            return zeroy_runtime_error('zeroy_site_object_collision', 'Stored object identity resolves to different bytes.', 500, ['objectHash' => $actual]);
        }
        return ['objectHash' => $actual, 'created' => false, 'byteCount' => strlen($bytes)];
    }
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_table('site_objects'), [
        'object_hash' => $actual,
        'object_type' => $type,
        'byte_count' => strlen($bytes),
        'object_bytes' => 'zeroy-b64-v1:' . base64_encode($bytes),
        'created_at' => current_time('mysql', true),
    ], ['%s', '%s', '%d', '%s', '%s']);
    return $written === 1
        ? ['objectHash' => $actual, 'created' => true, 'byteCount' => strlen($bytes)]
        : zeroy_runtime_error('zeroy_site_object_store_failed', $wpdb->last_error ?: 'Could not store SiteObject.', 500);
}

function zeroy_checkout_missing_objects(array $hashes): array|WP_Error
{
    global $wpdb;
    $normalized = [];
    foreach ($hashes as $hash) {
        if (!is_string($hash) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $hash) !== 1) return zeroy_runtime_error('zeroy_site_object_hash_invalid', 'Object hash list contains an invalid hash.', 400);
        $normalized[$hash] = true;
    }
    if ($normalized === []) return [];
    $values = array_keys($normalized);
    $placeholders = implode(',', array_fill(0, count($values), '%s'));
    $present = $wpdb->get_col($wpdb->prepare('SELECT object_hash FROM ' . zeroy_runtime_table('site_objects') . " WHERE object_hash IN ({$placeholders})", ...$values));
    if (!is_array($present)) return zeroy_runtime_error('zeroy_site_object_query_failed', $wpdb->last_error ?: 'Could not query SiteObjects.', 500);
    return array_values(array_diff($values, array_map('strval', $present)));
}

function zeroy_checkout_tree_entries(string $tree_hash): array|WP_Error
{
    $row = zeroy_checkout_object_row($tree_hash);
    if ($row === null || (string) $row['object_type'] !== 'tree') return zeroy_runtime_error('zeroy_tree_missing', 'SiteTree object does not exist.', 409, ['treeHash' => $tree_hash]);
    $decoded = zeroy_runtime_decode_json((string) $row['object_bytes']);
    if (is_wp_error($decoded)) return zeroy_runtime_error('zeroy_tree_corrupt', 'Stored SiteTree is not valid JSON.', 500, ['treeHash' => $tree_hash]);
    $entries = zeroy_checkout_normalize_tree_entries($decoded);
    if (is_wp_error($entries) || !hash_equals($tree_hash, zeroy_checkout_hash_bytes('tree', zeroy_checkout_canonical_json($entries)))) return zeroy_runtime_error('zeroy_tree_corrupt', 'Stored SiteTree identity is invalid.', 500, ['treeHash' => $tree_hash]);
    return $entries;
}

function zeroy_checkout_verify_tree_reachable(string $tree_hash, array &$visited = []): true|WP_Error
{
    if (isset($visited[$tree_hash])) return true;
    $visited[$tree_hash] = true;
    $entries = zeroy_checkout_tree_entries($tree_hash);
    if (is_wp_error($entries)) return $entries;
    foreach ($entries as $entry) {
        $row = zeroy_checkout_object_row($entry['hash']);
        if ($row === null || (string) $row['object_type'] !== $entry['kind']) return zeroy_runtime_error('zeroy_tree_object_missing', 'SiteTree references a missing or wrong-type object.', 409, ['treeHash' => $tree_hash, 'name' => $entry['name'], 'objectHash' => $entry['hash']]);
        $actual = zeroy_checkout_object_hash((string) $row['object_type'], (string) $row['object_bytes']);
        if (is_wp_error($actual) || !hash_equals($entry['hash'], $actual)) return zeroy_runtime_error('zeroy_site_object_corrupt', 'SiteTree references corrupt object bytes.', 500, ['objectHash' => $entry['hash']]);
        if ($entry['kind'] === 'tree') {
            $nested = zeroy_checkout_verify_tree_reachable($entry['hash'], $visited);
            if (is_wp_error($nested)) return $nested;
        }
    }
    return true;
}

function zeroy_checkout_commit_row(string $hash): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_commits') . ' WHERE commit_hash = %s', $hash), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_checkout_store_commit(array $commit, string $claimed_hash): array|WP_Error
{
    $actual = zeroy_checkout_commit_hash($commit);
    if (is_wp_error($actual)) return $actual;
    if (!hash_equals($claimed_hash, $actual)) return zeroy_runtime_error('zeroy_site_commit_hash_mismatch', 'SiteCommit does not match its claimed hash.', 409, ['claimedHash' => $claimed_hash, 'actualHash' => $actual]);
    $reachable = zeroy_checkout_verify_tree_reachable((string) $commit['tree']);
    if (is_wp_error($reachable)) return $reachable;
    $parent = $commit['parents'][0] ?? null;
    if ($parent !== null && zeroy_checkout_commit_row($parent) === null) return zeroy_runtime_error('zeroy_site_commit_parent_missing', 'SiteCommit parent does not exist.', 409, ['parent' => $parent]);
    $existing = zeroy_checkout_commit_row($actual);
    $canonical = zeroy_checkout_canonical_json($commit);
    if ($existing !== null) {
        return hash_equals((string) $existing['commit_json'], $canonical)
            ? ['commit' => $actual, 'created' => false]
            : zeroy_runtime_error('zeroy_site_commit_collision', 'Stored SiteCommit identity resolves to different bytes.', 500, ['commit' => $actual]);
    }
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_table('site_commits'), [
        'commit_hash' => $actual,
        'tree_hash' => $commit['tree'],
        'parent_hash' => $parent,
        'base_release_id' => $commit['baseReleaseId'],
        'author_principal' => $commit['author']['principal'],
        'actor_session_id' => $commit['author']['actorSessionId'],
        'message' => $commit['message'],
        'commit_json' => $canonical,
        'created_at' => gmdate('Y-m-d H:i:s', strtotime($commit['createdAt'])),
    ], ['%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s']);
    return $written === 1 ? ['commit' => $actual, 'created' => true] : zeroy_runtime_error('zeroy_site_commit_store_failed', $wpdb->last_error ?: 'Could not store SiteCommit.', 500);
}

function zeroy_checkout_ref_row(string $ref_name): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_refs') . ' WHERE ref_name = %s', $ref_name), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_checkout_ref_name_valid(string $name): bool
{
    return preg_match('#\Arefs/drafts/[a-zA-Z0-9._@-]+/[a-zA-Z0-9-]+\z#', $name) === 1;
}

function zeroy_checkout_update_ref_locked(string $ref_name, ?string $expected_commit, string $next_commit): array|WP_Error
{
    if (!zeroy_checkout_ref_name_valid($ref_name)) return zeroy_runtime_error('zeroy_site_ref_invalid', 'DraftRef name is invalid.', 400);
    if (zeroy_checkout_commit_row($next_commit) === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'DraftRef target commit does not exist.', 409, ['commit' => $next_commit]);
    global $wpdb;
    $query = 'SELECT * FROM ' . zeroy_runtime_table('site_refs') . ' WHERE ref_name = %s';
    if (!zeroy_runtime_uses_sqlite()) $query .= ' FOR UPDATE';
    $current = $wpdb->get_row($wpdb->prepare($query, $ref_name), ARRAY_A);
    $actual = is_array($current) ? (string) $current['commit_hash'] : null;
    if ($actual !== $expected_commit) {
        $changed_paths = [];
        $changed_count = 0;
        if ($expected_commit !== null && $actual !== null) {
            $diff = zeroy_checkout_commit_diff($expected_commit, $actual, 50, null);
            if (!is_wp_error($diff)) {
                $changed_count = (int) ($diff['changedPathCount'] ?? 0);
                $changed_paths = array_values(array_filter(array_map(static fn(mixed $item): mixed => is_array($item) ? ($item['path'] ?? null) : null, $diff['items'] ?? []), 'is_string'));
            }
        } elseif ($actual !== null) {
            $current = zeroy_checkout_commit_row($actual);
            $files = is_array($current) ? zeroy_checkout_flatten_tree((string) $current['tree_hash']) : [];
            if (is_array($files)) {
                $changed_count = count($files);
                $changed_paths = array_slice(array_keys($files), 0, 50);
            }
        }
        return zeroy_runtime_error('zeroy_remote_ref_changed', 'DraftRef changed after checkout.', 409, ['expectedCommit' => $expected_commit, 'currentCommit' => $actual, 'changedPathCount' => $changed_count, 'changedPaths' => $changed_paths, 'next' => 'refresh checkout and resolve locally']);
    }
    if ($actual === $next_commit) return ['refName' => $ref_name, 'commit' => $next_commit, 'revision' => (int) ($current['revision'] ?? 0), 'state' => 'unchanged'];
    $revision = (int) ($current['revision'] ?? 0) + 1;
    $written = is_array($current)
        ? $wpdb->update(zeroy_runtime_table('site_refs'), ['commit_hash' => $next_commit, 'revision' => $revision, 'updated_at' => current_time('mysql', true)], ['ref_name' => $ref_name, 'commit_hash' => $actual], ['%s', '%d', '%s'], ['%s', '%s'])
        : $wpdb->insert(zeroy_runtime_table('site_refs'), ['ref_name' => $ref_name, 'commit_hash' => $next_commit, 'revision' => $revision, 'updated_at' => current_time('mysql', true)], ['%s', '%s', '%d', '%s']);
    return $written === 1
        ? ['refName' => $ref_name, 'commit' => $next_commit, 'revision' => $revision, 'state' => 'updated']
        : zeroy_runtime_error('zeroy_remote_ref_changed', 'DraftRef changed concurrently.', 409, ['expectedCommit' => $expected_commit, 'currentCommit' => zeroy_checkout_ref_row($ref_name)['commit_hash'] ?? null]);
}

function zeroy_checkout_push_receipt(string $command_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('push_receipts') . ' WHERE command_id = %s', $command_id), ARRAY_A);
    if (!is_array($row)) return null;
    $decoded = zeroy_runtime_decode_json((string) $row['result_json']);
    return is_wp_error($decoded) ? null : ['requestHash' => (string) $row['request_hash'], 'result' => $decoded];
}

function zeroy_checkout_record_push_receipt(string $command_id, string $request_hash, array $result): true|WP_Error
{
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_table('push_receipts'), ['command_id' => $command_id, 'request_hash' => $request_hash, 'result_json' => zeroy_checkout_canonical_json($result), 'created_at' => current_time('mysql', true)], ['%s', '%s', '%s', '%s']);
    return $written === 1 ? true : zeroy_runtime_error('zeroy_push_receipt_store_failed', $wpdb->last_error ?: 'Could not store push receipt.', 500);
}

function zeroy_checkout_replace_push_receipt(string $command_id, string $request_hash, array $result): true|WP_Error
{
    global $wpdb;
    $written = $wpdb->update(zeroy_runtime_table('push_receipts'), ['result_json' => zeroy_checkout_canonical_json($result)], ['command_id' => $command_id, 'request_hash' => $request_hash], ['%s'], ['%s', '%s']);
    return $written === 1 ? true : zeroy_runtime_error('zeroy_push_receipt_update_failed', $wpdb->last_error ?: 'Could not finalize push receipt.', 409);
}
