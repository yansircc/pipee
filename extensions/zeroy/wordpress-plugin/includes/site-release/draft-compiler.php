<?php

defined('ABSPATH') || exit;

function zeroy_runtime_copy_directory_tree(string $source, string $destination): true|WP_Error
{
    if (!is_dir($source) || is_link($source) || !wp_mkdir_p($destination)) {
        return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not prepare the SiteArtifact staging directory.', 500);
    }
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    foreach ($iterator as $entry) {
        if (!$entry instanceof SplFileInfo || $entry->isLink()) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'SiteArtifact contains an unsafe link.', 409);
        $relative = ltrim(substr(wp_normalize_path($entry->getPathname()), strlen(rtrim(wp_normalize_path($source), '/'))), '/');
        $target = rtrim($destination, '/') . '/' . $relative;
        if ($entry->isDir()) {
            if (!wp_mkdir_p($target)) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not create a staged artifact directory.', 500, ['path' => $relative]);
        } elseif (!copy($entry->getPathname(), $target)) {
            return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not copy a base SiteArtifact file.', 500, ['path' => $relative]);
        }
    }
    return true;
}

function zeroy_runtime_site_draft_artifact_archive(string $root, array $manifest): string|WP_Error
{
    $nonce = wp_generate_uuid4();
    $tar = zeroy_runtime_staging_root() . '/' . $nonce . '.tar';
    $gz = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) {
            $path = $entry['path'];
            $archive->addFile(rtrim($root, '/') . '/' . $path, $path);
        }
        $archive->compress(Phar::GZ);
        unset($archive);
        if (!is_file($gz)) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not compress the staged SiteArtifact.', 500);
        $encoded = file_get_contents($gz);
        return is_string($encoded) ? base64_encode($encoded) : zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not read the staged SiteArtifact archive.', 500);
    } catch (Throwable $error) {
        return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not build the staged SiteArtifact archive: ' . $error->getMessage(), 500);
    } finally {
        foreach ([$tar, $gz] as $path) if (is_file($path)) unlink($path);
    }
}

function zeroy_runtime_site_draft_artifact_base_directory(string $artifact, ?array $base_release): ?string
{
    $base_id = is_array($base_release)
        ? (string) ($artifact === 'theme' ? ($base_release['theme_artifact_id'] ?? '') : ($base_release['site_logic_artifact_id'] ?? ''))
        : '';
    if ($base_id !== '') {
        return $artifact === 'theme'
            ? zeroy_runtime_artifact_directory($base_id)
            : zeroy_runtime_site_logic_directory($base_id);
    }
    return $artifact === 'site-logic' ? dirname(__DIR__, 2) . '/default-site-logic' : null;
}

function zeroy_runtime_scan_site_draft_artifact(string $artifact, string $directory): array|WP_Error
{
    return $artifact === 'theme'
        ? zeroy_runtime_scan_theme_tree($directory)
        : zeroy_runtime_scan_site_logic_tree($directory);
}

function zeroy_runtime_materialize_site_draft_artifact(string $artifact, array $manifest, string $archive): array|WP_Error
{
    return $artifact === 'theme'
        ? zeroy_runtime_materialize_artifact_archive($manifest, $archive)
        : zeroy_runtime_site_logic_materialize_artifact_archive($manifest, $archive);
}

/**
 * Replays the one Draft operation log against its immutable base manifest.
 *
 * This projection is the only owner of optimistic artifact-hash semantics:
 * staging uses it to reject a stale edit immediately and compilation uses it
 * again before materializing bytes. The returned map is derived state, never
 * another writable workspace.
 */
function zeroy_runtime_replay_site_draft_artifact_hashes(string $artifact, ?array $base_release, array $operations): array|WP_Error
{
    if (!in_array($artifact, ['theme', 'site-logic'], true)) {
        return zeroy_runtime_error('zeroy_site_draft_artifact_invalid', 'SiteDraft artifact kind is invalid.', 500);
    }
    $base_directory = zeroy_runtime_site_draft_artifact_base_directory($artifact, $base_release);
    $manifest = $base_directory === null
        ? ['entries' => []]
        : zeroy_runtime_scan_site_draft_artifact($artifact, $base_directory);
    if (is_wp_error($manifest)) return $manifest;
    $hashes = [];
    foreach ($manifest['entries'] as $entry) {
        if (is_string($entry['path'] ?? null) && is_string($entry['hash'] ?? null)) {
            $hashes[$entry['path']] = $entry['hash'];
        }
    }
    foreach ($operations as $operation) {
        if (($operation['kind'] ?? null) !== 'artifact.files' || ($operation['payload']['artifact'] ?? null) !== $artifact) {
            continue;
        }
        foreach (($operation['payload']['files'] ?? []) as $file) {
            $path = is_array($file) ? ($file['path'] ?? null) : null;
            $expected = is_array($file) ? ($file['expectedHash'] ?? null) : null;
            if (!is_string($path) || !zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path)) {
                return zeroy_runtime_error('zeroy_site_draft_artifact_path_invalid', 'Staged artifact path is invalid or forbidden.', 400, ['artifact' => $artifact, 'path' => $path]);
            }
            $current = $hashes[$path] ?? null;
            if ($current !== $expected) {
                return zeroy_runtime_error(
                    'zeroy_site_artifact_hash_conflict',
                    'Artifact file changed since it was read or staged.',
                    409,
                    ['artifact' => $artifact, 'path' => $path, 'expectedHash' => $expected, 'currentHash' => $current],
                );
            }
            if (($file['content'] ?? null) === null) {
                unset($hashes[$path]);
            } else {
                $hashes[$path] = hash('sha256', (string) $file['content']);
            }
        }
    }
    ksort($hashes, SORT_STRING);
    return $hashes;
}

/**
 * Projects one Draft artifact into an ephemeral directory. Both Candidate
 * inspection and immutable artifact materialization use this exact replay,
 * so a candidate contract cannot describe bytes different from commit.
 */
function zeroy_runtime_with_site_draft_artifact_directory(array $draft, ?array $base_release, string $artifact, callable $use): mixed
{
    if (!in_array($artifact, ['theme', 'site-logic'], true)) return zeroy_runtime_error('zeroy_site_draft_artifact_invalid', 'SiteDraft artifact kind is invalid.', 500);
    $operations = zeroy_runtime_site_draft_operations($draft);
    if (is_wp_error($operations)) return $operations;
    $hashes = zeroy_runtime_replay_site_draft_artifact_hashes($artifact, $base_release, $operations);
    if (is_wp_error($hashes)) return $hashes;
    $artifact_operations = array_values(array_filter(
        $operations,
        static fn(array $operation): bool => ($operation['kind'] ?? null) === 'artifact.files' && (($operation['payload']['artifact'] ?? null) === $artifact),
    ));
    $staging = zeroy_runtime_staging_root() . '/draft-' . wp_generate_uuid4();
    if (!wp_mkdir_p(zeroy_runtime_staging_root())) {
        return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not prepare the SiteArtifact staging root.', 500);
    }
    try {
        $base_directory = zeroy_runtime_site_draft_artifact_base_directory($artifact, $base_release);
        if ($base_directory === null) {
            if (!wp_mkdir_p($staging)) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not prepare the bootstrap SiteArtifact staging directory.', 500);
        } else {
            $copied = zeroy_runtime_copy_directory_tree($base_directory, $staging);
            if (is_wp_error($copied)) return $copied;
        }
        foreach ($artifact_operations as $operation) {
            foreach (($operation['payload']['files'] ?? []) as $file) {
                $path = (string) ($file['path'] ?? '');
                $target = $staging . '/' . $path;
                if (array_key_exists('content', $file) && $file['content'] === null) {
                    if (!is_file($target) || !unlink($target)) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not delete staged artifact file.', 500, ['path' => $path]);
                    continue;
                }
                if (!wp_mkdir_p(dirname($target)) || file_put_contents($target, (string) $file['content'], LOCK_EX) !== strlen((string) $file['content'])) return zeroy_runtime_error('zeroy_site_draft_artifact_compile_failed', 'Could not write staged artifact file.', 500, ['path' => $path]);
            }
        }
        $manifest = zeroy_runtime_scan_site_draft_artifact($artifact, $staging);
        if (is_wp_error($manifest)) return $manifest;
        $materialized_hashes = [];
        foreach ($manifest['entries'] as $entry) $materialized_hashes[$entry['path']] = $entry['hash'];
        if ($materialized_hashes !== $hashes) {
            return zeroy_runtime_error('zeroy_site_draft_artifact_projection_invalid', 'Materialized SiteArtifact differs from its Draft operation projection.', 500, ['artifact' => $artifact]);
        }
        return $use($staging, $manifest);
    } finally {
        if (is_dir($staging)) zeroy_runtime_remove_artifact_staging($staging);
    }
}

function zeroy_runtime_compile_site_draft_artifact(array $draft, ?array $base_release, string $artifact): array|WP_Error
{
    $storage = zeroy_runtime_ensure_artifact_directories();
    if (is_wp_error($storage)) return $storage;
    $logic_storage = zeroy_runtime_site_logic_ensure_directories();
    if (is_wp_error($logic_storage)) return $logic_storage;
    return zeroy_runtime_with_site_draft_artifact_directory(
        $draft,
        $base_release,
        $artifact,
        static function (string $directory, array $manifest) use ($artifact): array|WP_Error {
            $archive = zeroy_runtime_site_draft_artifact_archive($directory, $manifest);
            if (is_wp_error($archive)) return $archive;
            $materialized = zeroy_runtime_materialize_site_draft_artifact($artifact, $manifest, $archive);
            return is_wp_error($materialized) ? $materialized : ['artifactId' => $materialized['artifactId'], 'manifest' => $manifest];
        },
    );
}

function zeroy_runtime_compile_site_draft(array $draft, ?array $base_release): array|WP_Error
{
    $theme = zeroy_runtime_compile_site_draft_artifact($draft, $base_release, 'theme');
    if (is_wp_error($theme)) return $theme;
    $site_logic = zeroy_runtime_compile_site_draft_artifact($draft, $base_release, 'site-logic');
    if (is_wp_error($site_logic)) return $site_logic;
    $site_logic_artifact_id = (string) ($site_logic['artifactId'] ?? '');
    if ($site_logic_artifact_id === '') return zeroy_runtime_error('zeroy_site_draft_site_logic_missing', 'SiteDraft could not resolve the connector-owned base SiteLogicArtifact.', 500);
    return [
        'themeArtifactId' => $theme['artifactId'],
        'siteLogicArtifactId' => $site_logic_artifact_id,
        'operationsHash' => zeroy_runtime_hash(zeroy_runtime_site_draft_operations($draft)),
    ];
}

function zeroy_runtime_draft_subject_with_refs(mixed $subject, array $refs): array|WP_Error
{
    if (!is_array($subject)) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Translation subject must be an object.', 400);
    if (($subject['kind'] ?? null) === 'post' && is_string($subject['ref'] ?? null)) {
        $ref = $subject['ref'];
        if (!isset($refs[$ref])) return zeroy_runtime_error('zeroy_site_draft_ref_missing', "Unknown staged canonical ref {$ref}.", 409, ['ref' => $ref]);
        $subject['id'] = $refs[$ref];
        unset($subject['ref']);
    }
    return $subject;
}

function zeroy_runtime_materialization_subject_definition(array $schema, array $subject): array|WP_Error
{
    if (($subject['kind'] ?? null) === 'post' && is_int($subject['id'] ?? null)) {
        $canonical = zeroy_runtime_canonical($subject['id']);
        if (is_wp_error($canonical)) return $canonical;
        $definition = $schema['schemas'][$canonical['schemaId']] ?? null;
    } else {
        $key = ($subject['kind'] ?? null) === 'site-copy' ? 'siteCopy' : ($subject['kind'] ?? null);
        $definition = is_string($key) ? ($schema['localizationSubjects'][$key] ?? null) : null;
    }
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_localization_definition_missing', 'SiteDraft materialization cannot resolve the candidate LocalizableSubject definition.', 409, ['subject' => $subject]);
}

function zeroy_runtime_apply_site_draft_content_operations(mixed $operations, array $schema): true|WP_Error
{
    if (!is_array($operations) || !array_is_list($operations)) return zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'DraftSnapshot materialization plan is invalid.', 409);
    $refs = [];
    foreach ($operations as $operation) {
        $kind = $operation['kind'] ?? null;
        $payload = $operation['payload'] ?? null;
        if ($kind === 'artifact.files') continue;
        if (!is_string($kind) || !is_array($payload)) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Draft operation is malformed.', 400);
        if ($kind === 'retireCanonical') {
            $result = zeroy_runtime_retire_canonical((int) ($payload['objectId'] ?? 0), (int) ($payload['expectedRevision'] ?? -1));
        } elseif ($kind === 'assignSchema' || $kind === 'writeTemplateContent' || $kind === 'writeCanonicalContent') {
            $object_id = zeroy_runtime_draft_ref_id($payload['objectRef'] ?? null, $refs);
            if (is_wp_error($object_id)) return $object_id;
            $canonical = zeroy_runtime_canonical($object_id);
            if (is_wp_error($canonical)) return $canonical;
            $definition_id = $kind === 'assignSchema' ? (string) ($payload['schemaId'] ?? '') : (string) $canonical['schemaId'];
            $definition = $schema['schemas'][$definition_id] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'SiteDraft materialization references a missing candidate schema.', 409, ['schemaId' => $definition_id]);
            $result = $kind === 'assignSchema'
                ? zeroy_runtime_assign_canonical_schema($object_id, $definition_id, $definition, (int) ($payload['expectedRevision'] ?? -1))
                : ($kind === 'writeTemplateContent'
                    ? zeroy_runtime_write_template_content($object_id, $definition, $payload['templateContent'] ?? null, (int) ($payload['expectedRevision'] ?? -1))
                    : zeroy_runtime_write_canonical_content($object_id, $payload));
        } elseif ($kind === 'writeTranslationDraft' || $kind === 'publishTranslation' || $kind === 'unpublishTranslation') {
            $subject = zeroy_runtime_draft_subject_with_refs($payload['subject'] ?? null, $refs);
            if (is_wp_error($subject)) return $subject;
            $definition = zeroy_runtime_materialization_subject_definition($schema, $subject);
            if (is_wp_error($definition)) return $definition;
            $result = match ($kind) {
                'writeTranslationDraft' => zeroy_localization_write_translation_values($subject, (string) ($payload['locale'] ?? ''), $definition, $payload['values'] ?? null, (int) ($payload['expectedRevision'] ?? -1)),
                'publishTranslation' => zeroy_localization_publish_translation($subject, (string) ($payload['locale'] ?? ''), $definition, (int) ($payload['expectedRevision'] ?? -1)),
                default => zeroy_localization_unpublish_translation($subject, (string) ($payload['locale'] ?? ''), $definition, (int) ($payload['expectedRevision'] ?? -1)),
            };
        } else {
        $result = match ($kind) {
            'siteConfig' => is_array($payload['siteConfig'] ?? null) ? zeroy_runtime_write_site_config_locked((array) $payload['siteConfig'], (int) ($payload['expectedRevision'] ?? -1)) : zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'siteConfig operation requires siteConfig.', 400),
            'createCanonical' => is_array($schema['schemas'][$payload['schemaId'] ?? ''] ?? null) ? zeroy_runtime_create_canonical(
                (string) ($payload['postType'] ?? ''),
                (string) ($payload['schemaId'] ?? ''),
                $schema['schemas'][$payload['schemaId']],
                (string) ($payload['route'] ?? ''),
                (string) ($payload['postTitle'] ?? ''),
                (string) ($payload['postContent'] ?? ''),
                (string) ($payload['postExcerpt'] ?? ''),
                is_array($payload['templateContent'] ?? null) ? $payload['templateContent'] : [],
            ) : zeroy_runtime_error('zeroy_schema_not_found', 'createCanonical references a missing candidate schema.', 409),
            'adoptCanonical' => is_array($schema['schemas'][$payload['schemaId'] ?? ''] ?? null)
                ? zeroy_runtime_adopt_canonical((int) ($payload['postId'] ?? 0), (string) ($payload['schemaId'] ?? ''), $schema['schemas'][$payload['schemaId']], (string) ($payload['route'] ?? ''), (string) ($payload['expectedSourceHash'] ?? ''))
                : zeroy_runtime_error('zeroy_schema_not_found', 'adoptCanonical references a missing candidate schema.', 409),
            default => zeroy_runtime_error('zeroy_site_draft_operation_invalid', "Unsupported SiteDraft operation {$kind}.", 400),
        };
        }
        if (is_wp_error($result)) return $result;
        if ($kind === 'createCanonical') {
            $ref = $payload['ref'] ?? null;
            $object_id = is_array($result) ? ($result['objectId'] ?? null) : null;
            if (!is_string($ref) || !is_int($object_id)) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'createCanonical requires a ref and returned an invalid object.', 500);
            $refs[$ref] = $object_id;
        }
    }
    return true;
}

function zeroy_runtime_draft_ref_id(mixed $ref, array $refs): int|WP_Error
{
    if (is_int($ref) && $ref > 0) return $ref;
    if (is_string($ref) && isset($refs[$ref])) return (int) $refs[$ref];
    return zeroy_runtime_error('zeroy_site_draft_ref_missing', 'A staged canonical ref is missing or invalid.', 409, ['ref' => $ref]);
}
