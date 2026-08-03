<?php

defined('ABSPATH') || exit;

const ZEROY_CHECKOUT_QUERY_MAX_BYTES = 32768;

function zeroy_checkout_page_cursor(int $offset): string
{
    return rtrim(strtr(base64_encode(zeroy_runtime_json(['offset' => $offset])), '+/', '-_'), '=');
}

function zeroy_checkout_page_offset(?string $cursor): int|WP_Error
{
    if ($cursor === null || $cursor === '') return 0;
    $padding = (4 - strlen($cursor) % 4) % 4;
    $decoded = base64_decode(strtr($cursor, '-_', '+/') . str_repeat('=', $padding), true);
    $value = is_string($decoded) ? zeroy_runtime_decode_json($decoded) : null;
    return is_array($value) && is_int($value['offset'] ?? null) && $value['offset'] >= 0
        ? $value['offset']
        : zeroy_runtime_error('zeroy_query_cursor_invalid', 'Query cursor is invalid.', 400, ['fieldId' => 'cursor']);
}

function zeroy_checkout_bounded_projection(array $projection): array|WP_Error
{
    $bytes = strlen(zeroy_runtime_json($projection));
    return $bytes <= ZEROY_CHECKOUT_QUERY_MAX_BYTES
        ? $projection
        : zeroy_runtime_error('zeroy_query_projection_too_large', 'Query projection exceeds the public response byte budget. Request a smaller page.', 413, ['bytes' => $bytes, 'maxBytes' => ZEROY_CHECKOUT_QUERY_MAX_BYTES]);
}

function zeroy_checkout_page(array $items, int $limit, ?string $cursor, array $base): array|WP_Error
{
    $offset = zeroy_checkout_page_offset($cursor);
    if (is_wp_error($offset)) return $offset;
    $limit = min(50, max(1, $limit));
    $page = array_slice(array_values($items), $offset, $limit);
    $has_more = $offset + count($page) < count($items);
    return zeroy_checkout_bounded_projection([
        ...$base,
        'items' => $page,
        'nextCursor' => $has_more ? zeroy_checkout_page_cursor($offset + count($page)) : null,
        'hasMore' => $has_more,
    ]);
}

function zeroy_checkout_commit_history(?string $start_hash, int $limit, ?string $cursor): array|WP_Error
{
    if ($start_hash === null || $start_hash === '') {
        $active = zeroy_runtime_active_site_release();
        $start_hash = is_array($active) && is_string($active['commit_hash'] ?? null) ? $active['commit_hash'] : null;
    }
    if ($start_hash === null) return zeroy_checkout_page([], $limit, $cursor, ['contract' => 'zeroy/site-commit-history@1', 'startCommit' => null]);
    $items = [];
    $seen = [];
    $hash = $start_hash;
    while ($hash !== null) {
        if (isset($seen[$hash])) return zeroy_runtime_error('zeroy_site_commit_cycle', 'SiteCommit parent graph contains a cycle.', 500, ['commit' => $hash]);
        $seen[$hash] = true;
        $row = zeroy_checkout_commit_row($hash);
        if ($row === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit history references a missing commit.', 500, ['commit' => $hash]);
        $items[] = [
            'commit' => $hash,
            'parent' => $row['parent_hash'] ?: null,
            'tree' => $row['tree_hash'],
            'baseReleaseId' => $row['base_release_id'] ?: null,
            'authorPrincipal' => $row['author_principal'],
            'message' => $row['message'],
            'createdAt' => $row['created_at'],
        ];
        $hash = is_string($row['parent_hash'] ?? null) && $row['parent_hash'] !== '' ? $row['parent_hash'] : null;
        if (count($items) > 10000) return zeroy_runtime_error('zeroy_site_commit_history_too_deep', 'SiteCommit history exceeds the traversal limit.', 409);
    }
    return zeroy_checkout_page($items, $limit, $cursor, ['contract' => 'zeroy/site-commit-history@1', 'startCommit' => $start_hash]);
}

function zeroy_checkout_commit_diff(string $base_hash, string $commit_hash, int $limit, ?string $cursor): array|WP_Error
{
    $base = zeroy_checkout_commit_row($base_hash);
    $commit = zeroy_checkout_commit_row($commit_hash);
    if ($base === null || $commit === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'Commit diff requires two existing SiteCommits.', 404);
    $before = zeroy_checkout_flatten_tree((string) $base['tree_hash']);
    $after = zeroy_checkout_flatten_tree((string) $commit['tree_hash']);
    if (is_wp_error($before) || is_wp_error($after)) return is_wp_error($before) ? $before : $after;
    $paths = array_values(array_unique([...array_keys($before), ...array_keys($after)]));
    sort($paths, SORT_STRING);
    $items = [];
    foreach ($paths as $path) {
        $old = $before[$path] ?? null;
        $new = $after[$path] ?? null;
        if ($old === $new) continue;
        $items[] = [
            'path' => $path,
            'state' => $old === null ? 'added' : ($new === null ? 'deleted' : 'modified'),
            'baseHash' => $old['hash'] ?? null,
            'commitHash' => $new['hash'] ?? null,
        ];
    }
    return zeroy_checkout_page($items, $limit, $cursor, ['contract' => 'zeroy/site-commit-diff@1', 'base' => $base_hash, 'commit' => $commit_hash, 'changedPathCount' => count($items)]);
}
