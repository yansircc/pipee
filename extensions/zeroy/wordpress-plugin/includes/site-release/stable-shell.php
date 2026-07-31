<?php

defined('ABSPATH') || exit;

function zeroy_runtime_install_stable_shell(): true|WP_Error
{
    $source = dirname(__DIR__, 2) . '/stable-shell';
    $target = get_theme_root() . '/zeroy-shell';
    if (!wp_mkdir_p($target)) return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not create zeroY Stable Shell.', 500);
    foreach (['style.css', 'functions.php', 'index.php'] as $file) {
        $from = $source . '/' . $file;
        $to = $target . '/' . $file;
        if (!is_file($from)) return zeroy_runtime_error('zeroy_shell_install_failed', 'Stable Shell source is incomplete.', 500, ['path' => $file]);
        if (is_file($to) && !chmod($to, 0644)) return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not update zeroY Stable Shell.', 500, ['path' => $file]);
        if (!copy($from, $to)) return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not install zeroY Stable Shell.', 500, ['path' => $file]);
        chmod($to, 0444);
    }
    return true;
}
