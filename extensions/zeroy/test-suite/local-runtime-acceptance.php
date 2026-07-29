<?php

/**
 * Destructive proof for a throwaway LocalWP site.
 *
 * Run: locwp wp <site-id> -- eval-file /absolute/path/to/local-runtime-acceptance.php
 *
 * It retains proof objects and route reservations, but restores SiteConfig and
 * ThemeSchema even when an assertion fails.
 */

defined('ABSPATH') || exit(1);

function zeroy_accept(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function zeroy_accept_error(mixed $value, string $code, string $message): void
{
    zeroy_accept(is_wp_error($value), $message . ' did not fail.');
    zeroy_accept($value->get_error_code() === $code, $message . ' failed with ' . $value->get_error_code() . '.');
}

function zeroy_accept_theme_write(array $files): array
{
    $request = new WP_REST_Request('POST', '/zeroy/v1/theme-files');
    $request->set_header('content-type', 'application/json');
    $request->set_body(wp_json_encode(['files' => $files]));
    return zeroy_runtime_theme_files_write_endpoint($request)->get_data();
}

function zeroy_accept_http_status(string $url): int
{
    $response = wp_remote_get($url, ['timeout' => 15, 'redirection' => 0]);
    if (is_wp_error($response)) {
        throw new RuntimeException('Could not request ' . $url . ': ' . $response->get_error_message());
    }
    return (int) wp_remote_retrieve_response_code($response);
}

function zeroy_accept_contains(array $result, int $object_id): bool
{
    foreach ($result['items'] as $item) {
        if (($item['objectId'] ?? null) === $object_id) {
            return true;
        }
    }
    return false;
}

$original_config = zeroy_runtime_site_config();
zeroy_accept(!is_wp_error($original_config), 'SiteConfig must be readable.');
$schema_path = get_stylesheet_directory() . '/zeroy.schema.json';
$original_schema_json = file_get_contents($schema_path);
zeroy_accept(is_string($original_schema_json), 'Could not read active ThemeSchema.');
$original_schema = json_decode($original_schema_json, true, 512, JSON_THROW_ON_ERROR);
zeroy_accept(is_array($original_schema), 'Active ThemeSchema must be an object.');
$config_changed = false;
$theme_file = null;

try {
    $token = strtolower(wp_generate_password(10, false, false));
    $route = 'runtime-acceptance-' . $token;
    $canonical = zeroy_runtime_create_canonical('page', 'showcase', 'Runtime acceptance ' . $token);
    zeroy_accept(!is_wp_error($canonical), 'Could not create canonical object.');
    $object_id = $canonical['objectId'];

    $zh_draft = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '运行时验收 ' . $token, 'intro' => '验证发布指针、路由和搜索投影。'],
        0,
    );
    zeroy_accept(!is_wp_error($zh_draft) && $zh_draft['revision'] === 1, 'First LocaleHead draft must be revision 1.');
    zeroy_accept_error(
        zeroy_runtime_write_draft($object_id, 'zh-CN', 'showcase', $route, ['title' => 'Stale', 'intro' => 'Stale'], 0),
        'zeroy_locale_conflict',
        'A stale LocaleHead revision',
    );

    $published = zeroy_runtime_publish_draft($object_id, 'zh-CN', 1);
    zeroy_accept(!is_wp_error($published) && $published['state'] === 'published' && $published['revision'] === 2, 'Publish must advance one pointer.');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 200, 'Published locale route must render 200.');
    zeroy_accept(zeroy_accept_contains(zeroy_locale_archive('zh-CN', 'showcase'), $object_id), 'Locale archive must include published object.');
    zeroy_accept(zeroy_accept_contains(zeroy_locale_search('zh-CN', 'showcase', $token), $object_id), 'Locale search must include published object.');

    $default_switch = $original_config;
    $default_switch['defaultLocale'] = 'en';
    foreach ($default_switch['enabledLocales'] as &$locale) {
        $locale['urlPrefix'] = $locale['locale'] === 'en' ? '' : 'zh';
    }
    unset($locale);
    zeroy_accept_error(
        zeroy_runtime_update_site_config($default_switch, $original_config['revision']),
        'zeroy_default_locale_locked',
        'Changing default locale after first publish',
    );
    zeroy_accept_error(
        zeroy_runtime_update_site_config($original_config, $original_config['revision'] - 1),
        'zeroy_site_config_conflict',
        'A stale SiteConfig revision',
    );

    $theme_file = 'zeroy-acceptance-' . $token . '.txt';
    $created = zeroy_accept_theme_write([['path' => $theme_file, 'content' => 'initial', 'expectedHash' => null]]);
    zeroy_accept($created['ok'] === true && $created['results'][0]['created'] === true, 'New file must accept expectedHash null.');
    $initial_hash = $created['results'][0]['hash'];
    $partial = zeroy_accept_theme_write([
        ['path' => $theme_file, 'content' => 'replaced', 'expectedHash' => $initial_hash],
        ['path' => '../outside.txt', 'content' => 'must fail', 'expectedHash' => null],
    ]);
    zeroy_accept($partial['ok'] === false && $partial['results'][0]['ok'] === true && $partial['results'][1]['ok'] === false, 'Theme batch must retain per-file partial results.');
    $stale_file = zeroy_accept_theme_write([['path' => $theme_file, 'content' => 'stale', 'expectedHash' => $initial_hash]]);
    zeroy_accept($stale_file['ok'] === false && $stale_file['results'][0]['code'] === 'zeroy_theme_hash_conflict', 'Stale theme hash must fail.');

    $changed_schema = $original_schema;
    $changed_schema['schemas']['showcase']['nodes']['tagline'] = ['kind' => 'text', 'required' => true, 'searchable' => false];
    $schema_change = zeroy_accept_theme_write([[
        'path' => 'zeroy.schema.json',
        'content' => wp_json_encode($changed_schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
        'expectedHash' => hash('sha256', $original_schema_json),
    ]]);
    zeroy_accept($schema_change['ok'] === true, 'Schema mutation must use theme write port.');
    zeroy_accept_error(zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase'), 'zeroy_schema_mismatch', 'Old-schema published document');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 404, 'Old-schema published route must fail closed.');

    $rewritten = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '运行时验收 ' . $token, 'intro' => '按新 schema 重写。', 'tagline' => 'schema v2'],
        2,
    );
    zeroy_accept(!is_wp_error($rewritten) && $rewritten['revision'] === 3, 'Schema rewrite must advance draft pointer.');
    zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($object_id, 'zh-CN', 3)), 'Rewritten draft must publish.');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 200, 'Rewritten locale route must recover.');

    $restore_schema = zeroy_accept_theme_write([[
        'path' => 'zeroy.schema.json',
        'content' => $original_schema_json,
        'expectedHash' => $schema_change['results'][0]['hash'],
    ]]);
    zeroy_accept($restore_schema['ok'] === true, 'Could not restore original ThemeSchema.');
    $restored_draft = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '运行时验收 ' . $token, 'intro' => '已恢复原 schema。'],
        4,
    );
    zeroy_accept(!is_wp_error($restored_draft) && $restored_draft['revision'] === 5, 'Restored schema requires new draft.');
    zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($object_id, 'zh-CN', 5)), 'Restored schema draft must publish.');

    $unpublished = zeroy_runtime_unpublish($object_id, 'zh-CN', 6);
    zeroy_accept(!is_wp_error($unpublished) && $unpublished['state'] === 'draft', 'Unpublish must only clear published pointer.');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 404, 'Unpublished reserved route must be 404.');
    zeroy_accept_error(zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase'), 'zeroy_locale_not_published', 'Unpublished locale read');

    $en_draft = zeroy_runtime_write_draft(
        $object_id,
        'en',
        'showcase',
        $route,
        ['title' => 'Runtime acceptance ' . $token, 'intro' => 'Disabled locale routing.'],
        0,
    );
    zeroy_accept(!is_wp_error($en_draft) && !is_wp_error(zeroy_runtime_publish_draft($object_id, 'en', 1)), 'Could not publish English acceptance document.');
    $without_english = $original_config;
    $without_english['enabledLocales'] = array_values(array_filter($without_english['enabledLocales'], static fn(array $locale): bool => $locale['locale'] !== 'en'));
    $disabled = zeroy_runtime_update_site_config($without_english, $original_config['revision']);
    zeroy_accept(!is_wp_error($disabled), 'Could not disable English.');
    $config_changed = true;
    zeroy_accept(zeroy_accept_http_status(home_url('/en/' . $route . '/')) === 404, 'Disabled locale route must remain reserved and return 404.');
    $restored_config = zeroy_runtime_update_site_config($original_config, $disabled['revision']);
    zeroy_accept(!is_wp_error($restored_config), 'Could not restore SiteConfig.');
    $config_changed = false;

    zeroy_accept(function_exists('acf_update_field_group') && function_exists('acf_update_field'), 'This acceptance requires active ACF.');
    $group_key = 'group_zeroy_acceptance_' . $token;
    $field_key = 'field_zeroy_acceptance_' . $token;
    acf_update_field_group([
        'key' => $group_key,
        'title' => 'zeroY shared acceptance ' . $token,
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
    ]);
    $group = acf_get_field_group($group_key);
    zeroy_accept(is_array($group) && isset($group['ID']), 'Could not create the real ACF field group.');
    acf_update_field([
        'key' => $field_key,
        'parent' => $group['ID'],
        'label' => 'Shared capacity',
        'name' => 'shared_capacity_' . $token,
        'type' => 'number',
        'required' => true,
    ]);
    $acf = zeroy_runtime_acf_projection();
    $projected_group = null;
    foreach ($acf['fieldGroups'] as $group) {
        if ($group['key'] === $group_key) {
            $projected_group = $group;
            break;
        }
    }
    zeroy_accept(is_array($projected_group), 'Connector did not project the real ACF field group.');
    zeroy_accept($projected_group['fields'][0]['key'] === $field_key && $projected_group['fields'][0]['type'] === 'number', 'Connector did not preserve the ACF field structure.');

    $integrity = zeroy_runtime_integrity();
    zeroy_accept($integrity['ok'] === true, 'Integrity failed: ' . wp_json_encode($integrity['issues']));
    echo wp_json_encode(['ok' => true, 'objectId' => $object_id, 'route' => $route, 'checks' => ['localeCas', 'siteConfigCasAndDefaultLock', 'themeHashAndPartialBatch', 'schemaHashFailClosedAndRecovery', 'unpublishTombstone404', 'disabledLocale404', 'localeFirstArchiveAndSearch', 'realAcfProjection', 'integrity']], JSON_UNESCAPED_SLASHES) . PHP_EOL;
} finally {
    if (file_get_contents($schema_path) !== $original_schema_json) {
        file_put_contents($schema_path, $original_schema_json, LOCK_EX);
    }
    if ($config_changed) {
        $current_config = zeroy_runtime_site_config();
        if (is_array($current_config)) {
            zeroy_runtime_update_site_config($original_config, $current_config['revision']);
        }
    }
    if (is_string($theme_file)) {
        $test_file = get_stylesheet_directory() . '/' . $theme_file;
        if (is_file($test_file) && !is_link($test_file)) {
            unlink($test_file);
        }
    }
}
