<?php

/** Transaction and lease mechanism shared by independent runtime owners. */

defined('ABSPATH') || exit;

/**
 * SQLite is a storage capability boundary, not a SiteRelease policy.  The
 * adapter accepts VARCHAR(n) syntax but does not enforce its length and lacks
 * several MySQL DDL/locking operations, so every dialect-specific mechanism
 * must derive from this one fact.
 */
function zeroy_runtime_uses_sqlite(): bool
{
    global $wpdb;
    return is_object($wpdb) && is_a($wpdb, 'WP_SQLite_DB');
}

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

function zeroy_runtime_with_process_file_lock(string $name, string $error_code, string $description, callable $operation): mixed
{
    if (preg_match('/\A[a-z0-9-]+\z/', $name) !== 1) return zeroy_runtime_error($error_code, "Invalid {$description} lock identity.", 500);
    $directory = zeroy_runtime_private_storage_root() . '/locks';
    if (!wp_mkdir_p($directory)) return zeroy_runtime_error($error_code, "Could not create the {$description} lock directory.", 500);
    $handle = fopen($directory . '/' . $name . '.lock', 'c');
    if (!is_resource($handle) || !flock($handle, LOCK_EX)) {
        if (is_resource($handle)) fclose($handle);
        return zeroy_runtime_error($error_code, "Could not acquire the {$description} file lock.", 409);
    }
    try {
        return $operation();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
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
    // Candidate verification crosses into a second HTTP request. A SQLite
    // transaction would hide the candidate row from that verifier, so SQLite
    // uses one process-safe file lease for the whole corridor. The actual
    // content/pointer mutation still opens its own SQL transaction.
    if (zeroy_runtime_uses_sqlite()) {
        return zeroy_runtime_with_process_file_lock('site-release', 'zeroy_site_release_lock_unavailable', 'SiteRelease', $operation);
    }
    // MySQL needs GET_LOCK because its DDL commits an SQL transaction
    // implicitly.
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
