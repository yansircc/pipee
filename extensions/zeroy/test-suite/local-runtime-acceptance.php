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

function zeroy_accept_theme_copy_write(array $payload): array
{
    $request = new WP_REST_Request('POST', '/zeroy/v1/theme-copy');
    $request->set_header('content-type', 'application/json');
    $request->set_body(wp_json_encode($payload));
    return zeroy_runtime_theme_copy_write_endpoint($request)->get_data();
}

function zeroy_accept_canonical_write(array $payload): array
{
    $request = new WP_REST_Request('POST', '/zeroy/v1/canonical');
    $request->set_header('content-type', 'application/json');
    $request->set_body(wp_json_encode($payload));
    return zeroy_runtime_canonical_write_endpoint($request)->get_data();
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
        if (($item['objectId'] ?? $item['postId'] ?? null) === $object_id) {
            return true;
        }
    }
    return false;
}

function zeroy_accept_delete_locale_object(int $object_id): void
{
    global $wpdb;
    $wpdb->delete(zeroy_runtime_table('route_reservations'), ['object_id' => $object_id], ['%d']);
    $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $object_id], ['%d']);
    $wpdb->delete(zeroy_runtime_table('locale_heads'), ['object_id' => $object_id], ['%d']);
    $wpdb->delete(zeroy_runtime_table('locale_versions'), ['object_id' => $object_id], ['%d']);
    wp_delete_post($object_id, true);
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
$theme_copy_created = false;
$front_page_id = null;

try {
    $token = strtolower(wp_generate_password(10, false, false));
    $route = 'runtime-acceptance-' . $token;
    zeroy_accept(zeroy_runtime_normalize_route('/') === '', 'Root slash must normalize to the explicit FrontPage route.');
    zeroy_accept_error(zeroy_runtime_normalize_route(''), 'zeroy_invalid_route', 'An absent route');
    zeroy_accept(zeroy_runtime_normalize_route('production_line/example') === 'production_line/example', 'Routes must accept ordinary WordPress-style underscore segments.');
    $language = zeroy_runtime_theme_schema_capabilities();
    zeroy_accept($language['nodeKinds'][0]['kind'] === 'text' && $language['nodeKinds'][1]['kind'] === 'rich-text', 'ThemeSchema language must expose every supported node kind.');
    $invalid_schema = $original_schema;
    $invalid_schema['schemas']['showcase']['nodes']['invalid_kind'] = ['kind' => 'image', 'required' => 'yes'];
    $invalid_schema['schemas']['showcase']['nodes']['missing_flags'] = ['kind' => 'text'];
    $invalid = zeroy_runtime_validate_theme_schema($invalid_schema);
    zeroy_accept_error($invalid, 'zeroy_schema_invalid', 'An invalid ThemeSchema');
    $violations = $invalid->get_error_data()['violations'] ?? [];
    zeroy_accept(count($violations) >= 4, 'Schema diagnostics must aggregate actionable node violations.');

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
    $published_version_before_schema_migration = (int) $published['publishedVersionId'];

    $front_locale = $original_config['defaultLocale'];
    global $wpdb;
    $existing_front_page = (int) $wpdb->get_var(
        $wpdb->prepare(
            'SELECT object_id FROM ' . zeroy_runtime_table('route_reservations') . ' WHERE locale = %s AND route_path = %s',
            $front_locale,
            ''
        )
    );
    if ($existing_front_page === 0) {
        $front_page = zeroy_runtime_create_canonical('page', 'showcase', 'FrontPage acceptance ' . $token);
        zeroy_accept(!is_wp_error($front_page), 'Could not create FrontPage canonical object.');
        $front_page_id = (int) $front_page['objectId'];
        $front_draft = zeroy_runtime_write_draft(
            $front_page['objectId'],
            $front_locale,
            'showcase',
            '/',
            ['title' => '首页验收 ' . $token, 'intro' => '验证明确的根路由。'],
            0,
        );
        zeroy_accept(!is_wp_error($front_draft) && $front_draft['route'] === '', 'FrontPage draft must retain the explicit empty stored route.');
        zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($front_page['objectId'], $front_locale, 1)), 'Could not publish FrontPage draft.');
    }
    zeroy_accept(zeroy_accept_http_status(home_url('/')) === 200, 'Published FrontPage route must render 200 without a theme redirect.');

    $default_switch = $original_config;
    $alternate_default = null;
    foreach ($default_switch['enabledLocales'] as $locale) {
        if ($locale['locale'] !== $original_config['defaultLocale']) {
            $alternate_default = $locale['locale'];
            break;
        }
    }
    zeroy_accept(is_string($alternate_default), 'Acceptance requires a second enabled locale.');
    $default_switch['defaultLocale'] = $alternate_default;
    foreach ($default_switch['enabledLocales'] as &$locale) {
        $locale['urlPrefix'] = $locale['locale'] === $alternate_default ? '' : 'former-default';
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

    $metadata_schema = $original_schema;
    $metadata_schema['schemas']['showcase']['titleNode'] = 'title';
    $metadata_schema['schemas']['showcase']['nodes']['subtitle'] = ['kind' => 'text', 'required' => false, 'searchable' => false];
    $metadata_change = zeroy_accept_theme_write([[
        'path' => 'zeroy.schema.json',
        'content' => wp_json_encode($metadata_schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
        'expectedHash' => hash('sha256', $original_schema_json),
    ]]);
    zeroy_accept($metadata_change['ok'] === true, 'Schema mutation must use theme write port.');
    zeroy_accept(($metadata_change['schemaReconciliation']['migrated'] ?? 0) >= 1, 'A valid published document must hard-migrate after an optional-node schema change.');
    $migrated_head = zeroy_runtime_get_head($object_id, 'zh-CN');
    zeroy_accept(is_array($migrated_head) && (int) $migrated_head['published_version_id'] !== $published_version_before_schema_migration, 'Schema migration must advance the immutable published version pointer.');
    zeroy_accept(!is_wp_error(zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase')), 'A migrated published document must use the active schema with no compatibility reader.');

    $changed_schema = $metadata_schema;
    $changed_schema['schemas']['showcase']['nodes']['tagline'] = ['kind' => 'text', 'required' => true, 'searchable' => false];
    $changed_schema['themeCopy'] = [
        'nodes' => [
            'nav.home' => ['kind' => 'text', 'required' => true, 'searchable' => false],
            'cta.quote' => ['kind' => 'text', 'required' => true, 'searchable' => false],
        ],
    ];
    $schema_change = zeroy_accept_theme_write([[
        'path' => 'zeroy.schema.json',
        'content' => wp_json_encode($changed_schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
        'expectedHash' => $metadata_change['results'][0]['hash'],
    ]]);
    zeroy_accept($schema_change['ok'] === true, 'Schema mutation must use theme write port.');
    zeroy_accept(($schema_change['schemaReconciliation']['incompatible'] ?? 0) >= 1, 'A missing required NodeId must remain explicitly incompatible after hard schema migration.');
    $theme_copy_draft = zeroy_accept_theme_copy_write([
        'action' => 'writeThemeCopyDraft',
        'locale' => 'zh-CN',
        'document' => ['nav.home' => '首页', 'cta.quote' => '获取报价'],
        'expectedRevision' => 0,
    ]);
    zeroy_accept(($theme_copy_draft['receipt']['scope'] ?? null) === 'themeCopy' && !array_key_exists('draft', $theme_copy_draft['receipt']), 'ThemeCopy draft must return a compact REST receipt.');
    $theme_copy_created = true;
    $theme_copy_published = zeroy_accept_theme_copy_write([
        'action' => 'publishThemeCopy',
        'locale' => 'zh-CN',
        'expectedRevision' => 1,
    ]);
    zeroy_accept(($theme_copy_published['receipt']['state'] ?? null) === 'published', 'ThemeCopy publish must advance its own LocaleHead.');
    $theme_copy_patch = zeroy_accept_theme_copy_write([
        'action' => 'patchThemeCopyDraft',
        'locale' => 'zh-CN',
        'changes' => ['nav.home' => '主页'],
        'expectedRevision' => 2,
    ]);
    zeroy_accept(($theme_copy_patch['receipt']['revision'] ?? null) === 3, 'ThemeCopy patch must advance one draft revision.');
    $theme_copy_republished = zeroy_accept_theme_copy_write([
        'action' => 'publishThemeCopy',
        'locale' => 'zh-CN',
        'expectedRevision' => 3,
    ]);
    zeroy_accept(($theme_copy_republished['receipt']['revision'] ?? null) === 4, 'Patched ThemeCopy draft must publish from its returned revision.');
    $theme_copy_committed = zeroy_accept_theme_copy_write([
        'action' => 'commitThemeCopy',
        'locale' => 'zh-CN',
        'document' => ['nav.home' => '首页', 'cta.quote' => '获取报价'],
        'expectedRevision' => 4,
    ]);
    zeroy_accept(($theme_copy_committed['receipt']['state'] ?? null) === 'published' && ($theme_copy_committed['receipt']['revision'] ?? null) === 5, 'ThemeCopy commit must write and publish one new immutable version.');
    $theme_copy_read = new WP_REST_Request('GET', '/zeroy/v1/theme-copy');
    $theme_copy_read->set_param('locale', 'zh-CN');
    zeroy_accept((zeroy_runtime_theme_copy_read_endpoint($theme_copy_read)->get_data()['themeCopy']['published']['document']['nav.home'] ?? null) === '首页', 'ThemeCopy read must return the full document only on explicit read.');
    zeroy_accept(zeroy_theme_copy_document('zh-CN')['nav.home'] === '首页', 'Theme PHP helper must read published ThemeCopy.');
    zeroy_accept_error(zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase'), 'zeroy_schema_mismatch', 'Old-schema published document');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 404, 'Old-schema published route must fail closed.');

    $rewritten = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '运行时验收 ' . $token, 'intro' => '按新 schema 重写。', 'tagline' => 'schema v2'],
        3,
    );
    zeroy_accept(!is_wp_error($rewritten) && $rewritten['revision'] === 4, 'Schema rewrite must advance draft pointer.');
    zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($object_id, 'zh-CN', 4)), 'Rewritten draft must publish.');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 200, 'Rewritten locale route must recover.');

    $restore_schema = zeroy_accept_theme_write([[
        'path' => 'zeroy.schema.json',
        'content' => $original_schema_json,
        'expectedHash' => $schema_change['results'][0]['hash'],
    ]]);
    zeroy_accept($restore_schema['ok'] === true, 'Could not restore original ThemeSchema.');
    zeroy_accept(($restore_schema['schemaReconciliation']['migrated'] ?? 0) >= 1, 'Removing a NodeId must hard-migrate documents instead of retaining an old-schema reader.');
    $restored_head = zeroy_runtime_get_head($object_id, 'zh-CN');
    zeroy_accept(is_array($restored_head) && (int) $restored_head['revision'] === 6, 'Hard migration after removing a NodeId must advance the LocaleHead once.');
    $restored_document = zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase');
    zeroy_accept(is_array($restored_document) && !array_key_exists('tagline', $restored_document), 'Hard migration must remove NodeIds absent from the active ThemeSchema.');
    $restored_draft = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '运行时验收 ' . $token, 'intro' => '已恢复原 schema。'],
        6,
    );
    zeroy_accept(!is_wp_error($restored_draft) && $restored_draft['revision'] === 7, 'Restored schema requires new draft.');
    zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($object_id, 'zh-CN', 7)), 'Restored schema draft must publish.');

    $preview_draft = zeroy_runtime_write_draft(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '草稿预览 ' . $token, 'intro' => '该内容尚未发布。'],
        8,
    );
    zeroy_accept(!is_wp_error($preview_draft) && is_string($preview_draft['draftPreviewUrl'] ?? null), 'A draft receipt must provide a signed preview URL.');
    $preview_response = wp_remote_get($preview_draft['draftPreviewUrl'], ['timeout' => 15, 'redirection' => 0]);
    zeroy_accept(!is_wp_error($preview_response) && wp_remote_retrieve_response_code($preview_response) === 200, 'Draft preview URL must render 200.');
    zeroy_accept(str_contains(wp_remote_retrieve_body($preview_response), '草稿预览 ' . $token), 'Draft preview must render the draft document rather than the published document.');
    zeroy_accept((string) wp_remote_retrieve_header($preview_response, 'x-robots-tag') === 'noindex, nofollow, noarchive', 'Draft preview must be noindex and uncached.');
    zeroy_accept(!is_wp_error(zeroy_runtime_publish_draft($object_id, 'zh-CN', 9)), 'Previewed draft must publish through the ordinary review flow.');

    $committed = zeroy_runtime_commit_locale(
        $object_id,
        'zh-CN',
        'showcase',
        $route,
        ['title' => '原子提交 ' . $token, 'intro' => '一次写入并发布。'],
        10,
    );
    zeroy_accept(!is_wp_error($committed) && $committed['state'] === 'published' && $committed['revision'] === 11, 'commit must atomically advance draft and published pointers once.');

    $unpublished = zeroy_runtime_unpublish($object_id, 'zh-CN', 11);
    zeroy_accept(!is_wp_error($unpublished) && $unpublished['state'] === 'draft', 'Unpublish must only clear published pointer.');
    zeroy_accept(zeroy_accept_http_status(zeroy_runtime_route_url('zh-CN', $route)) === 404, 'Unpublished reserved route must be 404.');
    zeroy_accept_error(zeroy_runtime_read_document($object_id, 'zh-CN', 'showcase'), 'zeroy_locale_not_published', 'Unpublished locale read');

    $disabled_locale = $alternate_default;
    $disabled_canonical = zeroy_runtime_create_canonical('page', 'showcase', 'Disabled locale acceptance ' . $token);
    zeroy_accept(!is_wp_error($disabled_canonical), 'Could not create a disabled-locale canonical object.');
    $disabled_route = $route . '-disabled';
    $disabled_draft = zeroy_runtime_write_draft(
        $disabled_canonical['objectId'],
        $disabled_locale,
        'showcase',
        $disabled_route,
        ['title' => 'Runtime acceptance ' . $token, 'intro' => 'Disabled locale routing.'],
        0,
    );
    zeroy_accept(!is_wp_error($disabled_draft) && !is_wp_error(zeroy_runtime_publish_draft($disabled_canonical['objectId'], $disabled_locale, 1)), 'Could not publish a non-default locale acceptance document.');
    $disabled_url = zeroy_runtime_route_url($disabled_locale, $disabled_route);
    $without_english = $original_config;
    $without_english['enabledLocales'] = array_values(array_filter($without_english['enabledLocales'], static fn(array $locale): bool => $locale['locale'] !== $disabled_locale));
    $disabled = zeroy_runtime_update_site_config($without_english, $original_config['revision']);
    zeroy_accept(!is_wp_error($disabled), 'Could not disable a non-default locale.');
    $config_changed = true;
    zeroy_accept(zeroy_accept_http_status($disabled_url) === 404, 'Disabled locale route must remain reserved and return 404.');
    $restored_config = zeroy_runtime_update_site_config($original_config, $disabled['revision']);
    zeroy_accept(!is_wp_error($restored_config), 'Could not restore SiteConfig.');
    $config_changed = false;

    zeroy_accept(function_exists('acf_update_field_group') && function_exists('acf_update_field'), 'This acceptance requires active ACF.');
    $group_key = 'group_zeroy_acceptance_' . $token;
    $field_key = 'field_zeroy_acceptance_' . $token;
    $choice_key = 'field_zeroy_choice_' . $token;
    $repeater_key = 'field_zeroy_repeater_' . $token;
    $sub_field_key = 'field_zeroy_repeater_name_' . $token;
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
    acf_update_field([
        'key' => $choice_key,
        'parent' => $group['ID'],
        'label' => 'Factory status',
        'name' => 'factory_status_' . $token,
        'type' => 'checkbox',
        'choices' => ['new_factory' => '新建工厂', 'upgrade' => '升级改造'],
    ]);
    acf_update_field([
        'key' => $repeater_key,
        'parent' => $group['ID'],
        'label' => 'Specifications',
        'name' => 'specifications_' . $token,
        'type' => 'repeater',
    ]);
    $repeater = acf_get_field($repeater_key);
    zeroy_accept(is_array($repeater) && isset($repeater['ID']), 'Could not create the ACF repeater field.');
    acf_update_field([
        'key' => $sub_field_key,
        'parent' => $repeater['ID'],
        'label' => 'Specification name',
        'name' => 'spec_name',
        'type' => 'text',
    ]);
    // ACF caches the repeater before its subfield is registered. Refresh its
    // definition so the fixture uses ACF's ordinary normalized write path.
    acf_flush_field_cache($repeater);
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
    $choice_projection = null;
    foreach ($projected_group['fields'] as $field) {
        if (($field['key'] ?? null) === $choice_key) {
            $choice_projection = $field;
            break;
        }
    }
    zeroy_accept(($choice_projection['choices'][0] ?? null) === ['value' => 'new_factory', 'label' => '新建工厂'], 'ACF enum fields must expose stable choice values and admin labels.');

    $adoption_post_id = wp_insert_post([
        'post_type' => 'page',
        'post_status' => 'publish',
        'post_title' => 'Adoption acceptance ' . $token,
        'post_content' => 'Existing canonical WordPress content.',
    ], true);
    zeroy_accept(!is_wp_error($adoption_post_id), 'Could not create an unmanaged adoption candidate.');
    update_field($field_key, 42, (int) $adoption_post_id);
    update_field($choice_key, ['new_factory'], (int) $adoption_post_id);
    // ACF mutations address repeater subfields by their storage key. The
    // Connector assertion below deliberately verifies the public runtime view
    // is normalized back to the field-name shape returned by get_fields().
    zeroy_accept(add_row($repeater_key, [$sub_field_key => 'Runtime shape'], (int) $adoption_post_id) === 1, 'Could not write the ACF repeater runtime value.');
    $candidate_request = new WP_REST_Request('GET', '/zeroy/v1/adoption-candidates');
    $candidate_request->set_param('postType', 'page');
    $candidate_request->set_param('schemaId', 'showcase');
    $candidate_request->set_param('perPage', 100);
    $candidates = zeroy_runtime_adoption_candidates_endpoint($candidate_request)->get_data();
    zeroy_accept(zeroy_accept_contains($candidates, (int) $adoption_post_id), 'Unmanaged WordPress page must appear through the adoption-candidates Connector port.');
    $existing_request = new WP_REST_Request('GET', '/zeroy/v1/existing-post');
    $existing_request->set_param('postId', (int) $adoption_post_id);
    $existing = zeroy_runtime_existing_post_endpoint($existing_request)->get_data()['existingPost'];
    zeroy_accept(($existing['acf']['shared_capacity_' . $token] ?? null) === '42', 'Existing post read must include current ACF values.');
    zeroy_accept(($existing['acf']['specifications_' . $token][0]['spec_name'] ?? null) === 'Runtime shape', 'existingPost must use the field-name shape seen by runtime get_field().');
    zeroy_accept_error(
        zeroy_runtime_adopt_canonical((int) $adoption_post_id, 'showcase', str_repeat('0', 64)),
        'zeroy_adoption_source_conflict',
        'A stale adoption source hash'
    );
    $adopted = zeroy_accept_canonical_write([
        'action' => 'adopt',
        'postId' => (int) $adoption_post_id,
        'schemaId' => 'showcase',
        'expectedSourceHash' => $existing['sourceHash'],
    ]);
    zeroy_accept(($adopted['canonical']['revision'] ?? null) === 1, 'Identity-only adoption must initialize one canonical revision through the Connector port.');
    zeroy_accept((int) get_field('shared_capacity_' . $token, (int) $adoption_post_id) === 42, 'Adoption must not copy or overwrite ACF values.');
    $adopted_route = 'adopted-' . $route;
    $adopted_commit = zeroy_runtime_commit_locale(
        (int) $adoption_post_id,
        $original_config['defaultLocale'],
        'showcase',
        $adopted_route,
        ['title' => 'Adopted locale ' . $token, 'intro' => 'Native permalink redirect acceptance.'],
        0,
    );
    zeroy_accept(!is_wp_error($adopted_commit) && $adopted_commit['state'] === 'published', 'A default locale commit must take public ownership of an adopted canonical post.');
    $native_response = wp_remote_get(get_permalink((int) $adoption_post_id), ['timeout' => 15, 'redirection' => 0]);
    zeroy_accept(!is_wp_error($native_response) && wp_remote_retrieve_response_code($native_response) === 301, 'The native WordPress permalink must redirect after default-locale publish.');
    zeroy_accept((string) wp_remote_retrieve_header($native_response, 'location') === zeroy_runtime_route_url($original_config['defaultLocale'], $adopted_route), 'Native permalink redirect must target the default-locale zeroY route.');

    if ($theme_copy_created) {
        global $wpdb;
        $wpdb->delete(zeroy_runtime_table('locale_heads'), ['object_id' => ZEROY_RUNTIME_THEME_COPY_OBJECT_ID], ['%d']);
        $wpdb->delete(zeroy_runtime_table('locale_versions'), ['object_id' => ZEROY_RUNTIME_THEME_COPY_OBJECT_ID], ['%d']);
        $theme_copy_created = false;
    }
    $integrity = zeroy_runtime_integrity();
    zeroy_accept($integrity['ok'] === true, 'Integrity failed: ' . wp_json_encode($integrity['issues']));
    echo wp_json_encode(['ok' => true, 'objectId' => $object_id, 'route' => $route, 'checks' => ['localeCas', 'frontPageRoute', 'siteConfigCasAndDefaultLock', 'themeHashAndPartialBatch', 'schemaDiagnosticsAndCapabilities', 'hardSchemaMigrationAndRecovery', 'draftPreview', 'atomicCommit', 'themeCopyPatchAndCommit', 'unpublishTombstone404', 'disabledLocale404', 'localeFirstArchiveAndSearch', 'realAcfChoicesAndRuntimeProjection', 'identityOnlyAdoption', 'nativePermalinkRedirect', 'routeUnderscore', 'integrity']], JSON_UNESCAPED_SLASHES) . PHP_EOL;
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
    if ($theme_copy_created) {
        global $wpdb;
        $wpdb->delete(zeroy_runtime_table('locale_heads'), ['object_id' => ZEROY_RUNTIME_THEME_COPY_OBJECT_ID], ['%d']);
        $wpdb->delete(zeroy_runtime_table('locale_versions'), ['object_id' => ZEROY_RUNTIME_THEME_COPY_OBJECT_ID], ['%d']);
    }
    if (is_int($front_page_id) && $front_page_id > 0) {
        zeroy_accept_delete_locale_object($front_page_id);
    }
}
