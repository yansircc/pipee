<?php

defined('ABSPATH') || exit;

function zeroy_checkout_json_bytes(mixed $value): string
{
    return zeroy_checkout_canonical_json($value) . "\n";
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

function zeroy_checkout_bootstrap_repeater_item_keys(string $post_type): array
{
    $keys = [];
    $visit = static function (array $fields, string $prefix = '/acf') use (&$visit, &$keys): void {
        foreach ($fields as $field) {
            if (!is_array($field) || !is_string($field['key'] ?? null)) continue;
            $path = $prefix . '/' . zeroy_localization_pointer_segment($field['key']);
            $children = is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];
            if (in_array($field['type'] ?? null, ['repeater', 'flexible_content'], true)) {
                $candidates = array_values(array_filter($children, static fn(array $child): bool =>
                    is_string($child['key'] ?? null) && in_array($child['type'] ?? null, ['text', 'select'], true)
                ));
                usort($candidates, static function (array $left, array $right): int {
                    $rank = static function (array $candidate): int {
                        $name = strtolower((string) ($candidate['name'] ?? ''));
                        foreach (['key', 'name', 'title', 'label'] as $index => $token) if (str_contains($name, $token)) return $index;
                        return 10;
                    };
                    return [$rank($left), (string) $left['key']] <=> [$rank($right), (string) $right['key']];
                });
                if (isset($candidates[0])) $keys[$path] = (string) $candidates[0]['key'];
            }
            if ($children !== []) $visit($children, $path);
            foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) {
                if (is_array($layout['sub_fields'] ?? null)) $visit($layout['sub_fields'], $path);
            }
        }
    };
    $visit(array_values(zeroy_document_acf_fields($post_type)));
    ksort($keys, SORT_STRING);
    return $keys;
}

function zeroy_checkout_bootstrap_localization_policy(string $post_type): array
{
    return [
        'contract' => zeroy_localization_policy_contract(),
        'rules' => [
            ['fieldPattern' => '/post/title', 'mode' => 'translated', 'required' => true, 'contextWeight' => 'primary'],
            ['fieldPattern' => '/post/content', 'mode' => 'translated', 'required' => false, 'contextWeight' => 'primary'],
            ['fieldPattern' => '/post/excerpt', 'mode' => 'overridable', 'required' => false, 'contextWeight' => 'supporting'],
            ['fieldPattern' => '/post/featured_media', 'mode' => 'shared', 'required' => false, 'contextWeight' => 'supporting'],
            ['fieldPattern' => '/acf/**', 'mode' => 'overridable', 'required' => false, 'contextWeight' => 'supporting'],
        ],
        'repeaterItemKeys' => zeroy_runtime_json_map(zeroy_checkout_bootstrap_repeater_item_keys($post_type)),
    ];
}

function zeroy_checkout_bootstrap_workspace(): array
{
    $post_types = [];
    foreach (get_post_types(['public' => true], 'objects') as $post_type => $object) {
        if (!is_string($post_type) || in_array($post_type, ['attachment'], true)) continue;
        $count = wp_count_posts($post_type);
        $has_content = $post_type === 'page';
        if (is_object($count)) foreach (get_object_vars($count) as $status => $value) {
            if (!in_array($status, ['trash', 'auto-draft'], true) && (int) $value > 0) $has_content = true;
        }
        if ($has_content) $post_types[$post_type] = is_object($object) ? $object : null;
    }
    if (!isset($post_types['page'])) $post_types['page'] = get_post_type_object('page');
    ksort($post_types, SORT_STRING);
    $schemas = [];
    $site_collections = [];
    $route_collections = [];
    $templates = [];
    $page_policy = zeroy_checkout_bootstrap_localization_policy('page');
    $schemas['front-page'] = ['label' => 'Front page', 'template' => 'front-page.php', 'routeKind' => 'front-page', 'canonicalPostTypes' => ['page'], 'localization' => $page_policy];
    $site_collections['front-page'] = ['subjectKind' => 'post', 'postType' => 'page', 'schemaId' => 'front-page'];
    $templates['front-page.php'] = true;
    foreach ($post_types as $post_type => $object) {
        $schema_id = $post_type === 'page' ? 'page' : str_replace('_', '-', sanitize_key($post_type));
        $collection_id = $post_type === 'page' ? 'pages' : $schema_id;
        $label = is_object($object) && is_string($object->labels->singular_name ?? null) ? $object->labels->singular_name : ucwords(str_replace(['_', '-'], ' ', $post_type));
        $template = $post_type === 'page' ? 'page.php' : 'single-' . $post_type . '.php';
        $schemas[$schema_id] = ['label' => $label, 'template' => $template, 'routeKind' => $post_type === 'page' ? 'document' : 'singular', 'canonicalPostTypes' => [$post_type], 'localization' => zeroy_checkout_bootstrap_localization_policy($post_type)];
        $site_collections[$collection_id] = ['subjectKind' => 'post', 'postType' => $post_type, 'schemaId' => $schema_id];
        $templates[$template] = true;
        if ($post_type === 'page') continue;
        $route = is_object($object) && is_array($object->rewrite ?? null) && is_string($object->rewrite['slug'] ?? null)
            ? trim($object->rewrite['slug'], '/')
            : str_replace('_', '-', $post_type);
        $archive_id = $collection_id . '-archive';
        $archive_template = 'archive-' . $post_type . '.php';
        $route_collections[$archive_id] = ['kind' => 'post-archive', 'label' => is_object($object) && is_string($object->labels->name ?? null) ? $object->labels->name : $label, 'route' => $route, 'template' => $archive_template, 'schemaId' => $schema_id];
        $templates[$archive_template] = true;
        foreach (get_object_taxonomies($post_type, 'objects') as $taxonomy => $taxonomy_object) {
            if (!is_string($taxonomy) || !is_object($taxonomy_object) || ($taxonomy_object->public ?? false) !== true) continue;
            $taxonomy_id = str_replace('_', '-', sanitize_key($taxonomy));
            if (isset($route_collections[$taxonomy_id])) continue;
            $taxonomy_route = is_array($taxonomy_object->rewrite ?? null) && is_string($taxonomy_object->rewrite['slug'] ?? null)
                ? trim($taxonomy_object->rewrite['slug'], '/')
                : str_replace('_', '-', $taxonomy);
            $taxonomy_template = 'taxonomy-' . $taxonomy . '.php';
            $route_collections[$taxonomy_id] = ['kind' => 'taxonomy', 'label' => (string) ($taxonomy_object->labels->name ?? $taxonomy), 'route' => $taxonomy_route, 'template' => $taxonomy_template, 'schemaId' => $schema_id, 'taxonomy' => $taxonomy];
            $templates[$taxonomy_template] = true;
        }
    }
    $base = zeroy_workspace_theme_schema_template();
    $schema = [...$base, 'schemas' => $schemas, 'collections' => zeroy_runtime_json_map($route_collections)];
    return ['collections' => $site_collections, 'schema' => $schema, 'templates' => array_keys($templates)];
}

function zeroy_checkout_bootstrap_theme_files(array $workspace): array
{
    $render = <<<'PHP'
<?php
defined('ABSPATH') || exit;
$zeroy_context = zeroy_theme_context();
$zeroy_content = is_array($zeroy_context['resolvedContent'] ?? null) ? $zeroy_context['resolvedContent'] : [];
$zeroy_post = is_array($zeroy_content['post'] ?? null) ? $zeroy_content['post'] : [];
$zeroy_title = (string) ($zeroy_post['title'] ?? ($zeroy_context['collection']['title'] ?? ''));
?>
<main><h1><?php echo htmlspecialchars($zeroy_title, ENT_QUOTES, 'UTF-8'); ?></h1></main>
PHP;
    $files = [
        'functions.php' => "<?php\n\ndefined('ABSPATH') || exit;\n",
        'zeroy.schema.json' => zeroy_checkout_json_bytes($workspace['schema']),
        'zeroy.theme.json' => zeroy_checkout_json_bytes(['contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT, 'requiresCapabilities' => new stdClass(), 'zcss' => ['contract' => ZEROY_ZCSS_DESIGN_CONTRACT, 'design' => 'zcss.design.json', 'styles' => ['assets/css/site.css']]]),
        'zcss.design.json' => zeroy_checkout_json_bytes(zeroy_zcss_minimal_design_document()),
        'assets/css/site.css' => "body { margin: 0; font-family: sans-serif; }\nmain { padding: 2rem; }\n",
        'index.php' => $render,
        'search.php' => $render,
        '404.php' => $render,
    ];
    foreach ($workspace['templates'] as $template) $files[$template] = $render;
    ksort($files, SORT_STRING);
    return $files;
}

function zeroy_checkout_seed_bootstrap_commit(): string|WP_Error
{
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
    $workspace = zeroy_checkout_bootstrap_workspace();
    foreach (zeroy_checkout_bootstrap_theme_files($workspace) as $relative => $bytes) $files['artifacts/theme/' . $relative] = ['bytes' => $bytes, 'mode' => 'file'];
    $files['site.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'workspaceFormat' => ZEROY_SITE_TREE_CONTRACT,
        'defaultLocale' => (string) $config['defaultLocale'],
        'locales' => array_values(array_map(static fn(array $locale): string => (string) $locale['locale'], $config['enabledLocales'])),
        'collections' => zeroy_runtime_json_map($workspace['collections']),
    ]), 'mode' => 'file'];
    $site_copy = is_array($config['siteCopy'] ?? null) ? $config['siteCopy'] : [];
    $files['content/site-copy.json'] = ['bytes' => zeroy_checkout_json_bytes(zeroy_runtime_json_map($site_copy)), 'mode' => 'file'];
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
