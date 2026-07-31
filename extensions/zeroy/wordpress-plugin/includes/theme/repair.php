<?php

defined('ABSPATH') || exit;

function zeroy_runtime_repair_active_theme_artifact(): array|WP_Error
{
    $active = zeroy_runtime_active_theme_state();
    if ($active === null) {
        return zeroy_runtime_error('zeroy_active_theme_missing', 'No active ThemeDeployment is available.', 409);
    }
    $artifact_id = (string) $active['artifact_id'];
    $integrity = zeroy_runtime_artifact_integrity($artifact_id);
    if (!is_wp_error($integrity) && ($integrity['ok'] ?? false) === true) {
        return ['artifactId' => $artifact_id, 'repaired' => false, 'integrity' => $integrity];
    }
    $archive_path = zeroy_runtime_artifact_archive_path($artifact_id);
    if (!is_file($archive_path)) {
        return zeroy_runtime_error('zeroy_artifact_repair_unavailable', 'The authoritative ThemeArtifact archive is unavailable; this drift cannot be repaired safely.', 409, ['artifactId' => $artifact_id]);
    }
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    $manifest = is_array($artifact) ? zeroy_runtime_decode_json((string) $artifact['manifest_json']) : null;
    $manifest = is_array($manifest) ? zeroy_runtime_normalize_manifest($manifest) : zeroy_runtime_error('zeroy_artifact_corrupt', 'Stored ThemeArtifact manifest is invalid.', 500);
    if (is_wp_error($manifest)) {
        return $manifest;
    }
    $archive = file_get_contents($archive_path);
    if (!is_string($archive)) {
        return zeroy_runtime_error('zeroy_artifact_repair_unavailable', 'Could not read the authoritative ThemeArtifact archive.', 500);
    }
    $target = zeroy_runtime_artifact_directory($artifact_id);
    $backup = zeroy_runtime_staging_root() . '/repair-' . wp_generate_uuid4();
    if (is_dir($target) && !rename($target, $backup)) {
        return zeroy_runtime_error('zeroy_artifact_repair_failed', 'Could not isolate the drifted ThemeArtifact tree.', 500);
    }
    $restored = zeroy_runtime_materialize_artifact_archive($manifest, base64_encode($archive));
    if (is_wp_error($restored) || ($restored['artifactId'] ?? null) !== $artifact_id) {
        if (is_dir($target)) {
            zeroy_runtime_remove_artifact_directory($target);
        }
        if (is_dir($backup)) {
            rename($backup, $target);
        }
        return is_wp_error($restored)
            ? $restored
            : zeroy_runtime_error('zeroy_artifact_repair_failed', 'The restored ThemeArtifact did not retain its immutable identity.', 500);
    }
    if (is_dir($backup)) {
        zeroy_runtime_remove_artifact_staging($backup);
    }
    $verified = zeroy_runtime_artifact_integrity($artifact_id);
    if (is_wp_error($verified) || ($verified['ok'] ?? false) !== true) {
        return is_wp_error($verified)
            ? $verified
            : zeroy_runtime_error('zeroy_artifact_repair_failed', 'The restored ThemeArtifact still differs from its immutable manifest.', 500);
    }
    return ['artifactId' => $artifact_id, 'repaired' => true, 'integrity' => $verified];
}
