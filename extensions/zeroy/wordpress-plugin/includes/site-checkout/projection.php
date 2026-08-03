<?php

defined('ABSPATH') || exit;

function zeroy_checkout_json_bytes(mixed $value): string
{
    return zeroy_checkout_canonical_json($value) . "\n";
}

function zeroy_checkout_release_files(array $release): array|WP_Error
{
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    if (is_wp_error($snapshot)) return $snapshot;
    $files = [];
    foreach ([
        'artifacts/theme' => zeroy_runtime_artifact_directory((string) $release['theme_artifact_id']),
        'artifacts/site-logic' => zeroy_runtime_site_logic_directory((string) $release['site_logic_artifact_id']),
    ] as $prefix => $directory) {
        if (!is_dir($directory) || is_link($directory)) return zeroy_runtime_error('zeroy_checkout_artifact_missing', 'Active SiteRelease artifact tree is unavailable.', 409, ['path' => $prefix]);
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $file) {
            if (!$file instanceof SplFileInfo || !$file->isFile() || $file->isLink()) return zeroy_runtime_error('zeroy_checkout_artifact_invalid', 'Active SiteRelease artifact contains an unsupported entry.', 409, ['path' => $prefix]);
            $absolute = wp_normalize_path($file->getPathname());
            $relative = ltrim(substr($absolute, strlen(rtrim(wp_normalize_path($directory), '/'))), '/');
            $path = $prefix . '/' . $relative;
            if (!zeroy_checkout_path_is_safe($path)) return zeroy_runtime_error('zeroy_checkout_path_invalid', 'Active SiteRelease contains an unsafe checkout path.', 409, ['path' => $path]);
            $bytes = file_get_contents($absolute);
            if (!is_string($bytes)) return zeroy_runtime_error('zeroy_checkout_artifact_unreadable', 'Could not read active SiteRelease artifact.', 500, ['path' => $path]);
            $files[$path] = ['bytes' => $bytes, 'mode' => $file->isExecutable() ? 'executable' : 'file'];
        }
    }
    $files['site.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'contract' => 'zeroy/site@1',
        'config' => array_diff_key(is_array($snapshot['siteConfig'] ?? null) ? $snapshot['siteConfig'] : [], ['revision' => true, 'siteCopy' => true]),
    ]), 'mode' => 'file'];
    foreach (is_array($snapshot['entities'] ?? null) ? $snapshot['entities'] : [] as $identity => $entity) {
        if (!is_array($entity)) continue;
        $ref = preg_replace('/[^a-zA-Z0-9._-]+/', '-', (string) $identity);
        $document = [
            'contract' => 'zeroy/post@1',
            'ref' => $ref,
            'sourceObjectId' => $entity['objectId'] ?? null,
            'postType' => $entity['postType'] ?? null,
            'schemaId' => $entity['schemaId'] ?? null,
            'routeKind' => $entity['routeKind'] ?? null,
            'route' => $entity['route'] ?? null,
            'canonical' => $entity['localizable']['view'] ?? [],
            'terms' => $entity['terms'] ?? [],
        ];
        $files["content/posts/{$ref}.json"] = ['bytes' => zeroy_checkout_json_bytes($document), 'mode' => 'file'];
        foreach (is_array($entity['locales'] ?? null) ? $entity['locales'] : [] as $locale => $state) {
            if ($locale === ($snapshot['siteConfig']['defaultLocale'] ?? null) || !is_array($state) || ($state['available'] ?? false) !== true) continue;
            $files["translations/{$locale}/posts/{$ref}.json"] = ['bytes' => zeroy_checkout_json_bytes([
                'contract' => 'zeroy/post-translation@1',
                'ref' => $ref,
                'locale' => $locale,
                'overlay' => $state['publishedOverlay'] ?? null,
            ]), 'mode' => 'file'];
        }
    }
    foreach (is_array($snapshot['terms'] ?? null) ? $snapshot['terms'] : [] as $identity => $term) {
        if (!is_array($term)) continue;
        $ref = preg_replace('/[^a-zA-Z0-9._-]+/', '-', (string) $identity);
        $files["content/terms/{$ref}.json"] = ['bytes' => zeroy_checkout_json_bytes([
            'contract' => 'zeroy/term@1',
            'ref' => $ref,
            'sourceObjectId' => $term['subject']['id'] ?? null,
            'taxonomy' => $term['taxonomy'] ?? null,
            'slug' => $term['slug'] ?? null,
            'canonical' => $term['localizable']['view'] ?? [],
        ]), 'mode' => 'file'];
        foreach (is_array($term['locales'] ?? null) ? $term['locales'] : [] as $locale => $state) {
            if ($locale === ($snapshot['siteConfig']['defaultLocale'] ?? null) || !is_array($state) || ($state['available'] ?? false) !== true) continue;
            $files["translations/{$locale}/terms/{$ref}.json"] = ['bytes' => zeroy_checkout_json_bytes([
                'contract' => 'zeroy/term-translation@1',
                'ref' => $ref,
                'locale' => $locale,
                'overlay' => $state['publishedOverlay'] ?? null,
            ]), 'mode' => 'file'];
        }
    }
    $site_copy = $snapshot['siteCopy'] ?? null;
    if (is_array($site_copy)) {
        $files['content/site-copy.json'] = ['bytes' => zeroy_checkout_json_bytes(['contract' => 'zeroy/site-copy@1', 'canonical' => $site_copy['localizable']['view']['siteCopy'] ?? []]), 'mode' => 'file'];
        foreach (is_array($site_copy['locales'] ?? null) ? $site_copy['locales'] : [] as $locale => $state) {
            if ($locale === ($snapshot['siteConfig']['defaultLocale'] ?? null) || !is_array($state) || ($state['available'] ?? false) !== true) continue;
            $files["translations/{$locale}/site-copy.json"] = ['bytes' => zeroy_checkout_json_bytes(['contract' => 'zeroy/site-copy-translation@1', 'locale' => $locale, 'overlay' => $state['publishedOverlay'] ?? null]), 'mode' => 'file'];
        }
    }
    ksort($files, SORT_STRING);
    return $files;
}

function zeroy_checkout_store_file_tree(array $files): string|WP_Error
{
    $root = [];
    foreach ($files as $path => $file) {
        if (!is_string($path) || !zeroy_checkout_path_is_safe($path) || !is_array($file) || !is_string($file['bytes'] ?? null) || !in_array($file['mode'] ?? null, ['file', 'executable'], true)) return zeroy_runtime_error('zeroy_checkout_file_invalid', 'Checkout file projection is invalid.', 500, ['path' => $path]);
        $cursor =& $root;
        $segments = explode('/', $path);
        $name = array_pop($segments);
        foreach ($segments as $segment) {
            if (isset($cursor['files'][$segment])) return zeroy_runtime_error('zeroy_checkout_path_conflict', 'Checkout path is both a file and directory.', 409, ['path' => $path]);
            if (!isset($cursor['directories'][$segment])) $cursor['directories'][$segment] = [];
            $cursor =& $cursor['directories'][$segment];
        }
        if (isset($cursor['directories'][$name]) || isset($cursor['files'][$name])) return zeroy_runtime_error('zeroy_checkout_path_conflict', 'Checkout contains a duplicate path.', 409, ['path' => $path]);
        $cursor['files'][$name] = $file;
        unset($cursor);
    }
    return zeroy_checkout_store_tree_node($root);
}

function zeroy_checkout_store_tree_node(array $node): string|WP_Error
{
    $entries = [];
    foreach (is_array($node['directories'] ?? null) ? $node['directories'] : [] as $name => $child) {
        $hash = zeroy_checkout_store_tree_node($child);
        if (is_wp_error($hash)) return $hash;
        $entries[] = ['name' => $name, 'kind' => 'tree', 'hash' => $hash, 'mode' => 'file'];
    }
    foreach (is_array($node['files'] ?? null) ? $node['files'] : [] as $name => $file) {
        $hash = zeroy_checkout_blob_hash($file['bytes']);
        $stored = zeroy_checkout_store_object('blob', $hash, $file['bytes']);
        if (is_wp_error($stored)) return $stored;
        $entries[] = ['name' => $name, 'kind' => 'blob', 'hash' => $hash, 'mode' => $file['mode']];
    }
    $bytes = zeroy_checkout_tree_bytes($entries);
    if (is_wp_error($bytes)) return $bytes;
    $hash = zeroy_checkout_hash_bytes('tree', $bytes);
    $stored = zeroy_checkout_store_object('tree', $hash, $bytes);
    return is_wp_error($stored) ? $stored : $hash;
}

function zeroy_checkout_store_release_commit(array $release): string|WP_Error
{
    $files = zeroy_checkout_release_files($release);
    if (is_wp_error($files)) return $files;
    $tree = zeroy_checkout_store_file_tree($files);
    if (is_wp_error($tree)) return $tree;
    $created = (string) ($release['activated_at'] ?: $release['created_at']);
    $commit = [
        'contract' => 'zeroy/site-commit@1',
        'tree' => $tree,
        'parents' => [],
        'baseReleaseId' => (string) $release['release_id'],
        'author' => ['principal' => 'system:migration', 'actorSessionId' => 'hard-cut'],
        'message' => 'Import active SiteRelease into SiteCheckout history',
        'createdAt' => gmdate('c', strtotime($created . ' UTC')),
    ];
    $hash = zeroy_checkout_commit_hash($commit);
    if (is_wp_error($hash)) return $hash;
    $stored = zeroy_checkout_store_commit($commit, $hash);
    if (is_wp_error($stored)) return $stored;
    return $hash;
}

function zeroy_checkout_seed_active_release_commit(): true|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if ($active === null || !empty($active['commit_hash'])) return true;
    $hash = zeroy_checkout_store_release_commit($active);
    if (is_wp_error($hash)) return $hash;
    global $wpdb;
    $updated = $wpdb->update(zeroy_runtime_table('site_releases'), ['commit_hash' => $hash], ['release_id' => $active['release_id'], 'commit_hash' => null], ['%s'], ['%s', '%s']);
    if ($updated !== 1) return zeroy_runtime_error('zeroy_site_release_commit_migration_failed', $wpdb->last_error ?: 'Could not bind active SiteRelease to imported SiteCommit.', 500);
    if (!empty($active['proof_id'])) $wpdb->update(zeroy_runtime_table('verification_proofs'), ['commit_hash' => $hash], ['proof_id' => $active['proof_id']], ['%s'], ['%s']);
    return true;
}

function zeroy_checkout_seed_bootstrap_commit(): string|WP_Error
{
    $stored_hash = get_option('zeroy_checkout_bootstrap_commit', '');
    if (is_string($stored_hash) && preg_match('/\Asha256:[a-f0-9]{64}\z/', $stored_hash) === 1 && zeroy_checkout_commit_row($stored_hash) !== null) return $stored_hash;
    $files = [];
    $directory = dirname(__DIR__, 2) . '/default-site-logic';
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
    foreach ($iterator as $file) {
        if (!$file instanceof SplFileInfo || !$file->isFile() || $file->isLink()) continue;
        $absolute = wp_normalize_path($file->getPathname());
        $relative = ltrim(substr($absolute, strlen(rtrim(wp_normalize_path($directory), '/'))), '/');
        $bytes = file_get_contents($absolute);
        if (!is_string($bytes)) return zeroy_runtime_error('zeroy_checkout_bootstrap_failed', 'Could not read default SiteLogic.', 500, ['path' => $relative]);
        $files['artifacts/site-logic/' . $relative] = ['bytes' => $bytes, 'mode' => $file->isExecutable() ? 'executable' : 'file'];
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) return $config;
    $files['site.json'] = ['bytes' => zeroy_checkout_json_bytes(['contract' => 'zeroy/site@1', 'config' => array_diff_key($config, ['revision' => true, 'siteCopy' => true])]), 'mode' => 'file'];
    $files['content/site-copy.json'] = ['bytes' => zeroy_checkout_json_bytes(['contract' => 'zeroy/site-copy@1', 'canonical' => is_array($config['siteCopy'] ?? null) ? $config['siteCopy'] : []]), 'mode' => 'file'];
    $tree = zeroy_checkout_store_file_tree($files);
    if (is_wp_error($tree)) return $tree;
    $commit = ['contract' => 'zeroy/site-commit@1', 'tree' => $tree, 'parents' => [], 'baseReleaseId' => null, 'author' => ['principal' => 'system:bootstrap', 'actorSessionId' => 'hard-cut'], 'message' => 'Bootstrap SiteCheckout', 'createdAt' => '2026-08-03T00:00:00+00:00'];
    $hash = zeroy_checkout_commit_hash($commit);
    if (is_wp_error($hash)) return $hash;
    $stored = zeroy_checkout_store_commit($commit, $hash);
    if (is_wp_error($stored)) return $stored;
    update_option('zeroy_checkout_bootstrap_commit', $hash, false);
    return $hash;
}

function zeroy_checkout_flatten_tree(string $tree_hash, string $prefix = ''): array|WP_Error
{
    $entries = zeroy_checkout_tree_entries($tree_hash);
    if (is_wp_error($entries)) return $entries;
    $files = [];
    foreach ($entries as $entry) {
        $path = $prefix === '' ? $entry['name'] : $prefix . '/' . $entry['name'];
        if ($entry['kind'] === 'tree') {
            $nested = zeroy_checkout_flatten_tree($entry['hash'], $path);
            if (is_wp_error($nested)) return $nested;
            $files += $nested;
        } else {
            $row = zeroy_checkout_object_row($entry['hash']);
            if ($row === null) return zeroy_runtime_error('zeroy_tree_object_missing', 'Checkout blob is missing.', 500, ['path' => $path]);
            $files[$path] = ['hash' => $entry['hash'], 'mode' => $entry['mode'], 'byteCount' => (int) $row['byte_count']];
        }
    }
    ksort($files, SORT_STRING);
    return $files;
}
