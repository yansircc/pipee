<?php

/** Transaction and lease mechanism shared by independent runtime owners. */

defined('ABSPATH') || exit;

function zeroy_runtime_transaction(callable $operation): mixed
{
    global $wpdb;
    if ($wpdb->query('START TRANSACTION') === false) {
        return zeroy_runtime_error('zeroy_transaction_unavailable', 'Could not begin the zeroY runtime transaction.', 500);
    }
    try {
        $result = $operation();
        if (is_wp_error($result)) {
            $wpdb->query('ROLLBACK');
            return $result;
        }
        if ($wpdb->query('COMMIT') === false) {
            $wpdb->query('ROLLBACK');
            return zeroy_runtime_error('zeroy_transaction_commit_failed', 'Could not commit the zeroY runtime transaction.', 500);
        }
        return $result;
    } catch (Throwable $error) {
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
