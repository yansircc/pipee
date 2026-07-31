<?php

defined('ABSPATH') || exit;

function zeroy_runtime_schema_definitions(): array
{
    global $wpdb;
    $charset = $wpdb->get_charset_collate();
    return [
        'runtime_locks' => "CREATE TABLE " . zeroy_runtime_table('runtime_locks') . " (lock_name VARCHAR(64) NOT NULL, revision BIGINT UNSIGNED NOT NULL, PRIMARY KEY (lock_name)) {$charset};",
        'theme_artifacts' => "CREATE TABLE " . zeroy_runtime_table('theme_artifacts') . " (artifact_id VARCHAR(71) NOT NULL, manifest_json LONGTEXT NOT NULL, schema_json LONGTEXT NOT NULL, schema_hash CHAR(64) NOT NULL, file_count BIGINT UNSIGNED NOT NULL, total_bytes BIGINT UNSIGNED NOT NULL, pinned_at DATETIME NULL, created_at DATETIME NOT NULL, PRIMARY KEY (artifact_id)) {$charset};",
        'site_logic_artifacts' => "CREATE TABLE " . zeroy_runtime_table('site_logic_artifacts') . " (artifact_id VARCHAR(71) NOT NULL, manifest_json LONGTEXT NOT NULL, contract_json LONGTEXT NOT NULL, contract_hash CHAR(64) NOT NULL, storage_epoch BIGINT UNSIGNED NOT NULL, file_count BIGINT UNSIGNED NOT NULL, total_bytes BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (artifact_id)) {$charset};",
        'site_releases' => "CREATE TABLE " . zeroy_runtime_table('site_releases') . " (release_id CHAR(36) NOT NULL, theme_artifact_id VARCHAR(71) NOT NULL, site_logic_artifact_id VARCHAR(71) NOT NULL, theme_contract_hash CHAR(64) NOT NULL, site_logic_contract_hash CHAR(64) NOT NULL, storage_epoch BIGINT UNSIGNED NOT NULL, expected_active_release_id CHAR(36) NULL, state VARCHAR(16) NOT NULL, proof_id VARCHAR(64) NULL, provenance_json LONGTEXT NOT NULL, diagnostics_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, activated_at DATETIME NULL, PRIMARY KEY (release_id), KEY zeroy_site_release_state (state), KEY zeroy_site_release_theme (theme_artifact_id), KEY zeroy_site_release_logic (site_logic_artifact_id)) {$charset};",
        'site_release_state' => "CREATE TABLE " . zeroy_runtime_table('site_release_state') . " (singleton TINYINT UNSIGNED NOT NULL, active_release_id CHAR(36) NOT NULL, revision BIGINT UNSIGNED NOT NULL, activated_at DATETIME NOT NULL, PRIMARY KEY (singleton)) {$charset};",
        'verification_proofs' => "CREATE TABLE " . zeroy_runtime_table('verification_proofs') . " (proof_id VARCHAR(64) NOT NULL, release_id CHAR(36) NOT NULL, proof_json LONGTEXT NOT NULL, verified_at DATETIME NOT NULL, PRIMARY KEY (proof_id), KEY zeroy_proof_release (release_id)) {$charset};",
        'site_logic_migration_ledger' => "CREATE TABLE " . zeroy_runtime_table('site_logic_migration_ledger') . " (idempotency_key VARCHAR(96) NOT NULL, from_epoch BIGINT UNSIGNED NOT NULL, to_epoch BIGINT UNSIGNED NOT NULL, applied_at DATETIME NOT NULL, PRIMARY KEY (idempotency_key)) {$charset};",
        'site_config' => "CREATE TABLE " . zeroy_runtime_table('site_config') . " (singleton TINYINT UNSIGNED NOT NULL, config_json LONGTEXT NOT NULL, revision BIGINT UNSIGNED NOT NULL, PRIMARY KEY (singleton)) {$charset};",
        'locale_overlay_versions' => "CREATE TABLE " . zeroy_runtime_table('locale_overlay_versions') . " (version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, subject_key VARCHAR(191) NOT NULL, locale VARCHAR(32) NOT NULL, policy_hash CHAR(64) NOT NULL, overlay_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (version_id), KEY zeroy_overlay_subject_locale (subject_key, locale)) {$charset};",
        'locale_overlay_heads' => "CREATE TABLE " . zeroy_runtime_table('locale_overlay_heads') . " (subject_key VARCHAR(191) NOT NULL, subject_kind VARCHAR(32) NOT NULL, subject_json LONGTEXT NOT NULL, locale VARCHAR(32) NOT NULL, schema_id VARCHAR(96) NOT NULL, route_path VARCHAR(190) NOT NULL, draft_version_id BIGINT UNSIGNED NULL, published_version_id BIGINT UNSIGNED NULL, published_at DATETIME NULL, revision BIGINT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (subject_key, locale), KEY zeroy_overlay_head_published (published_version_id), KEY zeroy_overlay_head_route (locale, route_path)) {$charset};",
    ];
}

function zeroy_runtime_table_exists(string $table): bool
{
    global $wpdb;
    return $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;
}

function zeroy_runtime_install_schema(): void
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    foreach (zeroy_runtime_schema_definitions() as $name => $sql) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) {
            dbDelta($sql);
        }
    }
    foreach (['content', 'site-release'] as $lock) {
        $wpdb->query($wpdb->prepare('INSERT IGNORE INTO ' . zeroy_runtime_table('runtime_locks') . ' (lock_name, revision) VALUES (%s, 0)', $lock));
    }
}

function zeroy_runtime_locale_overlay_heads_has_published_at(): bool
{
    global $wpdb;
    $columns = $wpdb->get_results('DESCRIBE ' . zeroy_runtime_table('locale_overlay_heads'), ARRAY_A);
    foreach (is_array($columns) ? $columns : [] as $column) {
        if (($column['Field'] ?? null) === 'published_at') {
            return true;
        }
    }
    return false;
}

function zeroy_runtime_ensure_overlay_published_at(): true|WP_Error
{
    global $wpdb;
    if (zeroy_runtime_locale_overlay_heads_has_published_at()) {
        return true;
    }
    $result = $wpdb->query('ALTER TABLE ' . zeroy_runtime_table('locale_overlay_heads') . ' ADD COLUMN published_at DATETIME NULL');
    return $result === false
        ? zeroy_runtime_error('zeroy_runtime_overlay_published_at_migration_failed', $wpdb->last_error ?: 'Could not add locale overlay published timestamp.', 500)
        : true;
}

function zeroy_runtime_backfill_overlay_published_at(): true|WP_Error
{
    global $wpdb;
    $result = $wpdb->query(
        'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET published_at = updated_at WHERE published_version_id IS NOT NULL AND published_at IS NULL'
    );
    return $result === false
        ? zeroy_runtime_error('zeroy_runtime_overlay_published_at_backfill_failed', $wpdb->last_error ?: 'Could not backfill locale overlay publication timestamps.', 500)
        : true;
}

function zeroy_runtime_schema_is_current(): bool
{
    foreach (array_keys(zeroy_runtime_schema_definitions()) as $name) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) {
            return false;
        }
    }
    return zeroy_runtime_locale_overlay_heads_has_published_at();
}

function zeroy_runtime_drop_removed_runtime_tables(): void
{
    global $wpdb;
    foreach (['schema_state', 'route_reservations', 'collection_route_reservations', 'search_projection'] as $table) {
        $wpdb->query('DROP TABLE IF EXISTS ' . zeroy_runtime_table($table));
    }
    zeroy_runtime_drop_legacy_site_release_tables();
}

function zeroy_runtime_record_upgrade_error(WP_Error $error): void
{
    update_option('zeroy_runtime_upgrade_error', ['code' => $error->get_error_code(), 'message' => $error->get_error_message()], false);
}

function zeroy_runtime_has_failed_hard_cut_attempt(): bool
{
    global $wpdb;
    return zeroy_runtime_table_exists(zeroy_runtime_table('site_releases'))
        && (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_releases')) > 0
        && zeroy_runtime_active_site_release() === null
        && get_option('zeroy_runtime_upgrade_error', false) !== false;
}

function zeroy_runtime_maybe_upgrade(): void
{
    // Candidate verification pins a not-yet-active release. It must never
    // recursively start the legacy migration before request pinning happens.
    if (zeroy_runtime_candidate_site_release_from_request() !== null) {
        return;
    }
    if (zeroy_runtime_has_failed_hard_cut_attempt()) {
        return;
    }
    if (get_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, '') === ZEROY_RUNTIME_DATABASE_VERSION && zeroy_runtime_schema_is_current()) {
        return;
    }
    zeroy_runtime_install_schema();
    $shell = zeroy_runtime_install_stable_shell();
    if (is_wp_error($shell)) {
        zeroy_runtime_record_upgrade_error($shell);
        return;
    }
    $published_at = zeroy_runtime_ensure_overlay_published_at();
    if (is_wp_error($published_at)) {
        zeroy_runtime_record_upgrade_error($published_at);
        return;
    }
    $backfill = zeroy_runtime_backfill_overlay_published_at();
    if (is_wp_error($backfill)) {
        zeroy_runtime_record_upgrade_error($backfill);
        return;
    }
    $migration = zeroy_runtime_migrate_legacy_site_release();
    if (is_wp_error($migration)) {
        zeroy_runtime_record_upgrade_error($migration);
        return;
    }
    zeroy_runtime_drop_removed_runtime_tables();
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
    $routes = zeroy_runtime_migrate_canonical_route_slugs();
    if (is_wp_error($routes)) {
        zeroy_runtime_record_upgrade_error($routes);
        return;
    }
    delete_option('zeroy_runtime_upgrade_error');
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
}

function zeroy_runtime_activate(): void
{
    zeroy_runtime_install_schema();
    $shell = zeroy_runtime_install_stable_shell();
    if (is_wp_error($shell)) {
        zeroy_runtime_record_upgrade_error($shell);
        return;
    }
    $published_at = zeroy_runtime_ensure_overlay_published_at();
    $backfill = is_wp_error($published_at) ? $published_at : zeroy_runtime_backfill_overlay_published_at();
    if (is_wp_error($backfill)) {
        zeroy_runtime_record_upgrade_error($backfill);
        return;
    }
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
    $migration = zeroy_runtime_migrate_legacy_site_release();
    if (is_wp_error($migration)) {
        zeroy_runtime_record_upgrade_error($migration);
        return;
    }
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
    flush_rewrite_rules(false);
}

function zeroy_runtime_deactivate(): void
{
    flush_rewrite_rules(false);
}
