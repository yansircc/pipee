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
        'site_releases' => "CREATE TABLE " . zeroy_runtime_table('site_releases') . " (release_id CHAR(36) NOT NULL, draft_id CHAR(36) NULL, theme_artifact_id VARCHAR(71) NOT NULL, site_logic_artifact_id VARCHAR(71) NOT NULL, theme_contract_hash CHAR(64) NOT NULL, site_logic_contract_hash CHAR(64) NOT NULL, storage_epoch BIGINT UNSIGNED NOT NULL, snapshot_hash CHAR(64) NOT NULL, snapshot_json LONGTEXT NOT NULL, expected_active_release_id CHAR(36) NULL, state VARCHAR(16) NOT NULL, proof_id VARCHAR(64) NULL, provenance_json LONGTEXT NOT NULL, diagnostics_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, activated_at DATETIME NULL, PRIMARY KEY (release_id), KEY zeroy_site_release_state (state), KEY zeroy_site_release_draft (draft_id), KEY zeroy_site_release_theme (theme_artifact_id), KEY zeroy_site_release_logic (site_logic_artifact_id)) {$charset};",
        'site_release_state' => "CREATE TABLE " . zeroy_runtime_table('site_release_state') . " (singleton TINYINT UNSIGNED NOT NULL, active_release_id CHAR(36) NOT NULL, revision BIGINT UNSIGNED NOT NULL, activated_at DATETIME NOT NULL, PRIMARY KEY (singleton)) {$charset};",
        'verification_proofs' => "CREATE TABLE " . zeroy_runtime_table('verification_proofs') . " (proof_id VARCHAR(64) NOT NULL, release_id CHAR(36) NOT NULL, proof_json LONGTEXT NOT NULL, verified_at DATETIME NOT NULL, PRIMARY KEY (proof_id), KEY zeroy_proof_release (release_id)) {$charset};",
        'site_drafts' => "CREATE TABLE " . zeroy_runtime_table('site_drafts') . " (draft_id CHAR(36) NOT NULL, owner_id VARCHAR(128) NOT NULL DEFAULT '', base_release_id CHAR(36) NULL, state VARCHAR(16) NOT NULL, operations_json LONGTEXT NOT NULL, proof_id VARCHAR(64) NULL, diagnostics_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (draft_id), KEY zeroy_site_draft_owner (owner_id), KEY zeroy_site_draft_state (state), KEY zeroy_site_draft_base (base_release_id)) {$charset};",
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

function zeroy_runtime_table_column_exists(string $table, string $column): bool
{
    global $wpdb;
    $columns = $wpdb->get_results('DESCRIBE ' . $table, ARRAY_A);
    foreach (is_array($columns) ? $columns : [] as $definition) {
        if (($definition['Field'] ?? null) === $column) return true;
    }
    return false;
}

/**
 * dbDelta is a table creator here, not an upgrade engine. Some database
 * adapters rebuild an existing table when presented with an otherwise
 * unchanged CREATE TABLE statement. Each hard-cut storage invariant is
 * therefore declared once and upgraded by its exact column transition.
 */
function zeroy_runtime_required_schema_columns(): array
{
    return [
        'site_drafts' => [
            'owner_id' => "VARCHAR(128) NOT NULL DEFAULT ''",
        ],
        'site_releases' => [
            // Existing releases are converted before a reader can select
            // them. These are nullable only at the transition boundary;
            // fresh tables retain the stricter CREATE TABLE definition.
            'draft_id' => 'CHAR(36) NULL',
            'snapshot_hash' => 'CHAR(64) NULL',
            'snapshot_json' => 'LONGTEXT NULL',
        ],
        'locale_overlay_heads' => [
            'published_at' => 'DATETIME NULL',
        ],
    ];
}

function zeroy_runtime_ensure_schema_column(string $table_name, string $column, string $definition): true|WP_Error
{
    global $wpdb;
    $table = zeroy_runtime_table($table_name);
    if (zeroy_runtime_table_column_exists($table, $column)) return true;
    $added = $wpdb->query("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
    return $added === false
        ? zeroy_runtime_error('zeroy_runtime_schema_column_migration_failed', $wpdb->last_error ?: "Could not add {$table_name}.{$column}.", 500, ['table' => $table_name, 'column' => $column])
        : true;
}

/**
 * Existing public readers need publication time even though it was absent
 * from prior overlay rows. This is a fact conversion, not a legacy reader.
 */
function zeroy_runtime_backfill_overlay_published_at(): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->query(
        'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET published_at = updated_at WHERE published_version_id IS NOT NULL AND published_at IS NULL',
    );
    return $updated === false
        ? zeroy_runtime_error('zeroy_runtime_overlay_published_at_backfill_failed', $wpdb->last_error ?: 'Could not backfill locale overlay publication timestamps.', 500)
        : true;
}

/**
 * A pre-hard-cut open Draft has no reconstructable Pi session identity. It
 * cannot be claimed, so it becomes terminal rather than an unowned
 * compatibility path.
 */
function zeroy_runtime_discard_unowned_site_drafts(): true|WP_Error
{
    global $wpdb;
    $table = zeroy_runtime_table('site_drafts');
    // A pre-hard-cut open Draft has no reconstructable Pi session identity.
    // It cannot be safely claimed, so it is explicitly terminal rather than
    // becoming an unowned compatibility path.
    $updated = $wpdb->query(
        'UPDATE ' . $table .
        " SET state = 'discarded', diagnostics_json = '{\"hardCut\":\"draft-owner-required\"}'" .
        " WHERE owner_id = '' AND state IN ('open', 'committing')",
    );
    return $updated === false
        ? zeroy_runtime_error('zeroy_site_draft_owner_migration_failed', $wpdb->last_error ?: 'Could not discard unowned SiteDrafts.', 500)
        : true;
}

function zeroy_runtime_migrate_schema_columns(): true|WP_Error
{
    foreach (zeroy_runtime_required_schema_columns() as $table => $columns) {
        foreach ($columns as $column => $definition) {
            $result = zeroy_runtime_ensure_schema_column($table, $column, $definition);
            if (is_wp_error($result)) return $result;
        }
    }
    $published_at = zeroy_runtime_backfill_overlay_published_at();
    if (is_wp_error($published_at)) return $published_at;
    return zeroy_runtime_discard_unowned_site_drafts();
}

function zeroy_runtime_install_schema(): true|WP_Error
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    foreach (zeroy_runtime_schema_definitions() as $name => $sql) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) dbDelta($sql);
    }
    $migration = zeroy_runtime_migrate_schema_columns();
    if (is_wp_error($migration)) return $migration;
    foreach (['content', 'site-release'] as $lock) {
        $wpdb->query($wpdb->prepare('INSERT IGNORE INTO ' . zeroy_runtime_table('runtime_locks') . ' (lock_name, revision) VALUES (%s, 0)', $lock));
    }
    return true;
}

function zeroy_runtime_schema_is_current(): bool
{
    foreach (array_keys(zeroy_runtime_schema_definitions()) as $name) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) return false;
    }
    foreach (zeroy_runtime_required_schema_columns() as $table => $columns) {
        foreach (array_keys($columns) as $column) {
            if (!zeroy_runtime_table_column_exists(zeroy_runtime_table($table), $column)) return false;
        }
    }
    $active = zeroy_runtime_active_site_release();
    return $active === null || !is_wp_error(zeroy_runtime_site_release_snapshot($active));
}

function zeroy_runtime_record_upgrade_error(WP_Error $error): void
{
    update_option('zeroy_runtime_upgrade_error', ['code' => $error->get_error_code(), 'message' => $error->get_error_message()], false);
}

function zeroy_runtime_initialize(): true|WP_Error
{
    $schema = zeroy_runtime_install_schema();
    if (is_wp_error($schema)) return $schema;
    $shell = zeroy_runtime_enforce_stable_shell();
    if (is_wp_error($shell)) return $shell;
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
    $snapshot = zeroy_runtime_migrate_active_site_release_snapshot();
    if (is_wp_error($snapshot)) return $snapshot;
    return true;
}

function zeroy_runtime_maybe_upgrade(): void
{
    if (zeroy_runtime_candidate_site_release_from_request() !== null) return;
    if (get_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, '') === ZEROY_RUNTIME_DATABASE_VERSION && zeroy_runtime_schema_is_current()) return;
    $initialized = zeroy_runtime_initialize();
    if (is_wp_error($initialized)) {
        zeroy_runtime_record_upgrade_error($initialized);
        return;
    }
    delete_option('zeroy_runtime_upgrade_error');
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
}

function zeroy_runtime_activate(): void
{
    $initialized = zeroy_runtime_initialize();
    if (is_wp_error($initialized)) {
        zeroy_runtime_record_upgrade_error($initialized);
        return;
    }
    delete_option('zeroy_runtime_upgrade_error');
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
    flush_rewrite_rules(false);
}

function zeroy_runtime_deactivate(): void
{
    flush_rewrite_rules(false);
}
