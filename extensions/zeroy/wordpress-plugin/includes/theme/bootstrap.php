<?php

defined('ABSPATH') || exit;

function zeroy_runtime_install_stable_shell(): true|WP_Error
{
    $source = dirname(__DIR__, 2) . '/stable-shell';
    $target = get_theme_root() . '/zeroy-shell';
    if (!wp_mkdir_p($target)) {
        return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not create the zeroY Stable Shell theme.', 500);
    }
    foreach (['style.css', 'functions.php', 'index.php'] as $file) {
        $from = $source . '/' . $file;
        $to = $target . '/' . $file;
        if (is_file($to) && hash_equals((string) hash_file('sha256', $from), (string) hash_file('sha256', $to))) {
            chmod($to, 0444);
            continue;
        }
        if (is_file($to) && !chmod($to, 0644)) {
            return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not update the zeroY Stable Shell theme.', 500, ['path' => $file]);
        }
        if (!copy($from, $to)) {
            return zeroy_runtime_error('zeroy_shell_install_failed', 'Could not install the zeroY Stable Shell theme.', 500, ['path' => $file]);
        }
        chmod($to, 0444);
    }
    return true;
}

function zeroy_runtime_import_initial_theme(string $theme_root): array|WP_Error
{
    $manifest = zeroy_runtime_scan_theme_tree($theme_root);
    if (is_wp_error($manifest)) {
        return $manifest;
    }
    $artifact_id = zeroy_runtime_manifest_artifact_id($manifest);
    $schema = zeroy_runtime_schema_diagnostics_from_path($theme_root . '/zeroy.schema.json', $theme_root);
    if (!$schema['valid']) {
        return zeroy_runtime_error('zeroy_artifact_schema_invalid', 'Initial ThemeArtifact has an invalid ThemeSchema.', 409, ['violations' => $schema['errors']]);
    }
    $storage = zeroy_runtime_ensure_artifact_directories();
    if (is_wp_error($storage)) {
        return $storage;
    }
    $directory = zeroy_runtime_artifact_directory($artifact_id);
    if (!is_dir($directory)) {
        $staging = zeroy_runtime_staging_root() . '/' . wp_generate_uuid4();
        $copied = zeroy_runtime_copy_manifest_tree($theme_root, $staging, $manifest);
        if (is_wp_error($copied) || !rename($staging, $directory)) {
            return is_wp_error($copied) ? $copied : zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not atomically materialize the initial ThemeArtifact.', 500);
        }
    }
    global $wpdb;
    $bytes = array_sum(array_column($manifest['entries'], 'bytes'));
    $wpdb->replace(zeroy_runtime_table('theme_artifacts'), [
        'artifact_id' => $artifact_id,
        'manifest_json' => zeroy_runtime_json($manifest),
        'schema_json' => zeroy_runtime_json($schema['schema']),
        'schema_hash' => $schema['contractHash'],
        'file_count' => count($manifest['entries']),
        'total_bytes' => $bytes,
        'created_at' => current_time('mysql', true),
    ], ['%s', '%s', '%s', '%s', '%d', '%d', '%s']);
    $archive = zeroy_runtime_build_artifact_archive($artifact_id);
    if (is_wp_error($archive)) {
        return $archive;
    }
    $deployment_id = wp_generate_uuid4();
    $now = current_time('mysql', true);
    $wpdb->insert(zeroy_runtime_table('theme_deployments'), [
        'deployment_id' => $deployment_id,
        'artifact_id' => $artifact_id,
        'expected_active_artifact_id' => null,
        'state' => 'active',
        'provenance_json' => zeroy_runtime_json(['message' => 'Initial active theme import']),
        'diagnostics_json' => zeroy_runtime_json(['ok' => true, 'source' => 'initial-import']),
        'created_at' => $now,
        'activated_at' => $now,
    ], ['%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s']);
    $wpdb->replace(zeroy_runtime_table('theme_state'), [
        'singleton' => 1,
        'active_deployment_id' => $deployment_id,
        'revision' => 1,
        'activated_at' => $now,
    ], ['%d', '%s', '%d', '%s']);
    return ['artifactId' => $artifact_id, 'deploymentId' => $deployment_id];
}

function zeroy_runtime_bootstrap_theme_deployment(): true|WP_Error
{
    if (zeroy_runtime_active_theme_state() !== null) {
        return true;
    }
    if (get_stylesheet() === 'zeroy-shell') {
        return zeroy_runtime_error('zeroy_initial_artifact_missing', 'Stable Shell is active without an initial ThemeArtifact.', 500);
    }
    $imported = zeroy_runtime_import_initial_theme(get_stylesheet_directory());
    if (is_wp_error($imported)) {
        return $imported;
    }
    $shell = zeroy_runtime_install_stable_shell();
    if (is_wp_error($shell)) {
        return $shell;
    }
    switch_theme('zeroy-shell');
    return true;
}

function zeroy_runtime_hard_cut_migrate_active_artifact_schema(): true|WP_Error
{
    $active = zeroy_runtime_active_theme_state();
    if ($active === null) {
        return true;
    }
    $artifact_id = (string) $active['artifact_id'];
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    if ($artifact === null) {
        return zeroy_runtime_error('zeroy_active_artifact_missing', 'The active ThemeArtifact metadata is unavailable.', 500);
    }
    $current = zeroy_runtime_decode_json((string) $artifact['schema_json']);
    if (!is_wp_error($current) && (string) $artifact['schema_hash'] === zeroy_runtime_hash($current)) {
        return true;
    }
    $diagnostics = zeroy_runtime_schema_diagnostics_from_path(
        zeroy_runtime_artifact_directory($artifact_id) . '/zeroy.schema.json',
        zeroy_runtime_artifact_directory($artifact_id)
    );
    if (!$diagnostics['valid']) {
        return zeroy_runtime_error(
            'zeroy_active_artifact_schema_invalid',
            'The active ThemeArtifact cannot be migrated because its ThemeSchema is invalid.',
            409,
            ['violations' => $diagnostics['errors']]
        );
    }
    global $wpdb;
    $updated = $wpdb->update(
        zeroy_runtime_table('theme_artifacts'),
        ['schema_json' => zeroy_runtime_json($diagnostics['schema']), 'schema_hash' => $diagnostics['contractHash']],
        ['artifact_id' => $artifact_id],
        ['%s', '%s'],
        ['%s']
    );
    return $updated === 1
        ? true
        : zeroy_runtime_error('zeroy_active_artifact_schema_migration_failed', $wpdb->last_error ?: 'Could not migrate the active ThemeArtifact schema snapshot.', 500);
}

function zeroy_runtime_maybe_bootstrap_theme_deployment(): void
{
    $bootstrap = zeroy_runtime_bootstrap_theme_deployment();
    if (is_wp_error($bootstrap)) {
        update_option('zeroy_runtime_bootstrap_error', [
            'code' => $bootstrap->get_error_code(),
            'message' => $bootstrap->get_error_message(),
        ], false);
        return;
    }
    delete_option('zeroy_runtime_bootstrap_error');
}
add_action('wp_loaded', 'zeroy_runtime_maybe_bootstrap_theme_deployment', 1);
