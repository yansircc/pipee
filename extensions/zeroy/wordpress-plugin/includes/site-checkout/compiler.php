<?php

defined('ABSPATH') || exit;

function zeroy_checkout_read_tree_files(string $tree_hash, string $prefix = ''): array|WP_Error
{
    $entries = zeroy_checkout_tree_entries($tree_hash);
    if (is_wp_error($entries)) return $entries;
    $files = [];
    foreach ($entries as $entry) {
        $path = $prefix === '' ? $entry['name'] : $prefix . '/' . $entry['name'];
        if ($entry['kind'] === 'tree') {
            $nested = zeroy_checkout_read_tree_files($entry['hash'], $path);
            if (is_wp_error($nested)) return $nested;
            $files += $nested;
            continue;
        }
        $row = zeroy_checkout_object_row($entry['hash']);
        if ($row === null || (string) $row['object_type'] !== 'blob') return zeroy_runtime_error('zeroy_tree_object_missing', 'SiteTree blob is missing.', 500, ['path' => $path]);
        $files[$path] = ['bytes' => (string) $row['object_bytes'], 'mode' => $entry['mode'], 'hash' => $entry['hash']];
    }
    ksort($files, SORT_STRING);
    return $files;
}

function zeroy_checkout_remove_directory(string $directory): void
{
    if (!is_dir($directory) || is_link($directory)) return;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $entry) if ($entry instanceof SplFileInfo) $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    rmdir($directory);
}

function zeroy_checkout_with_directory(array $files, string $prefix, callable $use): mixed
{
    $root = zeroy_runtime_staging_root() . '/checkout-' . wp_generate_uuid4();
    if (!wp_mkdir_p($root)) return zeroy_runtime_error('zeroy_checkout_materialize_failed', 'Could not create checkout compiler directory.', 500);
    try {
        $found = false;
        foreach ($files as $path => $file) {
            if (!str_starts_with($path, $prefix . '/')) continue;
            $relative = substr($path, strlen($prefix) + 1);
            if (!zeroy_checkout_path_is_safe($relative)) return zeroy_runtime_error('zeroy_checkout_path_invalid', 'Checkout artifact path is invalid.', 400, ['path' => $path]);
            $target = $root . '/' . $relative;
            if (!wp_mkdir_p(dirname($target)) || file_put_contents($target, $file['bytes'], LOCK_EX) !== strlen($file['bytes'])) return zeroy_runtime_error('zeroy_checkout_materialize_failed', 'Could not materialize checkout artifact file.', 500, ['path' => $path]);
            chmod($target, $file['mode'] === 'executable' ? 0755 : 0644);
            $found = true;
        }
        if (!$found) return zeroy_runtime_error('zeroy_checkout_artifact_missing', 'Checkout artifact directory is empty.', 409, ['path' => $prefix]);
        return $use($root);
    } finally {
        zeroy_checkout_remove_directory($root);
    }
}

function zeroy_checkout_archive_directory(string $directory, array $manifest): string|WP_Error
{
    $nonce = wp_generate_uuid4();
    $tar = zeroy_runtime_staging_root() . '/' . $nonce . '.tar';
    $gz = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) $archive->addFile(rtrim($directory, '/') . '/' . $entry['path'], $entry['path']);
        $archive->compress(Phar::GZ);
        unset($archive);
        $bytes = is_file($gz) ? file_get_contents($gz) : false;
        return is_string($bytes) ? base64_encode($bytes) : zeroy_runtime_error('zeroy_checkout_artifact_archive_failed', 'Could not read checkout artifact archive.', 500);
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_checkout_artifact_archive_failed', $error->getMessage(), 500);
    } finally {
        foreach ([$tar, $gz] as $path) if (is_file($path)) unlink($path);
    }
}

function zeroy_checkout_compile_artifacts(array $files): array|WP_Error
{
    $theme = zeroy_checkout_with_directory($files, 'artifacts/theme', static function (string $directory): array|WP_Error {
        $zcss = zeroy_runtime_compile_zcss_directory($directory);
        if (is_wp_error($zcss)) return $zcss;
        $units = zeroy_runtime_compile_theme_units_directory($directory);
        if (is_wp_error($units)) return $units;
        $manifest = zeroy_runtime_scan_theme_tree($directory);
        if (is_wp_error($manifest)) return $manifest;
        $archive = zeroy_checkout_archive_directory($directory, $manifest);
        if (is_wp_error($archive)) return $archive;
        $stored = zeroy_runtime_materialize_artifact_archive($manifest, $archive);
        return is_wp_error($stored) ? $stored : ['artifactId' => $stored['artifactId'], 'manifest' => $manifest];
    });
    if (is_wp_error($theme)) return $theme;
    $logic = zeroy_checkout_with_directory($files, 'artifacts/site-logic', static function (string $directory): array|WP_Error {
        $stored = zeroy_runtime_materialize_site_logic_directory($directory);
        if (is_wp_error($stored)) return $stored;
        $row = zeroy_runtime_site_logic_artifact_row((string) $stored['artifactId']);
        $manifest = is_array($row) ? zeroy_runtime_decode_json((string) $row['manifest_json']) : null;
        return is_array($manifest) ? ['artifactId' => $stored['artifactId'], 'manifest' => $manifest] : zeroy_runtime_error('zeroy_site_logic_artifact_invalid', 'Compiled SiteLogicArtifact has no manifest.', 500);
    });
    return is_wp_error($logic) ? $logic : ['theme' => $theme, 'siteLogic' => $logic];
}

function zeroy_checkout_json_file(array $files, string $path): array|WP_Error
{
    $file = $files[$path] ?? null;
    if (!is_array($file) || !is_string($file['bytes'] ?? null)) return zeroy_runtime_error('zeroy_checkout_document_missing', 'Required checkout document is missing.', 409, ['path' => $path]);
    $decoded = json_decode($file['bytes'], true);
    return zeroy_runtime_is_keyed_map($decoded) ? $decoded : zeroy_runtime_error('zeroy_checkout_document_invalid', 'Checkout document must be a JSON object.', 409, ['path' => $path]);
}

function zeroy_checkout_compile_commit(string $commit_hash): array|WP_Error
{
    $row = zeroy_checkout_commit_row($commit_hash);
    if ($row === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit does not exist.', 404, ['commit' => $commit_hash]);
    $files = zeroy_checkout_read_tree_files((string) $row['tree_hash']);
    if (is_wp_error($files)) return $files;
    $artifacts = zeroy_checkout_compile_artifacts($files);
    if (is_wp_error($artifacts)) return $artifacts;
    $compiled = zeroy_runtime_compile_theme_contract((string) $artifacts['theme']['artifactId'], (string) $artifacts['siteLogic']['artifactId']);
    if (is_wp_error($compiled)) return $compiled;
    $base_id = (string) ($row['base_release_id'] ?? '');
    $base = $base_id === '' ? null : zeroy_runtime_site_release_row($base_id);
    if ($base_id !== '' && $base === null) return zeroy_runtime_error('zeroy_site_commit_base_missing', 'SiteCommit base SiteRelease does not exist.', 409, ['baseReleaseId' => $base_id]);
    $snapshot = $base === null ? zeroy_runtime_compile_base_snapshot($compiled['contract'], $compiled['schema']) : zeroy_runtime_site_release_snapshot($base);
    if (is_wp_error($snapshot)) return $snapshot;
    unset($snapshot['snapshotHash'], $snapshot['operationsHash'], $snapshot['themeArtifactId'], $snapshot['siteLogicArtifactId']);
    $parent_files = [];
    $parent_hash = is_string($row['parent_hash'] ?? null) && $row['parent_hash'] !== '' ? $row['parent_hash'] : null;
    if ($parent_hash !== null) {
        $parent = zeroy_checkout_commit_row($parent_hash);
        if (is_array($parent)) {
            $parent_files = zeroy_checkout_read_tree_files((string) $parent['tree_hash']);
            if (is_wp_error($parent_files)) $parent_files = [];
        }
    }
    $failures = [];
    $operations = zeroy_document_compile_operations($files, $snapshot, $compiled['schema'], $parent_files, $failures);
    if ($failures !== []) return zeroy_runtime_error('zeroy_document_build_invalid', 'SiteTree v2 authored documents are invalid.', 409, ['failures' => $failures]);
    $snapshot = zeroy_runtime_apply_operations_to_snapshot($snapshot, $operations, $compiled['contract'], $compiled['schema']);
    if (is_wp_error($snapshot)) return $snapshot;
    $snapshot['materializationPlan'] = $operations;
    $snapshot['operationsHash'] = zeroy_runtime_hash($operations);
    $snapshot['themeArtifactId'] = $artifacts['theme']['artifactId'];
    $snapshot['siteLogicArtifactId'] = $artifacts['siteLogic']['artifactId'];
    $snapshot['snapshotHash'] = zeroy_runtime_hash($snapshot);
    return ['commit' => $row, 'artifacts' => $artifacts, 'compiled' => $compiled, 'snapshot' => $snapshot, 'operations' => $operations];
}
