<?php

/**
 * Destructive proof for a disposable LocalWP site.
 *
 * Run: locwp wp <site-id> -- eval-file /absolute/path/to/legacy-migration-acceptance.php
 *
 * It fabricates one retired LocaleVersion data set, then proves that the
 * single bootstrap transaction imports default nodes into WordPress and an
 * enabled non-default locale into LocaleOverlay before removing old tables.
 */

defined('ABSPATH') || exit(1);

function zeroy_legacy_accept(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

global $wpdb;
$token = strtolower(wp_generate_password(10, false, false));
$post_id = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => '旧版默认标题 ' . $token,
    'post_content' => '旧版默认正文 ' . $token,
    'post_name' => 'legacy-migration-' . $token,
], true);
zeroy_legacy_accept(!is_wp_error($post_id), 'Could not create legacy canonical post.');
update_post_meta((int) $post_id, ZEROY_RUNTIME_SCHEMA_META, 'home');
update_post_meta((int) $post_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1);

// This mirrors the retired v2 storage shape. It is test evidence only; the
// production runtime never creates these tables.
foreach (['locale_versions', 'locale_heads'] as $table) {
    $wpdb->query('DROP TABLE IF EXISTS ' . zeroy_runtime_table($table));
}
$charset = $wpdb->get_charset_collate();
$wpdb->query("CREATE TABLE " . zeroy_runtime_table('locale_versions') . " (
    version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    object_id BIGINT UNSIGNED NOT NULL,
    locale VARCHAR(32) NOT NULL,
    schema_id VARCHAR(96) NOT NULL,
    schema_hash CHAR(64) NOT NULL,
    document_json LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (version_id)
) {$charset}");
$wpdb->query("CREATE TABLE " . zeroy_runtime_table('locale_heads') . " (
    object_id BIGINT UNSIGNED NOT NULL,
    locale VARCHAR(32) NOT NULL,
    schema_id VARCHAR(96) NOT NULL,
    route_path VARCHAR(190) NOT NULL,
    url_prefix VARCHAR(80) NOT NULL,
    draft_version_id BIGINT UNSIGNED NULL,
    published_version_id BIGINT UNSIGNED NULL,
    revision BIGINT UNSIGNED NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (object_id, locale)
) {$charset}");

$write_version = static function (string $locale, array $document) use ($wpdb, $post_id): int {
    $written = $wpdb->insert(zeroy_runtime_table('locale_versions'), [
        'object_id' => $post_id,
        'locale' => $locale,
        'schema_id' => 'home',
        'schema_hash' => hash('sha256', 'legacy-' . $locale),
        'document_json' => wp_json_encode($document),
        'created_at' => current_time('mysql', true),
    ]);
    zeroy_legacy_accept($written === 1, 'Could not write retired LocaleVersion.');
    return (int) $wpdb->insert_id;
};

$default_version = $write_version('zh-CN', [
    'contract' => 'zeroy/locale-version@2',
    'nodes' => ['hero_title' => '旧版默认 Hero ' . $token],
    'decisions' => [],
]);
$english_version = $write_version('en', [
    'contract' => 'zeroy/locale-version@2',
    'nodes' => ['hero_title' => 'Legacy English Hero ' . $token],
    'decisions' => [
        '/post/title' => ['mode' => 'override', 'sourceHash' => 'legacy', 'value' => 'Legacy English Title ' . $token],
        '/post/content' => ['mode' => 'override', 'sourceHash' => 'legacy', 'value' => 'Legacy English Content ' . $token],
    ],
]);
foreach ([
    ['zh-CN', '', '', $default_version],
    ['en', 'en', 'legacy-migration-' . $token, $english_version],
] as [$locale, $prefix, $route, $version_id]) {
    $written = $wpdb->insert(zeroy_runtime_table('locale_heads'), [
        'object_id' => $post_id,
        'locale' => $locale,
        'schema_id' => 'home',
        'route_path' => $route,
        'url_prefix' => $prefix,
        'draft_version_id' => $version_id,
        'published_version_id' => $version_id,
        'revision' => 1,
        'updated_at' => current_time('mysql', true),
    ]);
    zeroy_legacy_accept($written === 1, 'Could not write retired LocaleHead.');
}

$wpdb->query('DELETE FROM ' . zeroy_runtime_table('theme_state'));
$wpdb->query('DELETE FROM ' . zeroy_runtime_table('locale_overlay_heads'));
$wpdb->query('DELETE FROM ' . zeroy_runtime_table('locale_overlay_versions'));
switch_theme('zeroy-mvp');
$bootstrap = zeroy_runtime_bootstrap_theme_deployment();
zeroy_legacy_accept(!is_wp_error($bootstrap), 'One-shot bootstrap failed: ' . (is_wp_error($bootstrap) ? $bootstrap->get_error_message() : 'unknown'));
zeroy_legacy_accept(zeroy_runtime_active_theme_state() !== null, 'Bootstrap did not create the only active ThemeDeployment.');
zeroy_legacy_accept(!zeroy_localization_legacy_table_exists('locale_heads'), 'Retired LocaleHead table survived a successful hard-cut import.');
zeroy_legacy_accept(!zeroy_localization_legacy_table_exists('locale_versions'), 'Retired LocaleVersion table survived a successful hard-cut import.');

$home = zeroy_runtime_schema_definition('home');
zeroy_legacy_accept(!is_wp_error($home), 'Active ThemeSchema does not contain home after bootstrap.');
$default_template = zeroy_localization_template_content_values((int) $post_id, $home);
zeroy_legacy_accept(!is_wp_error($default_template) && $default_template['hero_title'] === '旧版默认 Hero ' . $token, 'Default-locale legacy template node was not made canonical.');
$english = zeroy_localization_post_content((int) $post_id, 'en', 'home');
zeroy_legacy_accept(!is_wp_error($english), 'Migrated non-default LocaleOverlay cannot resolve.');
zeroy_legacy_accept($english['post']['title'] === 'Legacy English Title ' . $token, 'Migrated English post title differs from the retired LocaleVersion.');
zeroy_legacy_accept($english['templateContent']['hero_title'] === 'Legacy English Hero ' . $token, 'Migrated English template node differs from the retired LocaleVersion.');

echo wp_json_encode([
    'ok' => true,
    'checks' => ['single-bootstrap-writer', 'default-template-content', 'non-default-overlay', 'retired-table-removal'],
    'postId' => $post_id,
]) . PHP_EOL;
