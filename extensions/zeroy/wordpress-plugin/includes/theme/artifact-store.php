<?php

defined('ABSPATH') || exit;

function zeroy_runtime_artifact_root(): string
{
    return zeroy_runtime_private_storage_root() . '/artifacts';
}

function zeroy_runtime_staging_root(): string
{
    return zeroy_runtime_private_storage_root() . '/staging';
}

function zeroy_runtime_archive_root(): string
{
    return zeroy_runtime_private_storage_root() . '/archives';
}

function zeroy_runtime_artifact_archive_path(string $artifact_id): string
{
    return zeroy_runtime_archive_root() . '/' . str_replace(':', '-', $artifact_id) . '.tar.gz';
}

function zeroy_runtime_persist_artifact_archive(string $artifact_id, string $source): true|WP_Error
{
    $target = zeroy_runtime_artifact_archive_path($artifact_id);
    if (is_file($target)) {
        return true;
    }
    $staging = $target . '.' . wp_generate_uuid4();
    if (!copy($source, $staging) || !rename($staging, $target)) {
        if (is_file($staging)) {
            unlink($staging);
        }
        return zeroy_runtime_error('zeroy_artifact_archive_write_failed', 'Could not persist the authoritative ThemeArtifact archive.', 500);
    }
    chmod($target, 0444);
    return true;
}

function zeroy_runtime_artifact_directory(string $artifact_id): string
{
    return zeroy_runtime_artifact_root() . '/' . str_replace(':', '-', $artifact_id);
}

function zeroy_runtime_ensure_artifact_directories(): true|WP_Error
{
    foreach ([zeroy_runtime_artifact_root(), zeroy_runtime_staging_root(), zeroy_runtime_archive_root()] as $directory) {
        if (!wp_mkdir_p($directory) || !is_dir($directory)) {
            return zeroy_runtime_error('zeroy_artifact_storage_unavailable', 'Could not create the ThemeArtifact storage root.', 500);
        }
    }
    return true;
}

function zeroy_runtime_theme_storage_usage(): array
{
    $bytes = 0;
    foreach ([zeroy_runtime_artifact_root(), zeroy_runtime_archive_root(), zeroy_runtime_staging_root()] as $root) {
        if (!is_dir($root) || is_link($root)) continue;
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $entry) {
            if ($entry instanceof SplFileInfo && $entry->isFile() && !$entry->isLink()) $bytes += $entry->getSize();
        }
    }
    return ['bytes' => $bytes, 'limit' => zeroy_runtime_theme_policy()['maxStorageBytes']];
}

function zeroy_runtime_scan_theme_tree(string $root): array|WP_Error
{
    $root = wp_normalize_path($root);
    if (!is_dir($root) || is_link($root)) {
        return zeroy_runtime_error('zeroy_theme_tree_invalid', 'Theme source must be one regular directory.', 409);
    }
    $entries = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($iterator as $file) {
        if (!$file instanceof SplFileInfo) {
            continue;
        }
        $absolute = wp_normalize_path($file->getPathname());
        $path = ltrim(substr($absolute, strlen(rtrim($root, '/'))), '/');
        if ($file->isLink() || !$file->isFile() || !zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path)) {
            return zeroy_runtime_error('zeroy_theme_tree_invalid', 'Theme tree contains a symlink, special file, or forbidden path.', 409, ['path' => $path]);
        }
        $hash = hash_file('sha256', $absolute);
        $bytes = $file->getSize();
        if (!is_string($hash) || !is_int($bytes)) {
            return zeroy_runtime_error('zeroy_theme_tree_unreadable', 'Could not hash a ThemeArtifact file.', 500, ['path' => $path]);
        }
        $entries[] = ['path' => $path, 'hash' => $hash, 'bytes' => $bytes, 'mode' => $file->isExecutable() ? 'executable' : 'file'];
    }
    return zeroy_runtime_normalize_manifest(['contract' => ZEROY_THEME_MANIFEST_CONTRACT, 'entries' => $entries]);
}

function zeroy_runtime_copy_manifest_tree(string $source, string $destination, array $manifest): true|WP_Error
{
    if (!wp_mkdir_p($destination)) {
        return zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not create Artifact staging directory.', 500);
    }
    foreach ($manifest['entries'] as $entry) {
        $from = rtrim($source, '/') . '/' . $entry['path'];
        $to = rtrim($destination, '/') . '/' . $entry['path'];
        if (!wp_mkdir_p(dirname($to)) || !copy($from, $to)) {
            return zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not materialize a ThemeArtifact file.', 500, ['path' => $entry['path']]);
        }
        chmod($to, $entry['mode'] === 'executable' ? 0555 : 0444);
    }
    return true;
}

function zeroy_runtime_artifact_row(string $artifact_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('theme_artifacts') . ' WHERE artifact_id = %s', $artifact_id),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_remove_artifact_tree(string $directory, string $allowed_root): void
{
    $root = realpath($allowed_root);
    $target = realpath($directory);
    if (!is_string($root) || !is_string($target) || !str_starts_with($target . '/', rtrim($root, '/') . '/')) {
        return;
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($target, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $file) {
        if ($file instanceof SplFileInfo) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
    }
    rmdir($target);
}

function zeroy_runtime_remove_artifact_staging(string $directory): void
{
    zeroy_runtime_remove_artifact_tree($directory, zeroy_runtime_staging_root());
}

function zeroy_runtime_remove_artifact_directory(string $directory): void
{
    zeroy_runtime_remove_artifact_tree($directory, zeroy_runtime_artifact_root());
}

function zeroy_runtime_materialize_artifact_archive(array $manifest, string $archive_base64): array|WP_Error
{
    $decoded = base64_decode($archive_base64, true);
    $policy = zeroy_runtime_theme_policy();
    if (!is_string($decoded) || $decoded === '' || strlen($decoded) > $policy['maxArtifactBytes']) {
        return zeroy_runtime_error('zeroy_artifact_archive_invalid', 'ThemeArtifact archive is missing, invalid, or exceeds the site policy.', 400);
    }
    $storage = zeroy_runtime_ensure_artifact_directories();
    if (is_wp_error($storage)) {
        return $storage;
    }
    $artifact_id = zeroy_runtime_manifest_artifact_id($manifest);
    $existing = zeroy_runtime_artifact_row($artifact_id);
    if ($existing !== null && is_dir(zeroy_runtime_artifact_directory($artifact_id))) {
        return ['artifactId' => $artifact_id, 'created' => false];
    }
    $storage_usage = zeroy_runtime_theme_storage_usage();
    $required_bytes = array_sum(array_column($manifest['entries'], 'bytes')) + strlen($decoded);
    if ($storage_usage['bytes'] + $required_bytes > $storage_usage['limit']) {
        return zeroy_runtime_error(
            'zeroy_artifact_storage_limit',
            'ThemeArtifact upload exceeds the site storage policy.',
            409,
            ['usedBytes' => $storage_usage['bytes'], 'requiredBytes' => $required_bytes, 'limitBytes' => $storage_usage['limit']]
        );
    }
    $nonce = wp_generate_uuid4();
    $archive_path = zeroy_runtime_staging_root() . '/' . $nonce . '.tar.gz';
    $tar_path = zeroy_runtime_staging_root() . '/' . $nonce . '.tar';
    $staging = zeroy_runtime_staging_root() . '/' . $nonce;
    if (file_put_contents($archive_path, $decoded, LOCK_EX) !== strlen($decoded)) {
        return zeroy_runtime_error('zeroy_artifact_storage_unavailable', 'Could not stage the uploaded ThemeArtifact archive.', 500);
    }
    try {
        $compressed = new PharData($archive_path);
        $compressed->decompress();
        $archive = new PharData($tar_path);
        $names = [];
        $archive_prefix = 'phar://' . wp_normalize_path($tar_path) . '/';
        foreach (new RecursiveIteratorIterator($archive, RecursiveIteratorIterator::LEAVES_ONLY) as $file) {
            if (!$file instanceof PharFileInfo) {
                continue;
            }
            $path_name = wp_normalize_path($file->getPathname());
            $path = str_starts_with($path_name, $archive_prefix)
                ? substr($path_name, strlen($archive_prefix))
                : '';
            if (!zeroy_runtime_artifact_path_valid($path) || $file->isLink()) {
                return zeroy_runtime_error('zeroy_artifact_archive_invalid', 'ThemeArtifact archive contains an unsafe path or symlink.', 400, ['path' => $path]);
            }
            $names[$path] = true;
        }
        $expected = [];
        foreach ($manifest['entries'] as $entry) {
            $expected[$entry['path']] = $entry;
        }
        ksort($names, SORT_STRING);
        ksort($expected, SORT_STRING);
        if (array_keys($names) !== array_keys($expected)) {
            return zeroy_runtime_error('zeroy_artifact_manifest_mismatch', 'ThemeArtifact archive files do not exactly match its manifest.', 409);
        }
        if (!wp_mkdir_p($staging)) {
            return zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not create Artifact staging directory.', 500);
        }
        foreach ($expected as $path => $entry) {
            $content = $archive[$path]->getContent();
            if (!is_string($content) || strlen($content) !== $entry['bytes'] || !hash_equals($entry['hash'], hash('sha256', $content))) {
                return zeroy_runtime_error('zeroy_artifact_manifest_mismatch', 'ThemeArtifact bytes do not match its manifest.', 409, ['path' => $path]);
            }
            $target = $staging . '/' . $path;
            if (!wp_mkdir_p(dirname($target)) || file_put_contents($target, $content, LOCK_EX) !== strlen($content)) {
                return zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not materialize a ThemeArtifact file.', 500, ['path' => $path]);
            }
            chmod($target, $entry['mode'] === 'executable' ? 0555 : 0444);
        }
        $target = zeroy_runtime_artifact_directory($artifact_id);
        if (!is_dir($target) && !rename($staging, $target)) {
            return zeroy_runtime_error('zeroy_artifact_materialize_failed', 'Could not atomically materialize ThemeArtifact storage.', 500);
        }
        $archive_saved = zeroy_runtime_persist_artifact_archive($artifact_id, $archive_path);
        if (is_wp_error($archive_saved)) {
            return $archive_saved;
        }
        global $wpdb;
        $wpdb->replace(zeroy_runtime_table('theme_artifacts'), [
            'artifact_id' => $artifact_id,
            'manifest_json' => zeroy_runtime_json($manifest),
            // Re-materializing an existing immutable Artifact is repair of its
            // bytes, never a replacement of its already-validated schema
            // snapshot. Clearing it would make an otherwise successful repair
            // leave the active deployment unreadable.
            'schema_json' => $existing['schema_json'] ?? '',
            'schema_hash' => $existing['schema_hash'] ?? '',
            'file_count' => count($manifest['entries']),
            'total_bytes' => array_sum(array_column($manifest['entries'], 'bytes')),
            'created_at' => $existing['created_at'] ?? current_time('mysql', true),
        ], ['%s', '%s', '%s', '%s', '%d', '%d', '%s']);
        return ['artifactId' => $artifact_id, 'created' => true];
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_artifact_archive_invalid', 'ThemeArtifact archive could not be read: ' . $error->getMessage(), 400);
    } finally {
        if (is_file($archive_path)) {
            unlink($archive_path);
        }
        if (is_file($tar_path)) {
            unlink($tar_path);
        }
        if (is_dir($staging)) {
            zeroy_runtime_remove_artifact_staging($staging);
        }
    }
}

function zeroy_runtime_artifact_integrity(string $artifact_id): array|WP_Error
{
    $row = zeroy_runtime_artifact_row($artifact_id);
    if ($row === null) {
        return zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact does not exist.', 404);
    }
    $manifest = zeroy_runtime_decode_json((string) $row['manifest_json']);
    if (is_wp_error($manifest)) {
        return zeroy_runtime_error('zeroy_artifact_corrupt', 'Stored ThemeArtifact manifest is invalid.', 500);
    }
    $normalized = zeroy_runtime_normalize_manifest($manifest);
    if (is_wp_error($normalized)) {
        return zeroy_runtime_error('zeroy_artifact_corrupt', 'Stored ThemeArtifact manifest violates the active policy.', 500);
    }
    $actual = zeroy_runtime_scan_theme_tree(zeroy_runtime_artifact_directory($artifact_id));
    if (is_wp_error($actual) || zeroy_runtime_manifest_artifact_id($actual) !== $artifact_id || zeroy_runtime_json($actual) !== zeroy_runtime_json($normalized)) {
        return ['ok' => false, 'artifactId' => $artifact_id, 'code' => 'theme-drift'];
    }
    return ['ok' => true, 'artifactId' => $artifact_id];
}

function zeroy_runtime_build_artifact_archive(string $artifact_id): string|WP_Error
{
    $row = zeroy_runtime_artifact_row($artifact_id);
    if ($row === null) {
        return zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact does not exist.', 404);
    }
    $manifest = zeroy_runtime_decode_json((string) $row['manifest_json']);
    $manifest = is_wp_error($manifest) ? $manifest : zeroy_runtime_normalize_manifest($manifest);
    if (is_wp_error($manifest)) {
        return zeroy_runtime_error('zeroy_artifact_corrupt', 'ThemeArtifact manifest is invalid.', 500);
    }
    $storage = zeroy_runtime_ensure_artifact_directories();
    if (is_wp_error($storage)) {
        return $storage;
    }
    $final = zeroy_runtime_artifact_archive_path($artifact_id);
    if (is_file($final)) {
        return $final;
    }
    $nonce = wp_generate_uuid4();
    $tar = zeroy_runtime_staging_root() . '/' . $nonce . '.tar';
    $gzip = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) {
            $archive->addFile(zeroy_runtime_artifact_directory($artifact_id) . '/' . $entry['path'], $entry['path']);
        }
        $archive->compress(Phar::GZ);
        if (!rename($gzip, $final)) {
            return zeroy_runtime_error('zeroy_artifact_archive_write_failed', 'Could not store ThemeArtifact archive.', 500);
        }
        return $final;
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_artifact_archive_write_failed', 'Could not create ThemeArtifact archive: ' . $error->getMessage(), 500);
    } finally {
        if (is_file($tar)) {
            unlink($tar);
        }
        if (is_file($gzip)) {
            unlink($gzip);
        }
    }
}

function zeroy_runtime_artifact_archive_base64(string $artifact_id): string|WP_Error
{
    $integrity = zeroy_runtime_artifact_integrity($artifact_id);
    if (is_wp_error($integrity) || ($integrity['ok'] ?? false) !== true) {
        return zeroy_runtime_error('zeroy_theme_drift', 'ThemeArtifact has drifted and cannot be downloaded as an authoritative checkout.', 409);
    }
    $path = zeroy_runtime_build_artifact_archive($artifact_id);
    if (is_wp_error($path)) {
        return $path;
    }
    $bytes = file_get_contents($path);
    return is_string($bytes)
        ? base64_encode($bytes)
        : zeroy_runtime_error('zeroy_artifact_archive_read_failed', 'Could not read ThemeArtifact archive.', 500);
}
