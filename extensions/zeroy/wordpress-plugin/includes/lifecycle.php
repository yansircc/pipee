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
        'site_releases' => "CREATE TABLE " . zeroy_runtime_table('site_releases') . " (release_id CHAR(36) NOT NULL, commit_hash VARCHAR(71) NULL, build_id VARCHAR(71) NULL, previous_release_id CHAR(36) NULL, theme_artifact_id VARCHAR(71) NOT NULL, site_logic_artifact_id VARCHAR(71) NOT NULL, theme_contract_hash CHAR(64) NOT NULL, site_logic_contract_hash CHAR(64) NOT NULL, storage_epoch BIGINT UNSIGNED NOT NULL, snapshot_hash CHAR(64) NOT NULL, snapshot_json LONGTEXT NOT NULL, expected_active_release_id CHAR(36) NULL, review_brief_hash CHAR(64) NULL, state VARCHAR(24) NOT NULL, proof_id VARCHAR(64) NULL, provenance_json LONGTEXT NOT NULL, diagnostics_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, activated_at DATETIME NULL, PRIMARY KEY (release_id), KEY zeroy_site_release_state (state), KEY zeroy_site_release_commit (commit_hash), UNIQUE KEY zeroy_site_release_build_identity (commit_hash, build_id), KEY zeroy_site_release_build (build_id), KEY zeroy_site_release_theme (theme_artifact_id), KEY zeroy_site_release_logic (site_logic_artifact_id)) {$charset};",
        'site_release_state' => "CREATE TABLE " . zeroy_runtime_table('site_release_state') . " (singleton TINYINT UNSIGNED NOT NULL, active_release_id CHAR(36) NOT NULL, revision BIGINT UNSIGNED NOT NULL, activated_at DATETIME NOT NULL, PRIMARY KEY (singleton)) {$charset};",
        'verification_proofs' => "CREATE TABLE " . zeroy_runtime_table('verification_proofs') . " (proof_id VARCHAR(64) NOT NULL, release_id CHAR(36) NOT NULL, commit_hash VARCHAR(71) NULL, build_id VARCHAR(71) NULL, proof_json LONGTEXT NOT NULL, verified_at DATETIME NOT NULL, PRIMARY KEY (proof_id), KEY zeroy_proof_release (release_id), KEY zeroy_proof_commit (commit_hash), KEY zeroy_proof_build (build_id)) {$charset};",
        'site_objects' => "CREATE TABLE " . zeroy_runtime_table('site_objects') . " (object_hash VARCHAR(71) NOT NULL, object_type VARCHAR(16) NOT NULL, byte_count BIGINT UNSIGNED NOT NULL, object_bytes LONGBLOB NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (object_hash), KEY zeroy_site_object_type (object_type)) {$charset};",
        'site_commits' => "CREATE TABLE " . zeroy_runtime_table('site_commits') . " (commit_hash VARCHAR(71) NOT NULL, tree_hash VARCHAR(71) NOT NULL, parent_hash VARCHAR(71) NULL, base_release_id CHAR(36) NULL, author_principal VARCHAR(128) NOT NULL, actor_session_id VARCHAR(128) NOT NULL, message TEXT NOT NULL, commit_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (commit_hash), KEY zeroy_site_commit_parent (parent_hash), KEY zeroy_site_commit_tree (tree_hash)) {$charset};",
        'site_refs' => "CREATE TABLE " . zeroy_runtime_table('site_refs') . " (ref_name VARCHAR(191) NOT NULL, commit_hash VARCHAR(71) NOT NULL, revision BIGINT UNSIGNED NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (ref_name), KEY zeroy_site_ref_commit (commit_hash)) {$charset};",
        'push_receipts' => "CREATE TABLE " . zeroy_runtime_table('push_receipts') . " (command_id CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL, result_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (command_id)) {$charset};",
        'site_builds' => "CREATE TABLE " . zeroy_runtime_table('site_builds') . " (build_id VARCHAR(71) NOT NULL, commit_hash VARCHAR(71) NOT NULL, compiler_set_hash CHAR(64) NOT NULL, external_facts_hash CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, snapshot_hash CHAR(64) NULL, result_json LONGTEXT NOT NULL, diagnostics_hash CHAR(64) NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (build_id), UNIQUE KEY zeroy_build_identity (commit_hash, compiler_set_hash, external_facts_hash), KEY zeroy_build_commit (commit_hash), KEY zeroy_build_diagnostics (diagnostics_hash)) {$charset};",
        'site_build_diagnostics' => "CREATE TABLE " . zeroy_runtime_table('site_build_diagnostics') . " (diagnostics_hash CHAR(64) NOT NULL, diagnostics_json LONGTEXT NOT NULL, PRIMARY KEY (diagnostics_hash)) {$charset};",
        'site_build_candidates' => "CREATE TABLE " . zeroy_runtime_table('site_build_candidates') . " (build_id VARCHAR(71) NOT NULL, candidate_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (build_id)) {$charset};",
        'site_reviews' => "CREATE TABLE " . zeroy_runtime_table('site_reviews') . " (review_id CHAR(64) NOT NULL, brief_hash CHAR(64) NOT NULL, commit_hash VARCHAR(71) NOT NULL, build_id VARCHAR(71) NOT NULL, release_id CHAR(36) NULL, evaluator_version VARCHAR(96) NOT NULL, state VARCHAR(32) NOT NULL, result_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (review_id), UNIQUE KEY zeroy_site_review_exact (brief_hash, commit_hash, build_id, release_id, evaluator_version), KEY zeroy_site_review_commit (commit_hash), KEY zeroy_site_review_release (release_id)) {$charset};",
        'site_logic_migration_ledger' => "CREATE TABLE " . zeroy_runtime_table('site_logic_migration_ledger') . " (idempotency_key VARCHAR(96) NOT NULL, from_epoch BIGINT UNSIGNED NOT NULL, to_epoch BIGINT UNSIGNED NOT NULL, applied_at DATETIME NOT NULL, PRIMARY KEY (idempotency_key)) {$charset};",
        'site_config' => "CREATE TABLE " . zeroy_runtime_table('site_config') . " (singleton TINYINT UNSIGNED NOT NULL, config_json LONGTEXT NOT NULL, revision BIGINT UNSIGNED NOT NULL, PRIMARY KEY (singleton)) {$charset};",
        'zeroy_client_grants' => "CREATE TABLE " . zeroy_runtime_table('zeroy_client_grants') . " (grant_id CHAR(36) NOT NULL, grant_hash CHAR(64) NOT NULL, client_id VARCHAR(96) NOT NULL, client_label VARCHAR(96) NOT NULL, created_at DATETIME NOT NULL, last_used_at DATETIME NULL, revoked_at DATETIME NULL, PRIMARY KEY (grant_id), UNIQUE KEY zeroy_client_grant_hash (grant_hash), KEY zeroy_client_grant_client (client_id)) {$charset};",
        'zeroy_authorization_intents' => "CREATE TABLE " . zeroy_runtime_table('zeroy_authorization_intents') . " (intent_id CHAR(36) NOT NULL, site_id CHAR(36) NOT NULL, client_id VARCHAR(96) NOT NULL, redirect_uri VARCHAR(512) NOT NULL, code_challenge CHAR(64) NOT NULL, state VARCHAR(128) NOT NULL, expires_at DATETIME NOT NULL, consumed_at DATETIME NULL, created_at DATETIME NOT NULL, PRIMARY KEY (intent_id), KEY zeroy_auth_intent_site (site_id), KEY zeroy_auth_intent_expiry (expires_at)) {$charset};",
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
        'site_releases' => [
            // Existing releases are converted before a reader can select
            // them. These are nullable only at the transition boundary;
            // fresh tables retain the stricter CREATE TABLE definition.
            'commit_hash' => 'VARCHAR(71) NULL',
            'previous_release_id' => 'CHAR(36) NULL',
            'snapshot_hash' => 'CHAR(64) NULL',
            'snapshot_json' => 'LONGTEXT NULL',
            'build_id' => 'VARCHAR(71) NULL',
            'review_brief_hash' => 'CHAR(64) NULL',
        ],
        'locale_overlay_heads' => [
            'published_at' => 'DATETIME NULL',
        ],
        'verification_proofs' => [
            'commit_hash' => 'VARCHAR(71) NULL',
            'build_id' => 'VARCHAR(71) NULL',
        ],
    ];
}

/**
 * Legacy mutable authoring tables have no compatibility reader. They contain
 * no published fact, so the SiteCheckout hard cut discards them.
 */
function zeroy_runtime_drop_legacy_authoring_storage(): true|WP_Error
{
    global $wpdb;
    foreach (['site_draft_commands', 'site_draft_workspace', 'site_draft_blobs', 'site_drafts'] as $name) {
        $table = zeroy_runtime_table($name);
        if (zeroy_runtime_table_exists($table) && $wpdb->query("DROP TABLE {$table}") === false) {
            return zeroy_runtime_error(
                'zeroy_site_checkout_storage_hard_cut_failed',
                $wpdb->last_error ?: "Could not replace legacy {$name} storage.",
                500,
                ['table' => $name],
            );
        }
    }
    return true;
}

/**
 * The former storage root sat under wp-content and was directly web-readable.
 * Move the whole zeroY-owned tree, not individual artifact kinds: an artifact,
 * its archive, staging residue, and a SiteLogic artifact must share one access
 * boundary. A collision with different bytes is corruption, never a reason to
 * silently prefer one copy.
 */
function zeroy_runtime_copy_storage_tree(string $source, string $destination): true|WP_Error
{
    $source = wp_normalize_path($source);
    $destination = wp_normalize_path($destination);
    if (!is_dir($source) || is_link($source)) {
        return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage is not one regular directory.', 500);
    }
    if (!wp_mkdir_p($destination)) {
        return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not create private zeroY storage.', 500);
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    foreach ($iterator as $entry) {
        if (!$entry instanceof SplFileInfo || $entry->isLink()) {
            return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage contains a symlink or invalid entry.', 500);
        }
        $absolute = wp_normalize_path($entry->getPathname());
        $relative = ltrim(substr($absolute, strlen(rtrim($source, '/'))), '/');
        if ($relative === '' || str_contains($relative, '..')) {
            return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage has an unsafe path.', 500);
        }
        $target = $destination . '/' . $relative;
        if ($entry->isDir()) {
            if (!wp_mkdir_p($target)) return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not create migrated zeroY storage directory.', 500, ['path' => $relative]);
            continue;
        }
        if (!$entry->isFile()) return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage contains a non-file entry.', 500, ['path' => $relative]);
        if (!wp_mkdir_p(dirname($target))) return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not create migrated zeroY storage directory.', 500, ['path' => $relative]);
        if (is_file($target)) {
            $source_hash = hash_file('sha256', $absolute);
            $target_hash = hash_file('sha256', $target);
            if (!is_string($source_hash) || !is_string($target_hash) || !hash_equals($source_hash, $target_hash)) {
                return zeroy_runtime_error('zeroy_private_storage_migration_collision', 'Private zeroY storage has different bytes at one immutable path.', 500, ['path' => $relative]);
            }
            continue;
        }
        $staging = $target . '.migrating-' . wp_generate_uuid4();
        if (!copy($absolute, $staging) || !rename($staging, $target)) {
            if (is_file($staging)) unlink($staging);
            return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not copy one zeroY storage file into private storage.', 500, ['path' => $relative]);
        }
        chmod($target, $entry->isExecutable() ? 0555 : 0444);
    }
    return true;
}

function zeroy_runtime_remove_storage_tree(string $directory): true|WP_Error
{
    $directory = wp_normalize_path($directory);
    if (!is_dir($directory) || is_link($directory)) return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage cannot be removed safely.', 500);
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($iterator as $entry) {
        if (!$entry instanceof SplFileInfo || $entry->isLink()) return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage contains a symlink or invalid entry.', 500);
        $removed = $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
        if (!$removed) return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not remove public zeroY storage after private migration.', 500, ['path' => $entry->getPathname()]);
    }
    return rmdir($directory)
        ? true
        : zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not remove the public zeroY storage root after private migration.', 500);
}

function zeroy_runtime_migrate_private_storage(): true|WP_Error
{
    $legacy = zeroy_runtime_legacy_public_storage_root();
    $private = zeroy_runtime_private_storage_root();
    if ($legacy === $private || !is_dir($legacy)) return true;
    if (is_link($legacy)) return zeroy_runtime_error('zeroy_private_storage_migration_invalid', 'Legacy zeroY storage must not be a symlink.', 500);
    if (!is_dir($private)) {
        if (!wp_mkdir_p(dirname($private))) return zeroy_runtime_error('zeroy_private_storage_migration_failed', 'Could not create the private zeroY storage parent.', 500);
        if (@rename($legacy, $private)) return true;
    }
    $copied = zeroy_runtime_copy_storage_tree($legacy, $private);
    if (is_wp_error($copied)) return $copied;
    return zeroy_runtime_remove_storage_tree($legacy);
}

function zeroy_runtime_private_storage_current(): bool
{
    return !is_dir(zeroy_runtime_legacy_public_storage_root());
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

function zeroy_runtime_ensure_site_release_commit_identity(): true|WP_Error
{
    global $wpdb;
    $table = zeroy_runtime_table('site_releases');
    $indexes = $wpdb->get_results("SHOW INDEX FROM {$table}", ARRAY_A);
    $obsolete_commit_identity_exists = false;
    $build_identity_exists = false;
    foreach (is_array($indexes) ? $indexes : [] as $index) {
        $name = $index['Key_name'] ?? $index['key_name'] ?? null;
        if ($name === 'zeroy_site_release_build_identity' && (int) ($index['Non_unique'] ?? $index['non_unique'] ?? 1) === 0) $build_identity_exists = true;
        if ($name === 'zeroy_site_release_commit' && (int) ($index['Non_unique'] ?? $index['non_unique'] ?? 1) === 0) $obsolete_commit_identity_exists = true;
    }
    if ($obsolete_commit_identity_exists) {
        $wpdb->query("ALTER TABLE {$table} DROP INDEX zeroy_site_release_commit");
        if ($wpdb->query("ALTER TABLE {$table} ADD KEY zeroy_site_release_commit (commit_hash)") === false) return zeroy_runtime_error('zeroy_site_release_commit_identity_failed', $wpdb->last_error ?: 'Could not replace the obsolete SiteCommit uniqueness boundary.', 500);
    }
    if ($build_identity_exists) return true;
    $added = $wpdb->query("ALTER TABLE {$table} ADD UNIQUE KEY zeroy_site_release_build_identity (commit_hash, build_id)");
    return $added === false ? zeroy_runtime_error('zeroy_site_release_commit_identity_failed', $wpdb->last_error ?: 'Could not enforce one SiteRelease per SiteCommit and BuildResult.', 500) : true;
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
    return true;
}

/**
 * Preview lifecycle names are data, not an implementation detail. A legacy
 * VARCHAR(16) state column can silently truncate `preview-awaiting-browser`
 * on permissive MySQL installations, then make the exact-state CAS fail.
 */
function zeroy_runtime_ensure_site_release_state_width(): true|WP_Error
{
    global $wpdb;
    $table = zeroy_runtime_table('site_releases');
    // SQLite has no VARCHAR length enforcement. The actual invariant is that
    // every lifecycle value is storable without truncation, which it already
    // provides; attempting MySQL's MODIFY form there turns an otherwise valid
    // upgrade into a runtime failure.
    if (zeroy_runtime_uses_sqlite()) {
        return zeroy_runtime_table_column_exists($table, 'state')
            ? true
            : zeroy_runtime_error('zeroy_site_release_state_missing', 'SiteRelease storage has no state column.', 500);
    }
    $columns = $wpdb->get_results('DESCRIBE ' . $table, ARRAY_A);
    foreach (is_array($columns) ? $columns : [] as $column) {
        if (($column['Field'] ?? null) !== 'state') continue;
        if (preg_match('/varchar\((\d+)\)/i', (string) ($column['Type'] ?? ''), $matches) !== 1 || (int) $matches[1] < 24) {
            $updated = $wpdb->query("ALTER TABLE {$table} MODIFY state VARCHAR(32) NOT NULL");
            return $updated === false
                ? zeroy_runtime_error('zeroy_site_release_state_width_failed', $wpdb->last_error ?: 'Could not widen SiteRelease state storage.', 500)
                : true;
        }
        return true;
    }
    return zeroy_runtime_error('zeroy_site_release_state_missing', 'SiteRelease storage has no state column.', 500);
}

function zeroy_runtime_site_release_state_width_current(): bool
{
    global $wpdb;
    if (zeroy_runtime_uses_sqlite()) return zeroy_runtime_table_column_exists(zeroy_runtime_table('site_releases'), 'state');
    foreach ((array) $wpdb->get_results('DESCRIBE ' . zeroy_runtime_table('site_releases'), ARRAY_A) as $column) {
        if (($column['Field'] ?? null) !== 'state') continue;
        return preg_match('/varchar\((\d+)\)/i', (string) ($column['Type'] ?? ''), $matches) === 1 && (int) $matches[1] >= 24;
    }
    return false;
}

/**
 * Old candidate states encoded an Agent-controlled automatic activation flow.
 * They have no public meaning and are deliberately retired at the hard cut;
 * active and superseded releases remain the sole public history.
 */
function zeroy_runtime_hard_cut_candidate_release_states(): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->query(
        "UPDATE " . zeroy_runtime_table('site_releases') . " SET state = 'discarded' WHERE state IN ('preparing', 'awaiting-browser', 'prepared', 'failed')",
    );
    return $updated === false
        ? zeroy_runtime_error('zeroy_site_review_release_state_hard_cut_failed', $wpdb->last_error ?: 'Could not retire obsolete candidate releases.', 500)
        : true;
}

function zeroy_runtime_install_schema(): true|WP_Error
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $hard_cut = zeroy_runtime_drop_legacy_authoring_storage();
    if (is_wp_error($hard_cut)) return $hard_cut;
    foreach (zeroy_runtime_schema_definitions() as $name => $sql) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) dbDelta($sql);
    }
    $migration = zeroy_runtime_migrate_schema_columns();
    if (is_wp_error($migration)) return $migration;
    $state_width = zeroy_runtime_ensure_site_release_state_width();
    if (is_wp_error($state_width)) return $state_width;
    $commit_identity = zeroy_runtime_ensure_site_release_commit_identity();
    if (is_wp_error($commit_identity)) return $commit_identity;
    $candidate_state_hard_cut = zeroy_runtime_hard_cut_candidate_release_states();
    if (is_wp_error($candidate_state_hard_cut)) return $candidate_state_hard_cut;
    foreach (['content', 'site-release'] as $lock) {
        $wpdb->query($wpdb->prepare('INSERT IGNORE INTO ' . zeroy_runtime_table('runtime_locks') . ' (lock_name, revision) VALUES (%s, 0)', $lock));
    }
    return true;
}

function zeroy_runtime_schema_is_current(): bool
{
    if (!zeroy_runtime_private_storage_current()) return false;
    foreach (array_keys(zeroy_runtime_schema_definitions()) as $name) {
        if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) return false;
    }
    foreach (zeroy_runtime_required_schema_columns() as $table => $columns) {
        foreach (array_keys($columns) as $column) {
            if (!zeroy_runtime_table_column_exists(zeroy_runtime_table($table), $column)) return false;
        }
    }
    if (!zeroy_runtime_site_release_state_width_current()) return false;
    $active = zeroy_runtime_active_site_release();
    if ($active === null || is_wp_error(zeroy_runtime_site_release_snapshot($active))) return $active === null;
    $commit = is_string($active['commit_hash'] ?? null) ? zeroy_checkout_commit_row($active['commit_hash']) : null;
    $proof_row = is_string($active['proof_id'] ?? null) ? zeroy_runtime_site_release_proof_row($active['proof_id']) : null;
    $proof = is_array($proof_row) ? zeroy_runtime_decode_json((string) $proof_row['proof_json']) : null;
    return is_array($commit) && is_array($proof) && zeroy_runtime_site_release_proof_valid($active, $proof);
}

function zeroy_runtime_record_upgrade_error(WP_Error $error): void
{
    update_option('zeroy_runtime_upgrade_error', ['code' => $error->get_error_code(), 'message' => $error->get_error_message()], false);
}

function zeroy_runtime_initialize(): true|WP_Error
{
    $schema = zeroy_runtime_install_schema();
    if (is_wp_error($schema)) return $schema;
    $storage = zeroy_runtime_migrate_private_storage();
    if (is_wp_error($storage)) return $storage;
    zeroy_runtime_register_preview_capability();
    $shell = zeroy_runtime_enforce_stable_shell();
    if (is_wp_error($shell)) return $shell;
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
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
