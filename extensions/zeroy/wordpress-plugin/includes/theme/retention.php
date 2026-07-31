<?php

defined('ABSPATH') || exit;

const ZEROY_THEME_SUCCESSFUL_DEPLOYMENT_RETENTION = 20;
const ZEROY_THEME_FAILED_ARTIFACT_GRACE_SECONDS = 7 * DAY_IN_SECONDS;
const ZEROY_THEME_UNREFERENCED_ARTIFACT_GRACE_SECONDS = DAY_IN_SECONDS;

function zeroy_runtime_theme_storage_usage(): array
{
    $bytes = 0;
    foreach ([zeroy_runtime_artifact_root(), zeroy_runtime_archive_root(), zeroy_runtime_staging_root()] as $root) {
        if (!is_dir($root) || is_link($root)) {
            continue;
        }
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($iterator as $entry) {
            if ($entry instanceof SplFileInfo && !$entry->isLink() && $entry->isFile()) {
                $bytes += $entry->getSize();
            }
        }
    }
    return ['bytes' => $bytes, 'limit' => zeroy_runtime_theme_policy()['maxStorageBytes']];
}

function zeroy_runtime_theme_artifact_is_retained(array $artifact, array $retained_artifacts): bool
{
    return isset($retained_artifacts[(string) $artifact['artifact_id']]);
}

function zeroy_runtime_theme_retention_marks(): array
{
    global $wpdb;
    $deployments = zeroy_runtime_table('theme_deployments');
    $artifacts = zeroy_runtime_table('theme_artifacts');
    $state = zeroy_runtime_active_theme_state();
    $retained_deployments = [];
    $retained_artifacts = [];
    if (is_array($state)) {
        $retained_deployments[(string) $state['active_deployment_id']] = true;
        $retained_artifacts[(string) $state['artifact_id']] = true;
    }
    $successful = $wpdb->get_results(
        'SELECT deployment_id, artifact_id FROM ' . $deployments . " WHERE state IN ('active', 'superseded') ORDER BY activated_at DESC, created_at DESC LIMIT " . ZEROY_THEME_SUCCESSFUL_DEPLOYMENT_RETENTION,
        ARRAY_A
    );
    foreach (is_array($successful) ? $successful : [] as $deployment) {
        $retained_deployments[(string) $deployment['deployment_id']] = true;
        $retained_artifacts[(string) $deployment['artifact_id']] = true;
    }
    $prepared = $wpdb->get_results(
        'SELECT deployment_id, artifact_id FROM ' . $deployments . " WHERE state = 'prepared'",
        ARRAY_A
    );
    foreach (is_array($prepared) ? $prepared : [] as $deployment) {
        $retained_deployments[(string) $deployment['deployment_id']] = true;
        $retained_artifacts[(string) $deployment['artifact_id']] = true;
    }
    $failed_cutoff = gmdate('Y-m-d H:i:s', time() - ZEROY_THEME_FAILED_ARTIFACT_GRACE_SECONDS);
    $failed = $wpdb->get_results(
        $wpdb->prepare('SELECT deployment_id, artifact_id FROM ' . $deployments . " WHERE state = 'failed' AND created_at >= %s", $failed_cutoff),
        ARRAY_A
    );
    foreach (is_array($failed) ? $failed : [] as $deployment) {
        $retained_deployments[(string) $deployment['deployment_id']] = true;
        $retained_artifacts[(string) $deployment['artifact_id']] = true;
    }
    $unreferenced_cutoff = gmdate('Y-m-d H:i:s', time() - ZEROY_THEME_UNREFERENCED_ARTIFACT_GRACE_SECONDS);
    $recent_or_pinned = $wpdb->get_results(
        $wpdb->prepare('SELECT artifact_id FROM ' . $artifacts . ' WHERE pinned_at IS NOT NULL OR created_at >= %s', $unreferenced_cutoff),
        ARRAY_A
    );
    foreach (is_array($recent_or_pinned) ? $recent_or_pinned : [] as $artifact) {
        $retained_artifacts[(string) $artifact['artifact_id']] = true;
    }
    return ['deployments' => $retained_deployments, 'artifacts' => $retained_artifacts];
}

function zeroy_runtime_remove_artifact_archive(string $artifact_id): void
{
    $archive = zeroy_runtime_artifact_archive_path($artifact_id);
    if (is_file($archive) && !is_link($archive)) {
        unlink($archive);
    }
}

function zeroy_runtime_collect_theme_artifacts(): array|WP_Error
{
    $result = zeroy_runtime_transaction(function () {
        global $wpdb;
        $lease = zeroy_runtime_acquire_theme_deployment_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $marks = zeroy_runtime_theme_retention_marks();
        $deployment_rows = $wpdb->get_results(
            'SELECT deployment_id, artifact_id FROM ' . zeroy_runtime_table('theme_deployments'),
            ARRAY_A
        );
        $removed_deployments = 0;
        foreach (is_array($deployment_rows) ? $deployment_rows : [] as $deployment) {
            $deployment_id = (string) $deployment['deployment_id'];
            if (isset($marks['deployments'][$deployment_id])) {
                continue;
            }
            $deleted = $wpdb->delete(zeroy_runtime_table('theme_deployments'), ['deployment_id' => $deployment_id], ['%s']);
            if ($deleted !== 1) {
                return zeroy_runtime_error('zeroy_theme_gc_failed', $wpdb->last_error ?: 'Could not remove an expired ThemeDeployment.', 500);
            }
            $removed_deployments++;
        }
        $artifact_rows = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('theme_artifacts'), ARRAY_A);
        $removed_artifacts = [];
        foreach (is_array($artifact_rows) ? $artifact_rows : [] as $artifact) {
            if (zeroy_runtime_theme_artifact_is_retained($artifact, $marks['artifacts'])) {
                continue;
            }
            $artifact_id = (string) $artifact['artifact_id'];
            $deleted = $wpdb->delete(zeroy_runtime_table('theme_artifacts'), ['artifact_id' => $artifact_id], ['%s']);
            if ($deleted !== 1) {
                return zeroy_runtime_error('zeroy_theme_gc_failed', $wpdb->last_error ?: 'Could not remove an expired ThemeArtifact.', 500);
            }
            $removed_artifacts[] = $artifact_id;
        }
        return ['deployments' => $removed_deployments, 'artifacts' => $removed_artifacts];
    });
    if (is_wp_error($result)) {
        return $result;
    }
    foreach ($result['artifacts'] as $artifact_id) {
        zeroy_runtime_remove_artifact_directory(zeroy_runtime_artifact_directory($artifact_id));
        zeroy_runtime_remove_artifact_archive($artifact_id);
    }
    return [
        'removedDeployments' => $result['deployments'],
        'removedArtifacts' => count($result['artifacts']),
        'storage' => zeroy_runtime_theme_storage_usage(),
    ];
}
