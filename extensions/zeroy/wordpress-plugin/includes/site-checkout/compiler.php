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

function zeroy_checkout_documents(array $files, string $prefix, string $contract): array|WP_Error
{
    $documents = [];
    foreach ($files as $path => $file) {
        if (!str_starts_with($path, $prefix) || !str_ends_with($path, '.json')) continue;
        $decoded = json_decode((string) $file['bytes'], true);
        if (!zeroy_runtime_is_keyed_map($decoded) || ($decoded['contract'] ?? null) !== $contract || !is_string($decoded['ref'] ?? null)) return zeroy_runtime_error('zeroy_checkout_document_invalid', 'Checkout document violates its contract.', 409, ['path' => $path, 'contract' => $contract]);
        if (isset($documents[$decoded['ref']])) return zeroy_runtime_error('zeroy_checkout_ref_conflict', 'Checkout contains duplicate stable refs.', 409, ['ref' => $decoded['ref']]);
        $documents[$decoded['ref']] = $decoded;
    }
    ksort($documents, SORT_STRING);
    return $documents;
}

function zeroy_checkout_canonical_parts(array $document): array
{
    $view = is_array($document['canonical'] ?? null) ? $document['canonical'] : [];
    $post = is_array($view['post'] ?? null) ? $view['post'] : [];
    return [
        'postTitle' => (string) ($post['title'] ?? ''),
        'postContent' => (string) ($post['content'] ?? ''),
        'postExcerpt' => (string) ($post['excerpt'] ?? ''),
        'acf' => is_array($view['acf'] ?? null) ? $view['acf'] : [],
        'templateContent' => is_array($view['templateContent'] ?? null) ? $view['templateContent'] : [],
    ];
}

function zeroy_checkout_translation_diff(array $files, array $snapshot, ?array $base, array $subject, string $ref, string $directory, string $contract): array|WP_Error
{
    $operations = [];
    $default_locale = (string) $snapshot['siteConfig']['defaultLocale'];
    $desired = [];
    foreach ($files as $path => $file) {
        if (preg_match('#\Atranslations/([^/]+)/' . preg_quote($directory, '#') . '/[^/]+\.json\z#', $path, $match) !== 1) continue;
        $translation = json_decode((string) $file['bytes'], true);
        if (!is_array($translation) || ($translation['contract'] ?? null) !== $contract || ($translation['ref'] ?? null) !== $ref) continue;
        $locale = (string) $match[1];
        if ($locale === $default_locale) return zeroy_runtime_error('zeroy_checkout_translation_invalid', 'Default locale must remain canonical.', 409, ['path' => $path]);
        $overlay = is_array($translation['overlay'] ?? null) ? $translation['overlay'] : null;
        if ($overlay === null || !is_array($overlay['values'] ?? null)) return zeroy_runtime_error('zeroy_checkout_translation_invalid', 'Published translation document requires an overlay values map.', 409, ['path' => $path]);
        $desired[$locale] = $overlay;
        $current = is_array($base) && is_array($base['locales'][$locale] ?? null) ? $base['locales'][$locale] : ['revision' => 0, 'publishedOverlay' => null];
        if (($current['publishedOverlay'] ?? null) === $overlay) continue;
        $values = [];
        foreach ($overlay['values'] as $field_id => $stored) if (is_array($stored) && array_key_exists('value', $stored)) $values[$field_id] = $stored['value'];
        $revision = (int) ($current['revision'] ?? 0);
        $operations[] = ['kind' => 'writeTranslationDraft', 'payload' => ['subject' => $subject, 'locale' => $locale, 'values' => $values, 'expectedRevision' => $revision]];
        $operations[] = ['kind' => 'publishTranslation', 'payload' => ['subject' => $subject, 'locale' => $locale, 'expectedRevision' => $revision + 1]];
    }
    foreach (is_array($base['locales'] ?? null) ? $base['locales'] : [] as $locale => $current) {
        if ($locale === $default_locale || isset($desired[$locale]) || !is_array($current['publishedOverlay'] ?? null)) continue;
        $operations[] = ['kind' => 'unpublishTranslation', 'payload' => ['subject' => $subject, 'locale' => $locale, 'expectedRevision' => (int) ($current['revision'] ?? 0)]];
    }
    return $operations;
}

function zeroy_checkout_term_operations(array $documents, array $snapshot): array|WP_Error
{
    $operations = [];
    $owned = [];
    foreach ($documents as $ref => $document) {
        $taxonomy = (string) ($document['taxonomy'] ?? '');
        $slug = (string) ($document['slug'] ?? '');
        $canonical = is_array($document['canonical'] ?? null) ? $document['canonical'] : [];
        $name = (string) ($canonical['term']['name'] ?? '');
        $description = (string) ($canonical['term']['description'] ?? '');
        $source_id = is_int($document['sourceObjectId'] ?? null) ? $document['sourceObjectId'] : null;
        $base = null;
        $base_key = null;
        foreach ($snapshot['terms'] as $key => $term) if ($source_id !== null && ($term['subject']['id'] ?? null) === $source_id && ($term['taxonomy'] ?? null) === $taxonomy) { $base = $term; $base_key = $key; break; }
        if ($base === null) {
            $operations[] = ['kind' => 'createTerm', 'payload' => ['ref' => $ref, 'taxonomy' => $taxonomy, 'slug' => $slug, 'name' => $name, 'description' => $description]];
        } else {
            $owned[$base_key] = true;
            $view = is_array($base['localizable']['view']['term'] ?? null) ? $base['localizable']['view']['term'] : [];
            if ($slug !== ($base['slug'] ?? null) || $name !== ($view['name'] ?? null) || $description !== ($view['description'] ?? null)) {
                $operations[] = ['kind' => 'updateTerm', 'payload' => ['termId' => $source_id, 'taxonomy' => $taxonomy, 'slug' => $slug, 'name' => $name, 'description' => $description, 'expectedSourceHash' => (string) $base['localizable']['canonicalRevision']]];
            }
        }
    }
    foreach ($snapshot['terms'] as $key => $term) if (!isset($owned[$key]) && is_int($term['subject']['id'] ?? null)) $operations[] = ['kind' => 'retireTerm', 'payload' => ['termId' => $term['subject']['id'], 'taxonomy' => $term['taxonomy'], 'expectedSourceHash' => (string) $term['localizable']['canonicalRevision']]];
    return $operations;
}

function zeroy_checkout_site_copy_translation_operations(array $files, array $snapshot): array|WP_Error
{
    $operations = [];
    $desired = [];
    $base = is_array($snapshot['siteCopy'] ?? null) ? $snapshot['siteCopy'] : null;
    foreach ($files as $path => $file) {
        if (preg_match('#\Atranslations/([^/]+)/site-copy\.json\z#', $path, $match) !== 1) continue;
        $translation = json_decode((string) $file['bytes'], true);
        if (!is_array($translation) || ($translation['contract'] ?? null) !== 'zeroy/site-copy-translation@1' || !is_array($translation['overlay']['values'] ?? null)) return zeroy_runtime_error('zeroy_checkout_translation_invalid', 'SiteCopy translation document is invalid.', 409, ['path' => $path]);
        $locale = (string) $match[1];
        $overlay = $translation['overlay'];
        $desired[$locale] = true;
        $current = is_array($base['locales'][$locale] ?? null) ? $base['locales'][$locale] : ['revision' => 0, 'publishedOverlay' => null];
        if (($current['publishedOverlay'] ?? null) === $overlay) continue;
        $values = [];
        foreach ($overlay['values'] as $field_id => $stored) if (is_array($stored) && array_key_exists('value', $stored)) $values[$field_id] = $stored['value'];
        $revision = (int) ($current['revision'] ?? 0);
        $subject = ['kind' => 'site-copy', 'id' => 'default'];
        $operations[] = ['kind' => 'writeTranslationDraft', 'payload' => ['subject' => $subject, 'locale' => $locale, 'values' => $values, 'expectedRevision' => $revision]];
        $operations[] = ['kind' => 'publishTranslation', 'payload' => ['subject' => $subject, 'locale' => $locale, 'expectedRevision' => $revision + 1]];
    }
    foreach (is_array($base['locales'] ?? null) ? $base['locales'] : [] as $locale => $current) {
        if ($locale === ($snapshot['siteConfig']['defaultLocale'] ?? null) || isset($desired[$locale]) || !is_array($current['publishedOverlay'] ?? null)) continue;
        $operations[] = ['kind' => 'unpublishTranslation', 'payload' => ['subject' => ['kind' => 'site-copy', 'id' => 'default'], 'locale' => $locale, 'expectedRevision' => (int) ($current['revision'] ?? 0)]];
    }
    return $operations;
}

function zeroy_checkout_compile_operations(array $files, array $snapshot): array|WP_Error
{
    $site = zeroy_checkout_json_file($files, 'site.json');
    if (is_wp_error($site) || ($site['contract'] ?? null) !== 'zeroy/site@1' || !is_array($site['config'] ?? null)) return is_wp_error($site) ? $site : zeroy_runtime_error('zeroy_checkout_site_invalid', 'site.json must contain the zeroY site config.', 409);
    $operations = [];
    $site_copy = zeroy_checkout_json_file($files, 'content/site-copy.json');
    if (is_wp_error($site_copy) || ($site_copy['contract'] ?? null) !== 'zeroy/site-copy@1' || !is_array($site_copy['canonical'] ?? null)) return is_wp_error($site_copy) ? $site_copy : zeroy_runtime_error('zeroy_checkout_site_copy_invalid', 'content/site-copy.json must own canonical SiteCopy.', 409);
    $config = [...$site['config'], 'siteCopy' => $site_copy['canonical']];
    $current_config = array_diff_key($snapshot['siteConfig'], ['revision' => true]);
    if ($config !== $current_config) $operations[] = ['kind' => 'siteConfig', 'payload' => ['siteConfig' => $config, 'expectedRevision' => (int) $snapshot['siteConfig']['revision']]];
    $documents = zeroy_checkout_documents($files, 'content/posts/', 'zeroy/post@1');
    if (is_wp_error($documents)) return $documents;
    $term_documents = zeroy_checkout_documents($files, 'content/terms/', 'zeroy/term@1');
    if (is_wp_error($term_documents)) return $term_documents;
    $term_operations = zeroy_checkout_term_operations($term_documents, $snapshot);
    if (is_wp_error($term_operations)) return $term_operations;
    foreach ($term_operations as $operation) if (($operation['kind'] ?? null) !== 'retireTerm') $operations[] = $operation;
    $owned = [];
    foreach ($documents as $ref => $document) {
        $source_id = is_int($document['sourceObjectId'] ?? null) ? $document['sourceObjectId'] : null;
        $identity = $source_id === null ? 'draft:' . $ref : 'post:' . $source_id;
        $owned[$identity] = true;
        $base = $snapshot['entities'][$identity] ?? null;
        $parts = zeroy_checkout_canonical_parts($document);
        if (!is_array($base)) {
            if ($source_id === null) {
                $operations[] = ['kind' => 'createCanonical', 'payload' => ['ref' => $ref, 'postType' => (string) ($document['postType'] ?? ''), 'schemaId' => (string) ($document['schemaId'] ?? ''), 'route' => (string) ($document['route'] ?? ''), 'postTitle' => $parts['postTitle'], 'postContent' => $parts['postContent'], 'postExcerpt' => $parts['postExcerpt'], 'templateContent' => $parts['templateContent']]];
                if ($parts['acf'] !== []) $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => ['objectRef' => $ref, 'acf' => $parts['acf'], 'expectedRevision' => 1]];
                $object_ref = $ref;
                $subject = ['kind' => 'post', 'ref' => $ref];
            } else {
                $source_hash = $document['expectedSourceHash'] ?? null;
                if (!is_string($source_hash) || preg_match('/\A[a-f0-9]{64}\z/', $source_hash) !== 1) return zeroy_runtime_error('zeroy_adoption_source_hash_missing', 'Adopting sourceObjectId requires expectedSourceHash from inspect inventory.', 409, ['ref' => $ref]);
                $operations[] = ['kind' => 'adoptCanonical', 'payload' => ['postId' => $source_id, 'schemaId' => (string) ($document['schemaId'] ?? ''), 'route' => (string) ($document['route'] ?? ''), 'expectedSourceHash' => $source_hash]];
                $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => ['objectRef' => $source_id, 'postTitle' => $parts['postTitle'], 'postContent' => $parts['postContent'], 'postExcerpt' => $parts['postExcerpt'], 'acf' => $parts['acf'], 'expectedRevision' => 1]];
                if ($parts['templateContent'] !== []) $operations[] = ['kind' => 'writeTemplateContent', 'payload' => ['objectRef' => $source_id, 'templateContent' => $parts['templateContent'], 'expectedRevision' => 2]];
                $object_ref = $source_id;
                $subject = ['kind' => 'post', 'id' => $source_id];
            }
            if (is_array($document['terms'] ?? null) && $document['terms'] !== []) $operations[] = ['kind' => 'assignTerms', 'payload' => ['objectRef' => $object_ref, 'terms' => $document['terms']]];
            $translations = zeroy_checkout_translation_diff($files, $snapshot, null, $subject, $ref, 'posts', 'zeroy/post-translation@1');
            if (is_wp_error($translations)) return $translations;
            $operations = [...$operations, ...$translations];
            continue;
        }
        $revision = (int) $base['revision'];
        if (($document['schemaId'] ?? null) !== ($base['schemaId'] ?? null)) {
            $operations[] = ['kind' => 'assignSchema', 'payload' => ['objectRef' => $source_id, 'schemaId' => (string) $document['schemaId'], 'expectedRevision' => $revision]];
            $revision++;
        }
        $base_view = is_array($base['localizable']['view'] ?? null) ? $base['localizable']['view'] : [];
        $base_parts = zeroy_checkout_canonical_parts(['canonical' => $base_view]);
        $write = ['objectRef' => $source_id, 'expectedRevision' => $revision];
        foreach (['postTitle', 'postContent', 'postExcerpt', 'acf'] as $field) if ($parts[$field] !== $base_parts[$field]) $write[$field] = $parts[$field];
        if (($document['route'] ?? null) !== ($base['route'] ?? null)) $write['route'] = (string) $document['route'];
        if (count($write) > 2) {
            $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => $write];
            $revision++;
        }
        if ($parts['templateContent'] !== $base_parts['templateContent']) $operations[] = ['kind' => 'writeTemplateContent', 'payload' => ['objectRef' => $source_id, 'templateContent' => $parts['templateContent'], 'expectedRevision' => $revision]];
        $desired_terms = is_array($document['terms'] ?? null) ? $document['terms'] : [];
        foreach (is_array($base['terms'] ?? null) ? $base['terms'] : [] as $taxonomy => $_slugs) {
            if (!array_key_exists($taxonomy, $desired_terms)) $desired_terms[$taxonomy] = [];
        }
        ksort($desired_terms, SORT_STRING);
        $base_terms = is_array($base['terms'] ?? null) ? $base['terms'] : [];
        ksort($base_terms, SORT_STRING);
        if ($desired_terms !== $base_terms) $operations[] = ['kind' => 'assignTerms', 'payload' => ['objectRef' => $source_id, 'terms' => $desired_terms]];
        $translations = zeroy_checkout_translation_diff($files, $snapshot, $base, ['kind' => 'post', 'id' => $source_id], $ref, 'posts', 'zeroy/post-translation@1');
        if (is_wp_error($translations)) return $translations;
        $operations = [...$operations, ...$translations];
    }
    foreach ($snapshot['entities'] as $identity => $entity) if (!isset($owned[$identity]) && is_int($entity['objectId'] ?? null)) $operations[] = ['kind' => 'retireCanonical', 'payload' => ['objectId' => $entity['objectId'], 'expectedRevision' => (int) $entity['revision']]];
    foreach ($term_documents as $ref => $document) {
        $source_id = is_int($document['sourceObjectId'] ?? null) ? $document['sourceObjectId'] : null;
        $base = null;
        foreach ($snapshot['terms'] as $term) if ($source_id !== null && ($term['subject']['id'] ?? null) === $source_id && ($term['taxonomy'] ?? null) === ($document['taxonomy'] ?? null)) { $base = $term; break; }
        $subject = $source_id === null
            ? ['kind' => 'term', 'taxonomy' => (string) $document['taxonomy'], 'ref' => $ref]
            : ['kind' => 'term', 'taxonomy' => (string) $document['taxonomy'], 'id' => $source_id];
        $translations = zeroy_checkout_translation_diff($files, $snapshot, $base, $subject, $ref, 'terms', 'zeroy/term-translation@1');
        if (is_wp_error($translations)) return $translations;
        $operations = [...$operations, ...$translations];
    }
    $site_copy_translations = zeroy_checkout_site_copy_translation_operations($files, $snapshot);
    if (is_wp_error($site_copy_translations)) return $site_copy_translations;
    $operations = [...$operations, ...$site_copy_translations];
    foreach ($term_operations as $operation) if (($operation['kind'] ?? null) === 'retireTerm') $operations[] = $operation;
    return $operations;
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
    $operations = zeroy_checkout_compile_operations($files, $snapshot);
    if (is_wp_error($operations)) return $operations;
    $snapshot = zeroy_runtime_apply_operations_to_snapshot($snapshot, $operations, $compiled['contract'], $compiled['schema']);
    if (is_wp_error($snapshot)) return $snapshot;
    $snapshot['materializationPlan'] = $operations;
    $snapshot['operationsHash'] = zeroy_runtime_hash($operations);
    $snapshot['themeArtifactId'] = $artifacts['theme']['artifactId'];
    $snapshot['siteLogicArtifactId'] = $artifacts['siteLogic']['artifactId'];
    $snapshot['snapshotHash'] = zeroy_runtime_hash($snapshot);
    return ['commit' => $row, 'files' => $files, 'artifacts' => $artifacts, 'compiled' => $compiled, 'snapshot' => $snapshot, 'operations' => $operations];
}
