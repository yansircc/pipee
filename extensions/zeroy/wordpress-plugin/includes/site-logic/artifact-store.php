<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_logic_policy(): array
{
    return [
        'contract' => 'zeroy/site-logic-artifact-policy@1',
        'forbiddenPaths' => ['.git/**', 'node_modules/**', '.DS_Store', '*.log', '.cache/**', '.tmp/**', 'coverage/**'],
        'maxFiles' => 5000,
        'maxFileBytes' => 16 * 1024 * 1024,
        'maxArtifactBytes' => 256 * 1024 * 1024,
        'maxStorageBytes' => 1024 * 1024 * 1024,
        'allowSymlinks' => false,
    ];
}

function zeroy_runtime_site_logic_root(): string
{
    return zeroy_runtime_private_storage_root() . '/site-logic-artifacts';
}

function zeroy_runtime_site_logic_staging_root(): string
{
    return zeroy_runtime_private_storage_root() . '/site-logic-staging';
}

function zeroy_runtime_site_logic_archive_root(): string
{
    return zeroy_runtime_private_storage_root() . '/site-logic-archives';
}

function zeroy_runtime_site_logic_directory(string $artifact_id): string
{
    return zeroy_runtime_site_logic_root() . '/' . str_replace(':', '-', $artifact_id);
}

function zeroy_runtime_site_logic_archive_path(string $artifact_id): string
{
    return zeroy_runtime_site_logic_archive_root() . '/' . str_replace(':', '-', $artifact_id) . '.tar.gz';
}

function zeroy_runtime_scan_site_logic_tree(string $root): array|WP_Error
{
    $root = wp_normalize_path($root);
    if (!is_dir($root) || is_link($root)) {
        return zeroy_runtime_error('zeroy_site_logic_tree_invalid', 'SiteLogic source must be one regular directory.', 409);
    }
    $entries = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY,
    );
    foreach ($iterator as $file) {
        if (!$file instanceof SplFileInfo) continue;
        $absolute = wp_normalize_path($file->getPathname());
        $path = ltrim(substr($absolute, strlen(rtrim($root, '/'))), '/');
        if ($file->isLink() || !$file->isFile() || !zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path)) {
            return zeroy_runtime_error('zeroy_site_logic_tree_invalid', 'SiteLogic source contains a symlink, special file, or forbidden path.', 409, ['path' => $path]);
        }
        $hash = hash_file('sha256', $absolute);
        $bytes = $file->getSize();
        if (!is_string($hash) || !is_int($bytes)) {
            return zeroy_runtime_error('zeroy_site_logic_tree_unreadable', 'Could not hash a SiteLogicArtifact file.', 500, ['path' => $path]);
        }
        $entries[] = ['path' => $path, 'hash' => $hash, 'bytes' => $bytes, 'mode' => $file->isExecutable() ? 'executable' : 'file'];
    }
    return zeroy_runtime_normalize_site_logic_manifest(['contract' => ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, 'entries' => $entries]);
}

function zeroy_runtime_archive_site_logic_directory(string $directory, array $manifest): string|WP_Error
{
    $storage = zeroy_runtime_site_logic_ensure_directories();
    if (is_wp_error($storage)) return $storage;
    $tar = zeroy_runtime_site_logic_staging_root() . '/' . wp_generate_uuid4() . '.tar';
    $gz = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) {
            $archive->addFile(rtrim($directory, '/') . '/' . $entry['path'], $entry['path']);
        }
        $archive->compress(Phar::GZ);
        unset($archive);
        $bytes = is_file($gz) ? file_get_contents($gz) : false;
        return is_string($bytes)
            ? base64_encode($bytes)
            : zeroy_runtime_error('zeroy_site_logic_archive_failed', 'Could not read the SiteLogicArtifact archive.', 500);
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_site_logic_archive_failed', 'Could not archive SiteLogicArtifact: ' . $error->getMessage(), 500);
    } finally {
        foreach ([$tar, $gz] as $path) if (is_file($path)) unlink($path);
    }
}

function zeroy_runtime_materialize_site_logic_directory(string $directory): array|WP_Error
{
    $manifest = zeroy_runtime_scan_site_logic_tree($directory);
    if (is_wp_error($manifest)) return $manifest;
    $archive = zeroy_runtime_archive_site_logic_directory($directory, $manifest);
    return is_wp_error($archive) ? $archive : zeroy_runtime_site_logic_materialize_artifact_archive($manifest, $archive);
}

function zeroy_runtime_default_site_logic_artifact(): array|WP_Error
{
    return zeroy_runtime_materialize_site_logic_directory(dirname(__DIR__, 2) . '/default-site-logic');
}

function zeroy_runtime_normalize_site_logic_manifest(array $manifest): array|WP_Error
{
    if (($manifest['contract'] ?? null) !== ZEROY_SITE_LOGIC_MANIFEST_CONTRACT || !is_array($manifest['entries'] ?? null) || !array_is_list($manifest['entries'])) {
        return zeroy_runtime_error('zeroy_site_logic_manifest_invalid', 'SiteLogic manifest must contain a versioned entries list.', 400);
    }
    $policy = zeroy_runtime_site_logic_policy();
    $entries = [];
    $total = 0;
    foreach ($manifest['entries'] as $entry) {
        $path = is_array($entry) ? ($entry['path'] ?? null) : null;
        $hash = is_array($entry) ? ($entry['hash'] ?? null) : null;
        $bytes = is_array($entry) ? ($entry['bytes'] ?? null) : null;
        $mode = is_array($entry) ? ($entry['mode'] ?? null) : null;
        if (!is_string($path) || !zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path) || !is_string($hash) || preg_match('/\A[0-9a-f]{64}\z/', $hash) !== 1 || !is_int($bytes) || $bytes < 0 || $bytes > $policy['maxFileBytes'] || !in_array($mode, ['file', 'executable'], true)) {
            return zeroy_runtime_error('zeroy_site_logic_manifest_invalid', 'SiteLogic manifest contains an invalid entry.', 400, ['path' => $path]);
        }
        if (isset($entries[$path])) {
            return zeroy_runtime_error('zeroy_site_logic_manifest_invalid', 'SiteLogic manifest paths must be unique.', 400, ['path' => $path]);
        }
        $entries[$path] = ['path' => $path, 'hash' => $hash, 'bytes' => $bytes, 'mode' => $mode];
        $total += $bytes;
    }
    if ($entries === [] || count($entries) > $policy['maxFiles'] || $total > $policy['maxArtifactBytes'] || !isset($entries['sitelogic.json']) || !isset($entries['bootstrap.php'])) {
        return zeroy_runtime_error('zeroy_site_logic_manifest_invalid', 'SiteLogicArtifact requires bounded files plus sitelogic.json and bootstrap.php.', 400);
    }
    ksort($entries, SORT_STRING);
    return ['contract' => ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, 'entries' => array_values($entries)];
}

function zeroy_runtime_site_logic_artifact_id(array $manifest): string
{
    return 'sha256:' . hash('sha256', zeroy_runtime_json($manifest));
}

function zeroy_runtime_site_logic_ensure_directories(): true|WP_Error
{
    foreach ([zeroy_runtime_site_logic_root(), zeroy_runtime_site_logic_staging_root(), zeroy_runtime_site_logic_archive_root()] as $directory) {
        if (!wp_mkdir_p($directory) || !is_dir($directory)) {
            return zeroy_runtime_error('zeroy_site_logic_storage_unavailable', 'Could not create SiteLogicArtifact storage.', 500);
        }
    }
    return true;
}

function zeroy_runtime_site_logic_artifact_row(string $artifact_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_logic_artifacts') . ' WHERE artifact_id = %s', $artifact_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_runtime_site_logic_remove_tree(string $directory, string $allowed_root): void
{
    $root = realpath($allowed_root);
    $target = realpath($directory);
    if (!is_string($root) || !is_string($target) || !str_starts_with($target . '/', rtrim($root, '/') . '/')) {
        return;
    }
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($target, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $file) {
        if ($file instanceof SplFileInfo) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
    }
    rmdir($target);
}

function zeroy_runtime_site_logic_materialize_artifact_archive(array $manifest, string $archive_base64): array|WP_Error
{
    $manifest = zeroy_runtime_normalize_site_logic_manifest($manifest);
    if (is_wp_error($manifest)) {
        return $manifest;
    }
    $archive_bytes = base64_decode($archive_base64, true);
    if (!is_string($archive_bytes) || $archive_bytes === '' || strlen($archive_bytes) > zeroy_runtime_site_logic_policy()['maxArtifactBytes']) {
        return zeroy_runtime_error('zeroy_site_logic_archive_invalid', 'SiteLogicArtifact archive is invalid or too large.', 400);
    }
    $storage = zeroy_runtime_site_logic_ensure_directories();
    if (is_wp_error($storage)) {
        return $storage;
    }
    $artifact_id = zeroy_runtime_site_logic_artifact_id($manifest);
    $existing = zeroy_runtime_site_logic_artifact_row($artifact_id);
    if ($existing !== null && is_dir(zeroy_runtime_site_logic_directory($artifact_id))) {
        return ['artifactId' => $artifact_id, 'created' => false];
    }
    $nonce = wp_generate_uuid4();
    $gz = zeroy_runtime_site_logic_staging_root() . '/' . $nonce . '.tar.gz';
    $tar = zeroy_runtime_site_logic_staging_root() . '/' . $nonce . '.tar';
    $staging = zeroy_runtime_site_logic_staging_root() . '/' . $nonce;
    if (file_put_contents($gz, $archive_bytes, LOCK_EX) !== strlen($archive_bytes)) {
        return zeroy_runtime_error('zeroy_site_logic_storage_unavailable', 'Could not stage SiteLogicArtifact.', 500);
    }
    try {
        (new PharData($gz))->decompress();
        $archive = new PharData($tar);
        $expected = [];
        foreach ($manifest['entries'] as $entry) {
            $expected[$entry['path']] = $entry;
        }
        $names = [];
        $prefix = 'phar://' . wp_normalize_path($tar) . '/';
        foreach (new RecursiveIteratorIterator($archive, RecursiveIteratorIterator::LEAVES_ONLY) as $file) {
            if (!$file instanceof PharFileInfo) continue;
            $pathname = wp_normalize_path($file->getPathname());
            $path = str_starts_with($pathname, $prefix) ? substr($pathname, strlen($prefix)) : '';
            if (!zeroy_runtime_artifact_path_valid($path) || $file->isLink()) {
                return zeroy_runtime_error('zeroy_site_logic_archive_invalid', 'SiteLogicArtifact archive contains an unsafe path.', 400, ['path' => $path]);
            }
            $names[$path] = true;
        }
        ksort($expected, SORT_STRING);
        ksort($names, SORT_STRING);
        if (array_keys($expected) !== array_keys($names)) {
            return zeroy_runtime_error('zeroy_site_logic_manifest_mismatch', 'SiteLogicArtifact bytes do not match its manifest.', 409);
        }
        if (!wp_mkdir_p($staging)) {
            return zeroy_runtime_error('zeroy_site_logic_materialize_failed', 'Could not stage SiteLogicArtifact files.', 500);
        }
        foreach ($expected as $path => $entry) {
            $content = $archive[$path]->getContent();
            if (!is_string($content) || strlen($content) !== $entry['bytes'] || !hash_equals($entry['hash'], hash('sha256', $content))) {
                return zeroy_runtime_error('zeroy_site_logic_manifest_mismatch', 'SiteLogicArtifact content differs from manifest.', 409, ['path' => $path]);
            }
            $target = $staging . '/' . $path;
            if (!wp_mkdir_p(dirname($target)) || file_put_contents($target, $content, LOCK_EX) !== strlen($content)) {
                return zeroy_runtime_error('zeroy_site_logic_materialize_failed', 'Could not materialize SiteLogicArtifact file.', 500, ['path' => $path]);
            }
            chmod($target, $entry['mode'] === 'executable' ? 0555 : 0444);
        }
        $contract = zeroy_runtime_site_logic_contract_from_directory($staging);
        if (is_wp_error($contract)) {
            return $contract;
        }
        $target = zeroy_runtime_site_logic_directory($artifact_id);
        if (!is_dir($target) && !rename($staging, $target)) {
            return zeroy_runtime_error('zeroy_site_logic_materialize_failed', 'Could not atomically materialize SiteLogicArtifact.', 500);
        }
        $archive_target = zeroy_runtime_site_logic_archive_path($artifact_id);
        if (!is_file($archive_target) && !rename($gz, $archive_target)) {
            return zeroy_runtime_error('zeroy_site_logic_archive_write_failed', 'Could not persist SiteLogicArtifact archive.', 500);
        }
        if (is_file($archive_target)) chmod($archive_target, 0444);
        global $wpdb;
        $written = $wpdb->replace(zeroy_runtime_table('site_logic_artifacts'), [
            'artifact_id' => $artifact_id,
            'manifest_json' => zeroy_runtime_json($manifest),
            'contract_json' => zeroy_runtime_json($contract),
            'contract_hash' => zeroy_runtime_hash($contract),
            'storage_epoch' => $contract['storageEpoch'],
            'file_count' => count($manifest['entries']),
            'total_bytes' => array_sum(array_column($manifest['entries'], 'bytes')),
            'created_at' => $existing['created_at'] ?? current_time('mysql', true),
        ]);
        return $written === false ? zeroy_runtime_error('zeroy_site_logic_artifact_write_failed', $wpdb->last_error ?: 'Could not store SiteLogicArtifact.', 500) : ['artifactId' => $artifact_id, 'created' => true];
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_site_logic_archive_invalid', 'SiteLogicArtifact archive could not be read: ' . $error->getMessage(), 400);
    } finally {
        foreach ([$gz, $tar] as $file) if (is_file($file)) unlink($file);
        if (is_dir($staging)) zeroy_runtime_site_logic_remove_tree($staging, zeroy_runtime_site_logic_staging_root());
    }
}

function zeroy_runtime_site_logic_artifact_integrity(string $artifact_id): array|WP_Error
{
    $row = zeroy_runtime_site_logic_artifact_row($artifact_id);
    if ($row === null) return zeroy_runtime_error('zeroy_site_logic_artifact_missing', 'SiteLogicArtifact does not exist.', 404);
    $manifest = zeroy_runtime_decode_json((string) $row['manifest_json']);
    $manifest = is_wp_error($manifest) ? $manifest : zeroy_runtime_normalize_site_logic_manifest($manifest);
    if (is_wp_error($manifest)) return zeroy_runtime_error('zeroy_site_logic_artifact_corrupt', 'SiteLogicArtifact manifest is invalid.', 500);
    $directory = zeroy_runtime_site_logic_directory($artifact_id);
    if (!is_dir($directory) || is_link($directory)) return ['ok' => false, 'artifactId' => $artifact_id, 'code' => 'site-logic-drift'];
    foreach ($manifest['entries'] as $entry) {
        $path = $directory . '/' . $entry['path'];
        if (!is_file($path) || is_link($path) || !hash_equals($entry['hash'], (string) hash_file('sha256', $path))) return ['ok' => false, 'artifactId' => $artifact_id, 'code' => 'site-logic-drift'];
    }
    return ['ok' => true, 'artifactId' => $artifact_id];
}

function zeroy_runtime_site_logic_artifact_archive_base64(string $artifact_id): string|WP_Error
{
    $integrity = zeroy_runtime_site_logic_artifact_integrity($artifact_id);
    if (is_wp_error($integrity) || ($integrity['ok'] ?? false) !== true) return zeroy_runtime_error('zeroy_site_logic_drift', 'SiteLogicArtifact has drifted.', 409);
    $archive = zeroy_runtime_site_logic_archive_path($artifact_id);
    $bytes = is_file($archive) ? file_get_contents($archive) : false;
    return is_string($bytes) ? base64_encode($bytes) : zeroy_runtime_error('zeroy_site_logic_archive_missing', 'SiteLogicArtifact archive is unavailable.', 409);
}
