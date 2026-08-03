<?php

defined('ABSPATH') || exit;

function zeroy_checkout_hash_bytes(string $domain, string $bytes): string
{
    return 'sha256:' . hash('sha256', $domain . "\0" . strlen($bytes) . "\0" . $bytes);
}

function zeroy_checkout_canonical_value(mixed $value): mixed
{
    if (!is_array($value)) {
        if (is_float($value) && !is_finite($value)) throw new InvalidArgumentException('Canonical JSON accepts only finite JSON values.');
        return $value;
    }
    if (array_is_list($value)) return array_map('zeroy_checkout_canonical_value', $value);
    uksort($value, static fn(string $left, string $right): int => strcmp($left, $right));
    foreach ($value as $key => $entry) $value[$key] = zeroy_checkout_canonical_value($entry);
    return $value;
}

function zeroy_checkout_canonical_json(mixed $value): string
{
    return wp_json_encode(zeroy_checkout_canonical_value($value), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
}

function zeroy_checkout_blob_hash(string $bytes): string
{
    return zeroy_checkout_hash_bytes('blob', $bytes);
}

function zeroy_checkout_segment_is_safe(string $segment): bool
{
    return $segment !== '' && $segment !== '.' && $segment !== '..' && !str_contains($segment, '/') && !str_contains($segment, '\\') && !str_contains($segment, "\0") && strlen($segment) <= 255;
}

function zeroy_checkout_path_is_safe(string $path): bool
{
    return $path !== '' && !str_starts_with($path, '/') && !str_ends_with($path, '/') && count(array_filter(explode('/', $path), static fn(string $segment): bool => !zeroy_checkout_segment_is_safe($segment))) === 0;
}

function zeroy_checkout_normalize_tree_entries(array $entries): array|WP_Error
{
    if (!array_is_list($entries)) return zeroy_runtime_error('zeroy_tree_invalid', 'Tree entries must be a list.', 400);
    $names = [];
    $normalized = [];
    foreach ($entries as $entry) {
        if (!is_array($entry) || !is_string($entry['name'] ?? null) || !zeroy_checkout_segment_is_safe($entry['name']) || isset($names[$entry['name']])) {
            return zeroy_runtime_error('zeroy_tree_invalid', 'Tree contains an unsafe or duplicate entry name.', 400);
        }
        if (!in_array($entry['kind'] ?? null, ['blob', 'tree'], true) || !in_array($entry['mode'] ?? null, ['file', 'executable'], true) || !is_string($entry['hash'] ?? null) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $entry['hash']) !== 1) {
            return zeroy_runtime_error('zeroy_tree_invalid', 'Tree entry has an invalid kind, mode, or hash.', 400, ['name' => $entry['name']]);
        }
        $names[$entry['name']] = true;
        $normalized[] = ['name' => $entry['name'], 'kind' => $entry['kind'], 'hash' => $entry['hash'], 'mode' => $entry['mode']];
    }
    usort($normalized, static fn(array $left, array $right): int => strcmp($left['name'], $right['name']));
    return $normalized;
}

function zeroy_checkout_tree_bytes(array $entries): string|WP_Error
{
    $normalized = zeroy_checkout_normalize_tree_entries($entries);
    return is_wp_error($normalized) ? $normalized : zeroy_checkout_canonical_json($normalized);
}

function zeroy_checkout_tree_hash(array $entries): string|WP_Error
{
    $bytes = zeroy_checkout_tree_bytes($entries);
    return is_wp_error($bytes) ? $bytes : zeroy_checkout_hash_bytes('tree', $bytes);
}

function zeroy_checkout_commit_bytes(array $commit): string|WP_Error
{
    $parents = $commit['parents'] ?? null;
    $commit_keys = array_keys($commit);
    $expected_commit_keys = ['contract', 'tree', 'parents', 'baseReleaseId', 'author', 'message', 'createdAt'];
    sort($commit_keys, SORT_STRING);
    sort($expected_commit_keys, SORT_STRING);
    if ($commit_keys !== $expected_commit_keys || ($commit['contract'] ?? null) !== 'zeroy/site-commit@1' || !is_string($commit['tree'] ?? null) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $commit['tree']) !== 1 || !is_array($parents) || !array_is_list($parents) || count($parents) > 1) {
        return zeroy_runtime_error('zeroy_site_commit_invalid', 'SiteCommit contract, tree, or parents are invalid.', 400);
    }
    foreach ($parents as $parent) if (!is_string($parent) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $parent) !== 1) return zeroy_runtime_error('zeroy_site_commit_invalid', 'SiteCommit parent hash is invalid.', 400);
    $author = $commit['author'] ?? null;
    $author_keys = is_array($author) ? array_keys($author) : [];
    sort($author_keys, SORT_STRING);
    if ((!is_null($commit['baseReleaseId']) && !is_string($commit['baseReleaseId'])) || !is_array($author) || $author_keys !== ['actorSessionId', 'principal'] || !is_string($author['principal'] ?? null) || $author['principal'] === '' || !is_string($author['actorSessionId'] ?? null) || $author['actorSessionId'] === '' || !is_string($commit['message'] ?? null) || !is_string($commit['createdAt'] ?? null) || strtotime($commit['createdAt']) === false) {
        return zeroy_runtime_error('zeroy_site_commit_invalid', 'SiteCommit metadata is invalid.', 400);
    }
    return zeroy_checkout_canonical_json($commit);
}

function zeroy_checkout_commit_hash(array $commit): string|WP_Error
{
    $bytes = zeroy_checkout_commit_bytes($commit);
    return is_wp_error($bytes) ? $bytes : zeroy_checkout_hash_bytes('commit', $bytes);
}

function zeroy_checkout_push_request_hash(array $request): string
{
    return substr(zeroy_checkout_hash_bytes('push-request', zeroy_checkout_canonical_json($request)), 7);
}
