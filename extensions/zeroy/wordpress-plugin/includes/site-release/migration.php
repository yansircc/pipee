<?php

defined('ABSPATH') || exit;

function zeroy_runtime_archive_directory(string $directory, array $manifest, string $staging_root): string|WP_Error
{
    if (!wp_mkdir_p($staging_root)) return zeroy_runtime_error('zeroy_migration_staging_failed', 'Could not create migration staging.', 500);
    $tar = $staging_root . '/' . wp_generate_uuid4() . '.tar';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) $archive->addFile($directory . '/' . $entry['path'], $entry['path']);
        $archive->compress(Phar::GZ);
        $gz = $tar . '.gz';
        $bytes = file_get_contents($gz);
        return is_string($bytes) ? base64_encode($bytes) : zeroy_runtime_error('zeroy_migration_archive_failed', 'Could not read migration archive.', 500);
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_migration_archive_failed', $error->getMessage(), 500);
    } finally {
        if (is_file($tar)) unlink($tar);
        if (is_file($tar . '.gz')) unlink($tar . '.gz');
    }
}

function zeroy_runtime_import_site_logic_directory(string $directory): array|WP_Error
{
    $entries = [];
    foreach (['bootstrap.php', 'sitelogic.json'] as $path) {
        $file = $directory . '/' . $path;
        $bytes = is_file($file) ? file_get_contents($file) : false;
        if (!is_string($bytes)) return zeroy_runtime_error('zeroy_site_logic_bootstrap_missing', 'Bundled SiteLogic bootstrap is incomplete.', 500);
        $entries[] = ['path' => $path, 'hash' => hash('sha256', $bytes), 'bytes' => strlen($bytes), 'mode' => 'file'];
    }
    $manifest = zeroy_runtime_normalize_site_logic_manifest(['contract' => ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, 'entries' => $entries]);
    if (is_wp_error($manifest)) return $manifest;
    $archive = zeroy_runtime_archive_directory($directory, $manifest, zeroy_runtime_site_logic_staging_root());
    return is_wp_error($archive) ? $archive : zeroy_runtime_site_logic_materialize_artifact_archive($manifest, $archive);
}

function zeroy_runtime_migrate_legacy_theme_artifact(string $legacy_artifact_id): array|WP_Error
{
    $source = zeroy_runtime_artifact_directory($legacy_artifact_id);
    if (!is_dir($source)) return zeroy_runtime_error('zeroy_legacy_theme_missing', 'Legacy ThemeArtifact files are unavailable for hard-cut migration.', 409);
    $staging = zeroy_runtime_staging_root() . '/site-release-migration-' . wp_generate_uuid4();
    if (!wp_mkdir_p($staging)) return zeroy_runtime_error('zeroy_migration_staging_failed', 'Could not create theme migration staging.', 500);
    try {
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $file) {
            if (!$file instanceof SplFileInfo || !$file->isFile() || $file->isLink()) return zeroy_runtime_error('zeroy_legacy_theme_invalid', 'Legacy ThemeArtifact contains an unsafe file.', 409);
            $relative = ltrim(substr(wp_normalize_path($file->getPathname()), strlen(rtrim(wp_normalize_path($source), '/'))), '/');
            $target = $staging . '/' . $relative;
            if (!wp_mkdir_p(dirname($target)) || !copy($file->getPathname(), $target)) return zeroy_runtime_error('zeroy_migration_copy_failed', 'Could not copy legacy ThemeArtifact.', 500);
        }
        file_put_contents($staging . '/zeroy.theme.json', zeroy_runtime_json(['contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT, 'requiresCapabilities' => []]) . "\n", LOCK_EX);
        $manifest = zeroy_runtime_scan_theme_tree($staging);
        if (is_wp_error($manifest)) return $manifest;
        $archive = zeroy_runtime_archive_directory($staging, $manifest, zeroy_runtime_staging_root());
        if (is_wp_error($archive)) return $archive;
        return zeroy_runtime_materialize_artifact_archive($manifest, $archive);
    } finally {
        if (is_dir($staging)) zeroy_runtime_remove_artifact_staging($staging);
    }
}

function zeroy_runtime_legacy_active_theme_artifact_id(): ?string
{
    global $wpdb;
    if (!zeroy_runtime_table_exists(zeroy_runtime_table('theme_state')) || !zeroy_runtime_table_exists(zeroy_runtime_table('theme_deployments'))) return null;
    $id = $wpdb->get_var('SELECT d.artifact_id FROM ' . zeroy_runtime_table('theme_state') . ' s JOIN ' . zeroy_runtime_table('theme_deployments') . ' d ON d.deployment_id = s.active_deployment_id WHERE s.singleton = 1');
    return is_string($id) && $id !== '' ? $id : null;
}

function zeroy_runtime_drop_legacy_site_release_tables(): void
{
    // This is the sole reader of legacy deployment state. It runs only after
    // an atomic SiteRelease exists; there is no legacy runtime fallback.
    if (zeroy_runtime_active_site_release() === null) return;
    global $wpdb;
    foreach (['locale_heads', 'locale_versions', 'theme_state', 'theme_deployments'] as $table) {
        $wpdb->query('DROP TABLE IF EXISTS ' . zeroy_runtime_table($table));
    }
}

function zeroy_runtime_migrate_legacy_site_release(): true|WP_Error
{
    if (zeroy_runtime_active_site_release() !== null) return true;
    $legacy_theme = zeroy_runtime_legacy_active_theme_artifact_id();
    if ($legacy_theme === null) return true;
    $theme = zeroy_runtime_migrate_legacy_theme_artifact($legacy_theme);
    if (is_wp_error($theme)) return $theme;
    $logic = zeroy_runtime_import_site_logic_directory(dirname(__DIR__, 2) . '/bootstrap-site-logic');
    if (is_wp_error($logic)) return $logic;
    $prepared = zeroy_runtime_prepare_site_release((string) $theme['artifactId'], (string) $logic['artifactId'], null, ['source' => 'hard-cut-migration', 'sourceCommit' => 'legacy-theme-artifact:' . $legacy_theme, 'message' => 'Hard-cut migration from ThemeDeployment']);
    if (is_wp_error($prepared)) return $prepared;
    if (($prepared['state'] ?? null) !== 'prepared') return zeroy_runtime_error('zeroy_hard_cut_verification_failed', 'Legacy migration candidate did not pass current SiteRelease verification.', 409, ['diagnostics' => $prepared['diagnostics'] ?? null]);
    $activated = zeroy_runtime_activate_site_release((string) $prepared['releaseId']);
    if (is_wp_error($activated) || ($activated['state'] ?? null) !== 'active') {
        return is_wp_error($activated) ? $activated : zeroy_runtime_error('zeroy_hard_cut_activation_failed', 'Could not activate migrated SiteRelease.', 500);
    }
    return true;
}
