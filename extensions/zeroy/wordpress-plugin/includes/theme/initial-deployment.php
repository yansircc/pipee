<?php

defined('ABSPATH') || exit;

/**
 * Creates the first immutable ThemeDeployment for a site that has not yet
 * adopted the Stable Shell. Legacy LocaleVersion/ThemeCopy facts are consumed
 * exactly once by the migration writer during the activation transaction.
 */
function zeroy_runtime_bootstrap_required(): bool
{
    return zeroy_runtime_active_theme_state() === null && get_stylesheet() !== 'zeroy-shell';
}

function zeroy_runtime_activate_stable_shell_options(): true|WP_Error
{
    $values = ['stylesheet' => 'zeroy-shell', 'template' => 'zeroy-shell', 'current_theme' => 'zeroY Stable Shell'];
    foreach ($values as $name => $value) {
        if (get_option($name) !== $value && !update_option($name, $value)) {
            return zeroy_runtime_error('zeroy_shell_activation_failed', 'Could not make the zeroY Stable Shell the active WordPress theme.', 500, ['option' => $name]);
        }
    }
    return true;
}

function zeroy_runtime_bootstrap_theme_deployment_from_artifact(string $artifact_id, array $provenance): array|WP_Error
{
    if (zeroy_runtime_active_theme_state() !== null) {
        return zeroy_runtime_error('zeroy_theme_bootstrap_unavailable', 'A ThemeDeployment is already active.', 409);
    }
    if (!zeroy_runtime_bootstrap_required()) {
        return zeroy_runtime_error('zeroy_theme_bootstrap_unavailable', 'Stable Shell is active without a recoverable ThemeDeployment.', 409);
    }
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    if ($artifact === null || !is_dir(zeroy_runtime_artifact_directory($artifact_id))) {
        return zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact does not exist.', 404);
    }
    $integrity = zeroy_runtime_artifact_integrity($artifact_id);
    if (is_wp_error($integrity) || ($integrity['ok'] ?? false) !== true) {
        return zeroy_runtime_error('zeroy_artifact_corrupt', 'ThemeBootstrap requires an intact uploaded ThemeArtifact.', 409);
    }
    $php = zeroy_runtime_artifact_php_diagnostics($artifact_id);
    $schema = zeroy_runtime_schema_diagnostics_from_path(zeroy_runtime_artifact_directory($artifact_id) . '/zeroy.schema.json', zeroy_runtime_artifact_directory($artifact_id));
    $diagnostics = ['php' => $php, 'schema' => $schema['errors'] ?? []];
    if ($php !== [] || !$schema['valid']) {
        return zeroy_runtime_create_failed_deployment($artifact_id, null, $provenance, $diagnostics);
    }
    $plan = zeroy_runtime_plan_theme_deployment($schema['schema']);
    $diagnostics['migrationPlan'] = $plan;
    $legacy_plan = zeroy_localization_legacy_migration_plan($schema['schema']);
    $diagnostics['legacyMigrationPlan'] = $legacy_plan;
    if (!$plan['ok'] || !$legacy_plan['ok']) {
        return zeroy_runtime_create_failed_deployment($artifact_id, null, $provenance, $diagnostics);
    }
    $shell = zeroy_runtime_install_stable_shell();
    if (is_wp_error($shell)) {
        return $shell;
    }

    $result = zeroy_runtime_transaction(function () use ($artifact_id, $provenance, $schema, $diagnostics) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_theme_deployment_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        if (zeroy_runtime_active_theme_state() !== null) {
            return zeroy_runtime_error('zeroy_theme_bootstrap_unavailable', 'A ThemeDeployment became active during bootstrap.', 409);
        }
        $artifact = zeroy_runtime_artifact_row($artifact_id);
        if ($artifact === null) {
            return zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact disappeared during bootstrap.', 409);
        }
        if ($wpdb->update(zeroy_runtime_table('theme_artifacts'), ['schema_json' => zeroy_runtime_json($schema['schema']), 'schema_hash' => $schema['contractHash']], ['artifact_id' => $artifact_id]) !== 1) {
            return zeroy_runtime_error('zeroy_theme_bootstrap_failed', 'Could not attach the candidate ThemeSchema to the bootstrap Artifact.', 500);
        }
        $migration = zeroy_localization_apply_legacy_migration($schema['schema']);
        if (is_wp_error($migration)) {
            return $migration;
        }
        $deployment_id = wp_generate_uuid4();
        $now = current_time('mysql', true);
        $written = $wpdb->insert(zeroy_runtime_table('theme_deployments'), [
            'deployment_id' => $deployment_id,
            'artifact_id' => $artifact_id,
            'expected_active_artifact_id' => null,
            'state' => 'active',
            'provenance_json' => zeroy_runtime_json($provenance),
            'diagnostics_json' => zeroy_runtime_json([...$diagnostics, 'legacyMigrationResult' => $migration]),
            'created_at' => $now,
            'activated_at' => $now,
        ]);
        if ($written !== 1 || $wpdb->replace(zeroy_runtime_table('theme_state'), [
            'singleton' => 1,
            'active_deployment_id' => $deployment_id,
            'revision' => 1,
            'activated_at' => $now,
        ], ['%d', '%s', '%d', '%s']) === false) {
            return zeroy_runtime_error('zeroy_theme_bootstrap_failed', 'Could not write the first active ThemeDeployment.', 500);
        }
        $shell = zeroy_runtime_activate_stable_shell_options();
        if (is_wp_error($shell)) {
            return $shell;
        }
        return zeroy_runtime_theme_deployment_receipt($deployment_id);
    });
    if (!is_wp_error($result)) {
        zeroy_runtime_drop_removed_runtime_tables();
        wp_clean_themes_cache(true);
        flush_rewrite_rules(false);
    }
    return $result;
}
