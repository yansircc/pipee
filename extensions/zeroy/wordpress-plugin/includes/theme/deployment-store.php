<?php

defined('ABSPATH') || exit;

function zeroy_runtime_deployment_row(string $deployment_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('theme_deployments') . ' WHERE deployment_id = %s', $deployment_id),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_active_theme_state(): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        'SELECT s.active_deployment_id, s.revision, s.activated_at, d.artifact_id, d.provenance_json, a.manifest_json, a.schema_json, a.schema_hash, a.file_count, a.total_bytes
         FROM ' . zeroy_runtime_table('theme_state') . ' s
         JOIN ' . zeroy_runtime_table('theme_deployments') . ' d ON d.deployment_id = s.active_deployment_id
         JOIN ' . zeroy_runtime_table('theme_artifacts') . ' a ON a.artifact_id = d.artifact_id
         WHERE s.singleton = 1',
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}
