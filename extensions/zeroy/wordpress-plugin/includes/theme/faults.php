<?php

defined('ABSPATH') || exit;

/**
 * Test-only fault seam for proving activation atomicity. Production has no
 * configured faults; only an in-process test can provide a WP_Error.
 */
function zeroy_runtime_theme_deployment_fault(string $phase): ?WP_Error
{
    $fault = apply_filters('zeroy_runtime_theme_deployment_fault', null, $phase);
    return is_wp_error($fault) ? $fault : null;
}

function zeroy_runtime_fail_if_theme_deployment_fault(string $phase): true|WP_Error
{
    return zeroy_runtime_theme_deployment_fault($phase) ?? true;
}
