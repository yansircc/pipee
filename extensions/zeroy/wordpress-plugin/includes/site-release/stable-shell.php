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

/**
 * The Stable Shell is the only WordPress theme host. ThemeArtifacts are
 * immutable request-pinned payloads and must never become independently
 * selectable WordPress themes.
 */
function zeroy_runtime_enforce_stable_shell(): true|WP_Error
{
    // The plugin source is the single shell owner; the WordPress theme folder
    // is a derived projection installed only by activation/upgrade. Theme
    // selection happens before ordinary plugins load, so a plugin-owned theme
    // directory cannot be registered safely at request time.
    $installed = zeroy_runtime_install_stable_shell();
    if (is_wp_error($installed)) return $installed;
    if (get_stylesheet() !== 'zeroy-shell' || get_template() !== 'zeroy-shell') {
        switch_theme('zeroy-shell');
    }
    return get_stylesheet() === 'zeroy-shell' && get_template() === 'zeroy-shell'
        ? true
        : zeroy_runtime_error('zeroy_shell_activation_failed', 'zeroY Stable Shell could not become the WordPress theme host.', 500);
}
