<?php

defined('ABSPATH') || exit;

function zeroy_runtime_acquire_theme_deployment_lease(): true|WP_Error
{
    return zeroy_runtime_acquire_lease('theme-deployment', 'zeroy_theme_deployment_lease_unavailable', 'ThemeDeployment');
}

function zeroy_runtime_artifact_php_diagnostics(string $artifact_id): array
{
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    $manifest = $artifact === null ? null : zeroy_runtime_decode_json((string) $artifact['manifest_json']);
    if (!is_array($manifest['entries'] ?? null)) {
        return [['code' => 'artifact_manifest_invalid', 'message' => 'ThemeArtifact manifest is invalid.']];
    }
    $errors = [];
    foreach ($manifest['entries'] as $entry) {
        if (!is_string($entry['path'] ?? null) || !str_ends_with($entry['path'], '.php')) {
            continue;
        }
        $path = zeroy_runtime_artifact_directory($artifact_id) . '/' . $entry['path'];
        $lint = zeroy_runtime_php_lint($path);
        if ($lint !== null) {
            $errors[] = [...$lint, 'path' => $entry['path']];
        }
    }
    return $errors;
}

function zeroy_runtime_plan_theme_deployment(array $schema): array
{
    $reconciliation = zeroy_localization_plan_overlay_reconciliation($schema);
    $route_conflicts = zeroy_runtime_collection_route_conflicts($schema);
    return [...$reconciliation, 'routeConflicts' => $route_conflicts, 'ok' => $reconciliation['ok'] && $route_conflicts === []];
}

function zeroy_runtime_create_failed_deployment(string $artifact_id, ?string $expected_active_artifact_id, array $provenance, array $diagnostics): array|WP_Error
{
    global $wpdb;
    $id = wp_generate_uuid4();
    $written = $wpdb->insert(zeroy_runtime_table('theme_deployments'), ['deployment_id' => $id, 'artifact_id' => $artifact_id, 'expected_active_artifact_id' => $expected_active_artifact_id, 'state' => 'failed', 'provenance_json' => zeroy_runtime_json($provenance), 'diagnostics_json' => zeroy_runtime_json($diagnostics), 'created_at' => current_time('mysql', true), 'activated_at' => null]);
    return $written === 1 ? zeroy_runtime_theme_deployment_receipt($id) : zeroy_runtime_error('zeroy_deployment_prepare_failed', $wpdb->last_error ?: 'Could not record failed ThemeDeployment.', 500);
}

function zeroy_runtime_prepare_theme_deployment(string $artifact_id, ?string $expected_active_artifact_id, array $provenance): array|WP_Error
{
    $active = zeroy_runtime_active_theme_state();
    if ($active === null || is_wp_error(zeroy_runtime_artifact_integrity((string) $active['artifact_id']))) {
        return zeroy_runtime_error('zeroy_active_theme_missing', 'An intact active ThemeArtifact is required before preparing a deployment.', 409);
    }
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    if ($artifact === null || !is_dir(zeroy_runtime_artifact_directory($artifact_id))) {
        return zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact does not exist.', 404);
    }
    $php = zeroy_runtime_artifact_php_diagnostics($artifact_id);
    $schema = zeroy_runtime_schema_diagnostics_from_path(zeroy_runtime_artifact_directory($artifact_id) . '/zeroy.schema.json', zeroy_runtime_artifact_directory($artifact_id));
    $diagnostics = ['php' => $php, 'schema' => $schema['errors'] ?? []];
    if ($php !== [] || !$schema['valid']) {
        return zeroy_runtime_create_failed_deployment($artifact_id, $expected_active_artifact_id, $provenance, $diagnostics);
    }
    $plan = zeroy_runtime_plan_theme_deployment($schema['schema']);
    $diagnostics['migrationPlan'] = $plan;
    if (!$plan['ok']) {
        return zeroy_runtime_create_failed_deployment($artifact_id, $expected_active_artifact_id, $provenance, $diagnostics);
    }
    global $wpdb;
    $wpdb->update(zeroy_runtime_table('theme_artifacts'), ['schema_json' => zeroy_runtime_json($schema['schema']), 'schema_hash' => $schema['contractHash']], ['artifact_id' => $artifact_id]);
    $id = wp_generate_uuid4();
    $written = $wpdb->insert(zeroy_runtime_table('theme_deployments'), ['deployment_id' => $id, 'artifact_id' => $artifact_id, 'expected_active_artifact_id' => $expected_active_artifact_id, 'state' => 'prepared', 'provenance_json' => zeroy_runtime_json($provenance), 'diagnostics_json' => zeroy_runtime_json($diagnostics), 'created_at' => current_time('mysql', true), 'activated_at' => null]);
    return $written === 1 ? zeroy_runtime_theme_deployment_receipt($id) : zeroy_runtime_error('zeroy_deployment_prepare_failed', $wpdb->last_error ?: 'Could not prepare ThemeDeployment.', 500);
}

function zeroy_runtime_theme_deployment_receipt(string $deployment_id): array|WP_Error
{
    $deployment = zeroy_runtime_deployment_row($deployment_id);
    if ($deployment === null) {
        return zeroy_runtime_error('zeroy_deployment_missing', 'ThemeDeployment does not exist.', 404);
    }
    $active = zeroy_runtime_active_theme_state();
    $diagnostics = zeroy_runtime_decode_json((string) $deployment['diagnostics_json']);
    return ['contract' => ZEROY_THEME_DEPLOYMENT_CONTRACT, 'deploymentId' => $deployment['deployment_id'], 'artifactId' => $deployment['artifact_id'], 'state' => $deployment['state'], 'activeArtifactId' => $active['artifact_id'] ?? null, 'expectedActiveArtifactId' => $deployment['expected_active_artifact_id'], 'migratedHeads' => (int) ($diagnostics['migrationPlan']['migratedHeads'] ?? 0), 'affectedHeads' => $diagnostics['migrationPlan']['affectedHeads'] ?? [], 'routeConflicts' => $diagnostics['migrationPlan']['routeConflicts'] ?? [], 'diagnostics' => $diagnostics, 'createdAt' => $deployment['created_at'], 'activatedAt' => $deployment['activated_at'], 'previewUrl' => $deployment['state'] === 'prepared' ? add_query_arg(['zeroy_candidate' => $deployment_id, 'token' => hash_hmac('sha256', $deployment_id, zeroy_runtime_connection_key())], home_url('/')) : null];
}

function zeroy_runtime_activate_theme_deployment(string $deployment_id): array|WP_Error
{
    $result = zeroy_runtime_transaction(function () use ($deployment_id) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_theme_deployment_lease();
        $content_lease = $lease === true ? zeroy_runtime_acquire_content_lease() : $lease;
        $deployment = $content_lease === true ? zeroy_runtime_deployment_row($deployment_id) : $content_lease;
        if (is_wp_error($deployment) || $deployment === null || $deployment['state'] !== 'prepared') {
            return is_wp_error($deployment) ? $deployment : zeroy_runtime_error('zeroy_deployment_not_prepared', 'ThemeDeployment is not prepared.', 409);
        }
        $active = zeroy_runtime_active_theme_state();
        if ($active === null || !hash_equals((string) $deployment['expected_active_artifact_id'], (string) $active['artifact_id'])) {
            return zeroy_runtime_error('zeroy_active_theme_changed', 'The active ThemeArtifact changed after this checkout.', 409, ['activeArtifactId' => $active['artifact_id'] ?? null]);
        }
        $artifact = zeroy_runtime_artifact_row($deployment['artifact_id']);
        $schema = $artifact === null ? null : zeroy_runtime_decode_json((string) $artifact['schema_json']);
        $plan = is_array($schema) ? zeroy_runtime_plan_theme_deployment($schema) : ['ok' => false];
        if (!$plan['ok']) {
            return zeroy_runtime_error('zeroy_deployment_plan_changed', 'ThemeDeployment is no longer compatible with current LocaleOverlay state.', 409, $plan);
        }
        $migration = zeroy_localization_apply_overlay_reconciliation($schema);
        if (is_wp_error($migration)) {
            return $migration;
        }
        // This seam is deliberately after LocaleHead movement. A rollback here
        // proves readers cannot observe a new Artifact with old Overlay facts.
        $fault = zeroy_runtime_fail_if_theme_deployment_fault('activation.before-active-pointer');
        if (is_wp_error($fault)) {
            return $fault;
        }
        $now = current_time('mysql', true);
        $diagnostics = zeroy_runtime_decode_json((string) $deployment['diagnostics_json']);
        if (is_wp_error($diagnostics)) {
            return zeroy_runtime_error('zeroy_deployment_diagnostics_corrupt', 'ThemeDeployment diagnostics are invalid.', 409);
        }
        $diagnostics['migrationPlan'] = [...$plan, ...$migration];
        if ($wpdb->update(zeroy_runtime_table('theme_deployments'), ['diagnostics_json' => zeroy_runtime_json($diagnostics)], ['deployment_id' => $deployment_id]) !== 1) {
            return zeroy_runtime_error('zeroy_deployment_activation_failed', $wpdb->last_error ?: 'Could not record ThemeDeployment migration results.', 500);
        }
        $wpdb->update(zeroy_runtime_table('theme_deployments'), ['state' => 'superseded'], ['deployment_id' => $active['active_deployment_id']]);
        if ($wpdb->update(zeroy_runtime_table('theme_deployments'), ['state' => 'active', 'activated_at' => $now], ['deployment_id' => $deployment_id, 'state' => 'prepared']) !== 1 || $wpdb->update(zeroy_runtime_table('theme_state'), ['active_deployment_id' => $deployment_id, 'revision' => (int) $active['revision'] + 1, 'activated_at' => $now], ['singleton' => 1, 'active_deployment_id' => $active['active_deployment_id'], 'revision' => $active['revision']]) !== 1) {
            return zeroy_runtime_error('zeroy_deployment_activation_failed', 'Could not atomically activate ThemeDeployment.', 409);
        }
        return zeroy_runtime_theme_deployment_receipt($deployment_id);
    });
    if (!is_wp_error($result)) {
        zeroy_runtime_collect_theme_artifacts();
    }
    return $result;
}
