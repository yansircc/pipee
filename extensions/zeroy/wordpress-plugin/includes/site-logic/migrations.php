<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_logic_migration_plan(array $contract, int $from_epoch): array|WP_Error
{
    $to_epoch = (int) $contract['storageEpoch'];
    if ($to_epoch < $from_epoch) return zeroy_runtime_error('zeroy_storage_epoch_rollback_forbidden', 'SiteLogic storageEpoch cannot move backwards.', 409, ['activeEpoch' => $from_epoch, 'candidateEpoch' => $to_epoch]);
    if ($to_epoch === $from_epoch) return [];
    $migrations = $contract['migrations'] ?? [];
    $planned = [];
    $cursor = $from_epoch;
    while ($cursor < $to_epoch) {
        $next = null;
        foreach ($migrations as $migration) {
            if (($migration['fromEpoch'] ?? null) === $cursor) {
                $next = $migration;
                break;
            }
        }
        if ($next === null) return zeroy_runtime_error('zeroy_site_logic_migration_missing', 'Candidate storageEpoch has no complete additive migration chain.', 409, ['fromEpoch' => $from_epoch, 'toEpoch' => $to_epoch]);
        $planned[] = $next;
        $cursor = $next['toEpoch'];
    }
    return $planned;
}

function zeroy_runtime_site_logic_table_name(string $name): string
{
    global $wpdb;
    return $wpdb->prefix . 'zeroy_site_logic_' . $name;
}

function zeroy_runtime_site_logic_column_sql(array $column): string|WP_Error
{
    $name = $column['name'] ?? null;
    $type = $column['type'] ?? null;
    if (!is_string($name) || !preg_match('/\A[a-z][a-z0-9_]{0,63}\z/', $name) || $name === 'id' || !is_string($type)) return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Migration columns need a safe non-id name and type.', 400);
    $types = ['bigint' => 'BIGINT UNSIGNED', 'text' => 'LONGTEXT', 'datetime' => 'DATETIME', 'boolean' => 'TINYINT(1)', 'varchar' => 'VARCHAR(191)'];
    if (!isset($types[$type])) return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Migration column type is not additive-safe.', 400, ['type' => $type]);
    return '`' . $name . '` ' . $types[$type] . (($column['nullable'] ?? false) === true ? ' NULL' : ' NOT NULL');
}

function zeroy_runtime_site_logic_table_columns(string $table): array|WP_Error
{
    global $wpdb;
    $rows = $wpdb->get_results('DESCRIBE ' . $table, ARRAY_A);
    if (!is_array($rows)) return zeroy_runtime_error('zeroy_site_logic_migration_verify_failed', $wpdb->last_error ?: 'Could not inspect SiteLogic migration table.', 500);
    $columns = [];
    foreach ($rows as $row) if (is_string($row['Field'] ?? null)) $columns[$row['Field']] = true;
    return $columns;
}

function zeroy_runtime_verify_site_logic_migration(array $migration): true|WP_Error
{
    foreach ($migration['operations'] as $operation) {
        $name = $operation['table'] ?? null;
        if (!is_string($name) || !preg_match('/\A[a-z][a-z0-9_]{0,40}\z/', $name)) return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Migration operation table is invalid.', 400);
        $columns = zeroy_runtime_site_logic_table_columns(zeroy_runtime_site_logic_table_name($name));
        if (is_wp_error($columns)) return $columns;
        $required = ['id'];
        if (($operation['kind'] ?? null) === 'create-table') {
            foreach ($operation['columns'] as $column) $required[] = $column['name'] ?? '';
        } elseif (($operation['kind'] ?? null) === 'add-column') {
            $required[] = $operation['column']['name'] ?? '';
        }
        foreach ($required as $column) {
            if (!is_string($column) || !isset($columns[$column])) {
                return zeroy_runtime_error('zeroy_site_logic_migration_verify_failed', 'Additive migration postcondition failed: ' . trim((string) $migration['verify']), 500, ['table' => $name, 'column' => $column, 'idempotencyKey' => $migration['idempotencyKey']]);
            }
        }
    }
    return true;
}

function zeroy_runtime_apply_site_logic_migration(array $migration): true|WP_Error
{
    global $wpdb;
    $key = $migration['idempotencyKey'];
    $done = $wpdb->get_var($wpdb->prepare('SELECT idempotency_key FROM ' . zeroy_runtime_table('site_logic_migration_ledger') . ' WHERE idempotency_key = %s', $key));
    if ($done === $key) return zeroy_runtime_verify_site_logic_migration($migration);
    foreach ($migration['operations'] as $operation) {
        $table_name = $operation['table'] ?? null;
        if (!is_string($table_name) || !preg_match('/\A[a-z][a-z0-9_]{0,40}\z/', $table_name)) return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Migration operation table is invalid.', 400);
        $table = zeroy_runtime_site_logic_table_name($table_name);
        if (($operation['kind'] ?? null) === 'create-table') {
            $columns = ['`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT'];
            foreach ($operation['columns'] ?? [] as $column) {
                $sql = zeroy_runtime_site_logic_column_sql($column);
                if (is_wp_error($sql)) return $sql;
                $columns[] = $sql;
            }
            if (count($columns) === 1) return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Create-table migration needs columns.', 400);
            require_once ABSPATH . 'wp-admin/includes/upgrade.php';
            dbDelta('CREATE TABLE ' . $table . ' (' . implode(', ', $columns) . ', PRIMARY KEY (`id`)) ' . $wpdb->get_charset_collate() . ';');
        } elseif (($operation['kind'] ?? null) === 'add-column') {
            $column = zeroy_runtime_site_logic_column_sql($operation['column'] ?? []);
            if (is_wp_error($column)) return $column;
            if ($wpdb->query('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column) === false && !str_contains(strtolower($wpdb->last_error), 'duplicate column')) return zeroy_runtime_error('zeroy_site_logic_migration_failed', $wpdb->last_error ?: 'Could not add SiteLogic column.', 500);
        } else {
            return zeroy_runtime_error('zeroy_site_logic_migration_invalid', 'Only additive create-table and add-column operations are supported.', 400);
        }
    }
    $verified = zeroy_runtime_verify_site_logic_migration($migration);
    if (is_wp_error($verified)) return $verified;
    return $wpdb->insert(zeroy_runtime_table('site_logic_migration_ledger'), ['idempotency_key' => $key, 'from_epoch' => $migration['fromEpoch'], 'to_epoch' => $migration['toEpoch'], 'applied_at' => current_time('mysql', true)]) === 1 ? true : zeroy_runtime_error('zeroy_site_logic_migration_ledger_failed', $wpdb->last_error ?: 'Could not record SiteLogic migration.', 500);
}

function zeroy_runtime_apply_site_logic_migrations(array $contract, ?array $active): array|WP_Error
{
    $from_epoch = $active === null ? 0 : (int) $active['storage_epoch'];
    $plan = zeroy_runtime_site_logic_migration_plan($contract, $from_epoch);
    if (is_wp_error($plan)) return $plan;
    foreach ($plan as $migration) {
        $applied = zeroy_runtime_apply_site_logic_migration($migration);
        if (is_wp_error($applied)) return $applied;
    }
    return ['fromEpoch' => $from_epoch, 'toEpoch' => (int) $contract['storageEpoch'], 'migrations' => array_map(static fn(array $migration): string => $migration['idempotencyKey'], $plan)];
}

function zeroy_runtime_site_logic_migration_history(int $limit = 50): array
{
    global $wpdb;
    $limit = min(100, max(1, $limit));
    $rows = $wpdb->get_results('SELECT idempotency_key, from_epoch, to_epoch, applied_at FROM ' . zeroy_runtime_table('site_logic_migration_ledger') . ' ORDER BY applied_at DESC LIMIT ' . $limit, ARRAY_A);
    return ['contract' => 'zeroy/site-logic-migration-history@1', 'migrations' => is_array($rows) ? array_map(static fn(array $row): array => ['idempotencyKey' => $row['idempotency_key'], 'fromEpoch' => (int) $row['from_epoch'], 'toEpoch' => (int) $row['to_epoch'], 'appliedAt' => $row['applied_at']], $rows) : []];
}
