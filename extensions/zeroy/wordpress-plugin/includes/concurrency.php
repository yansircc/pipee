<?php

/** Transaction and lease mechanism shared by independent runtime owners. */

defined('ABSPATH') || exit;

function zeroy_runtime_transaction(callable $operation): mixed
{
    global $wpdb;
    static $depth = 0;
    if ($depth > 0) {
        return $operation();
    }
    if ($wpdb->query('START TRANSACTION') === false) {
        return zeroy_runtime_error('zeroy_transaction_unavailable', 'Could not begin the zeroY runtime transaction.', 500);
    }
    $depth = 1;
    try {
        $result = $operation();
        if (is_wp_error($result)) {
            $depth = 0;
            $wpdb->query('ROLLBACK');
            return $result;
        }
        $depth = 0;
        if ($wpdb->query('COMMIT') === false) {
            $wpdb->query('ROLLBACK');
            return zeroy_runtime_error('zeroy_transaction_commit_failed', 'Could not commit the zeroY runtime transaction.', 500);
        }
        return $result;
    } catch (Throwable $error) {
        $depth = 0;
        $wpdb->query('ROLLBACK');
        return zeroy_runtime_error('zeroy_transaction_failed', $error->getMessage(), 500);
    }
}

function zeroy_runtime_acquire_lease(string $name, string $error_code, string $description): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->query(
        $wpdb->prepare('UPDATE ' . zeroy_runtime_table('runtime_locks') . ' SET revision = revision + 1 WHERE lock_name = %s', $name)
    );
    return $updated === 1
        ? true
        : zeroy_runtime_error($error_code, $wpdb->last_error ?: "Could not acquire the {$description} lease.", 500);
}

function zeroy_runtime_acquire_content_lease(): true|WP_Error
{
    return zeroy_runtime_acquire_lease('content', 'zeroy_content_lease_unavailable', 'content');
}

/**
 * DDL-backed SiteLogic migrations cannot participate in an SQL transaction:
 * MySQL commits around ALTER TABLE/dbDelta.  The advisory lock therefore owns
 * the whole commit corridor (candidate migration then active-pointer CAS),
 * while the pointer/content mutation itself remains transactional.
 */
function zeroy_runtime_with_site_release_lock(callable $operation): mixed
{
    global $wpdb;
    // The SQLite adapter implements DDL transactionally but has no
    // MySQL advisory-lock functions. The same runtime lock is therefore the
    // transaction itself. MySQL needs GET_LOCK because its DDL commits an SQL
    // transaction implicitly.
    if (get_class($wpdb) === 'WP_SQLite_DB') return zeroy_runtime_transaction($operation);
    $database = defined('DB_NAME') ? (string) DB_NAME : '';
    $lock_name = 'zeroy-release-' . substr(hash('sha256', $database . '|' . $wpdb->prefix), 0, 40);
    $locked = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $lock_name, 30));
    if ((string) $locked !== '1') {
        return zeroy_runtime_error('zeroy_site_release_lock_unavailable', $wpdb->last_error ?: 'Could not acquire the SiteRelease commit lock.', 409);
    }
    try {
        return $operation();
    } finally {
        $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
    }
}
