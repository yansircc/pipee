<?php

defined('ABSPATH') || exit;

function zeroy_runtime_authorized(WP_REST_Request $request): bool
{
    $provided = (string) $request->get_header('x-zeroy-key');
    return $provided !== '' && hash_equals(zeroy_runtime_connection_key(), $provided);
}

function zeroy_runtime_response_error(WP_Error $error): WP_REST_Response
{
    $data = $error->get_error_data();
    $status = is_array($data) && isset($data['status']) ? (int) $data['status'] : 400;
    return new WP_REST_Response([
        'error' => [
            'code' => $error->get_error_code(),
            'message' => $error->get_error_message(),
            'data' => $data,
        ],
    ], $status);
}

function zeroy_runtime_payload(WP_REST_Request $request): array|WP_Error
{
    $payload = $request->get_json_params();
    return is_array($payload) && !array_is_list($payload)
        ? $payload
        : zeroy_runtime_error('zeroy_invalid_payload', 'Expected a JSON object payload.', 400);
}

function zeroy_runtime_site_endpoint(): WP_REST_Response
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return zeroy_runtime_response_error($config);
    }
    $diagnostics = zeroy_runtime_schema_diagnostics();
    $theme = wp_get_theme();
    return new WP_REST_Response([
        'contract' => 'zeroy/site@1',
        'runtimeVersion' => ZEROY_RUNTIME_VERSION,
        'siteId' => zeroy_runtime_site_id(),
        'siteConfig' => $config,
        'contentOwnership' => zeroy_runtime_content_ownership(),
        'activeTheme' => [
            'name' => $theme->get('Name'),
            'stylesheet' => get_stylesheet(),
            'root' => get_stylesheet_directory(),
        ],
        'themeSchema' => [
            'valid' => $diagnostics['valid'],
            'contractHash' => $diagnostics['contractHash'] ?? null,
            'schemaHashes' => $diagnostics['schemaHashes'] ?? [],
            'errors' => $diagnostics['errors'],
        ],
        'capabilities' => [
            'siteConfig' => true,
            'schema' => true,
            'inventory' => true,
            'acf' => true,
            'adoptionCandidates' => true,
            'existingPost' => true,
            'themeFiles' => true,
            'localeContent' => true,
            'canonicalObjects' => true,
            'themeCopy' => array_key_exists('themeCopy', $diagnostics['schema'] ?? []),
            'integrity' => true,
        ],
    ]);
}

function zeroy_runtime_schema_endpoint(): WP_REST_Response
{
    $diagnostics = zeroy_runtime_schema_diagnostics();
    if (!$diagnostics['valid']) {
        return zeroy_runtime_response_error(
            zeroy_runtime_error(
                'zeroy_schema_invalid',
                'ThemeSchema is invalid.',
                409,
                ['violations' => $diagnostics['errors']]
            )
        );
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/schema@1',
        'schema' => $diagnostics['schema'],
        'contractHash' => $diagnostics['contractHash'],
        'schemaHashes' => $diagnostics['schemaHashes'],
        'language' => zeroy_runtime_theme_schema_capabilities(),
    ]);
}

function zeroy_runtime_inventory_endpoint(WP_REST_Request $request): WP_REST_Response
{
    return new WP_REST_Response([
        'contract' => 'zeroy/inventory@1',
        ...zeroy_runtime_inventory((int) $request->get_param('page'), (int) $request->get_param('perPage')),
    ]);
}

function zeroy_runtime_acf_endpoint(): WP_REST_Response
{
    return new WP_REST_Response(['contract' => 'zeroy/acf@1', ...zeroy_runtime_acf_projection()]);
}

function zeroy_runtime_adoption_candidates_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $post_type = $request->get_param('postType');
    $schema_id = $request->get_param('schemaId');
    $result = zeroy_runtime_adoption_candidates(
        is_string($post_type) && $post_type !== '' ? $post_type : null,
        is_string($schema_id) && $schema_id !== '' ? $schema_id : null,
        (int) $request->get_param('page'),
        (int) $request->get_param('perPage')
    );
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/adoption-candidates@1', ...$result]);
}

function zeroy_runtime_existing_post_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_existing_unmanaged_post((int) $request->get_param('postId'));
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/existing-post@1', 'existingPost' => $result]);
}

function zeroy_runtime_theme_root(): string|WP_Error
{
    $root = realpath(get_stylesheet_directory());
    return $root === false
        ? zeroy_runtime_error('zeroy_theme_missing', 'The active theme directory is unavailable.', 409)
        : $root;
}

function zeroy_runtime_theme_path(string $relative, bool $allow_missing = false): array|WP_Error
{
    $relative = ltrim(wp_normalize_path($relative), '/');
    $segments = explode('/', $relative);
    if ($relative === '' || in_array('..', $segments, true) || in_array('.', $segments, true) || str_contains($relative, "\0")) {
        return zeroy_runtime_error('zeroy_theme_path_invalid', 'Theme path escapes the active theme root.', 400);
    }
    $root = zeroy_runtime_theme_root();
    if (is_wp_error($root)) {
        return $root;
    }
    $candidate = $root . '/' . $relative;
    $parent = realpath(dirname($candidate));
    if ($parent === false || ($parent !== $root && !str_starts_with($parent, $root . DIRECTORY_SEPARATOR))) {
        return zeroy_runtime_error('zeroy_theme_path_invalid', 'Theme path has no existing directory inside the active theme root.', 400);
    }
    if (file_exists($candidate) || is_link($candidate)) {
        if (is_link($candidate) || !is_file($candidate)) {
            return zeroy_runtime_error('zeroy_theme_file_invalid', 'Only ordinary active-theme files may be read or written.', 400);
        }
        $resolved = realpath($candidate);
        if ($resolved === false || !str_starts_with($resolved, $root . DIRECTORY_SEPARATOR)) {
            return zeroy_runtime_error('zeroy_theme_path_invalid', 'Theme file resolves outside the active theme root.', 400);
        }
        return ['root' => $root, 'relative' => $relative, 'path' => $resolved, 'exists' => true];
    }
    if (!$allow_missing) {
        return zeroy_runtime_error('zeroy_theme_file_missing', 'The requested active-theme file does not exist.', 404);
    }
    return ['root' => $root, 'relative' => $relative, 'path' => $candidate, 'exists' => false];
}

function zeroy_runtime_theme_tree(): array|WP_Error
{
    $root = zeroy_runtime_theme_root();
    if (is_wp_error($root)) {
        return $root;
    }
    $files = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($iterator as $entry) {
        if (!$entry instanceof SplFileInfo || $entry->isLink() || !$entry->isFile()) {
            continue;
        }
        $path = $entry->getRealPath();
        if ($path === false || !str_starts_with($path, $root . DIRECTORY_SEPARATOR)) {
            continue;
        }
        $relative = ltrim(str_replace($root, '', str_replace('\\', '/', $path)), '/');
        $files[] = [
            'path' => $relative,
            'size' => $entry->getSize(),
            'hash' => hash_file('sha256', $path),
        ];
    }
    usort($files, static fn(array $left, array $right): int => $left['path'] <=> $right['path']);
    return $files;
}

function zeroy_runtime_theme_files_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $path = $request->get_param('path');
    if (!is_string($path) || $path === '') {
        $files = zeroy_runtime_theme_tree();
        return is_wp_error($files)
            ? zeroy_runtime_response_error($files)
            : new WP_REST_Response(['contract' => 'zeroy/theme-files@1', 'files' => $files]);
    }
    $file = zeroy_runtime_theme_path($path);
    if (is_wp_error($file)) {
        return zeroy_runtime_response_error($file);
    }
    $content = file_get_contents($file['path']);
    if (!is_string($content)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_theme_file_read_failed', 'Could not read active-theme file.', 500));
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/theme-file@1',
        'path' => $file['relative'],
        'content' => $content,
        'hash' => hash('sha256', $content),
        'exists' => true,
    ]);
}

function zeroy_runtime_atomic_theme_write(array $file, string $content): true|WP_Error
{
    $temporary = tempnam(dirname($file['path']), '.zeroy-');
    if ($temporary === false) {
        return zeroy_runtime_error('zeroy_theme_write_failed', 'Could not create a temporary active-theme file.', 500);
    }
    $permissions = $file['exists'] ? fileperms($file['path']) : false;
    $written = file_put_contents($temporary, $content, LOCK_EX);
    if ($written === false || !rename($temporary, $file['path'])) {
        if (is_file($temporary)) {
            unlink($temporary);
        }
        return zeroy_runtime_error('zeroy_theme_write_failed', 'Could not atomically replace the active-theme file.', 500);
    }
    if (is_int($permissions)) {
        chmod($file['path'], $permissions & 0777);
    }
    return true;
}

function zeroy_runtime_theme_files_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $writes = $payload['files'] ?? null;
    if (!is_array($writes) || !array_is_list($writes) || count($writes) === 0 || count($writes) > 100) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_theme_write_invalid', 'files must be a non-empty list of at most 100 writes.', 400));
    }
    $seen = [];
    $results = [];
    foreach ($writes as $index => $write) {
        $path = is_array($write) ? (string) ($write['path'] ?? '') : '';
        if ($path === '' || isset($seen[$path])) {
            $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => 'Each write needs one unique path.'];
            continue;
        }
        $seen[$path] = true;
        $content = $write['content'] ?? null;
        $expected_hash = $write['expectedHash'] ?? null;
        if (!is_string($content) || !($expected_hash === null || is_string($expected_hash))) {
            $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => 'Every write needs string content and string-or-null expectedHash.'];
            continue;
        }
        $file = zeroy_runtime_theme_path($path, true);
        if (is_wp_error($file)) {
            $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => $file->get_error_message(), 'code' => $file->get_error_code()];
            continue;
        }
        if ($file['exists']) {
            $current_hash = hash_file('sha256', $file['path']);
            if (!is_string($expected_hash) || !is_string($current_hash) || !hash_equals($current_hash, $expected_hash)) {
                $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => 'Theme file changed after it was read.', 'code' => 'zeroy_theme_hash_conflict', 'currentHash' => $current_hash];
                continue;
            }
        } elseif ($expected_hash !== null) {
            $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => 'New files require expectedHash: null.', 'code' => 'zeroy_theme_create_conflict'];
            continue;
        }
        $written = zeroy_runtime_atomic_theme_write($file, $content);
        if (is_wp_error($written)) {
            $results[] = ['index' => $index, 'path' => $path, 'ok' => false, 'error' => $written->get_error_message(), 'code' => $written->get_error_code()];
            continue;
        }
        $results[] = ['index' => $index, 'path' => $path, 'ok' => true, 'hash' => hash('sha256', $content), 'created' => !$file['exists']];
    }
    $ok = !in_array(false, array_column($results, 'ok'), true);
    return new WP_REST_Response(['contract' => 'zeroy/theme-write@1', 'ok' => $ok, 'results' => $results]);
}

function zeroy_runtime_canonical_projection(array $canonical): array
{
    return [
        'objectId' => $canonical['objectId'],
        'postType' => $canonical['post']->post_type,
        'postStatus' => $canonical['post']->post_status,
        'postTitle' => $canonical['post']->post_title,
        'schemaId' => $canonical['schemaId'],
        'revision' => $canonical['revision'],
    ];
}

function zeroy_runtime_site_config_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $config = $payload['siteConfig'] ?? null;
    $result = is_array($config)
        ? zeroy_runtime_update_site_config($config, (int) ($payload['expectedRevision'] ?? -1))
        : zeroy_runtime_error('zeroy_invalid_site_config', 'siteConfig must be an object.', 400);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => 'zeroy/site-config@1', 'siteConfig' => $result]);
}

function zeroy_runtime_canonical_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $action = (string) ($payload['action'] ?? '');
    if ($action === 'create') {
        $result = zeroy_runtime_create_canonical(
            (string) ($payload['postType'] ?? ''),
            (string) ($payload['schemaId'] ?? ''),
            (string) ($payload['postTitle'] ?? '')
        );
    } elseif ($action === 'adopt') {
        $result = zeroy_runtime_adopt_canonical(
            (int) ($payload['postId'] ?? 0),
            (string) ($payload['schemaId'] ?? ''),
            (string) ($payload['expectedSourceHash'] ?? '')
        );
    } elseif ($action === 'assignSchema') {
        $result = zeroy_runtime_assign_canonical_schema(
            (int) ($payload['objectId'] ?? 0),
            (string) ($payload['schemaId'] ?? ''),
            (int) ($payload['expectedRevision'] ?? -1)
        );
    } else {
        $result = zeroy_runtime_error('zeroy_canonical_action_invalid', 'Canonical action must be create, adopt, or assignSchema.', 400);
    }
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/canonical@1', 'canonical' => zeroy_runtime_canonical_projection($result)]);
}

function zeroy_runtime_locale_read_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $object_id = (int) $request->get_param('objectId');
    $locale = (string) $request->get_param('locale');
    $head = zeroy_runtime_get_head($object_id, $locale);
    if ($head === null) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_locale_missing', 'LocaleHead does not exist.', 404));
    }
    return new WP_REST_Response(['contract' => 'zeroy/locale-content@1', 'localeContent' => zeroy_runtime_project_head($head, true)]);
}

function zeroy_runtime_locale_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $action = (string) ($payload['action'] ?? '');
    if ($action === 'writeDraft') {
        $document = $payload['document'] ?? null;
        $result = is_array($document)
            ? zeroy_runtime_write_draft(
                (int) ($payload['objectId'] ?? 0),
                (string) ($payload['locale'] ?? ''),
                (string) ($payload['schemaId'] ?? ''),
                (string) ($payload['route'] ?? ''),
                $document,
                (int) ($payload['expectedRevision'] ?? -1)
            )
            : zeroy_runtime_error('zeroy_document_invalid', 'document must be an object.', 400);
    } elseif ($action === 'publish') {
        $result = zeroy_runtime_publish_draft(
            (int) ($payload['objectId'] ?? 0),
            (string) ($payload['locale'] ?? ''),
            (int) ($payload['expectedRevision'] ?? -1)
        );
    } elseif ($action === 'unpublish') {
        $result = zeroy_runtime_unpublish(
            (int) ($payload['objectId'] ?? 0),
            (string) ($payload['locale'] ?? ''),
            (int) ($payload['expectedRevision'] ?? -1)
        );
    } else {
        $result = zeroy_runtime_error('zeroy_locale_action_invalid', 'Locale action must be writeDraft, publish, or unpublish.', 400);
    }
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/locale-mutation-receipt@1', 'receipt' => $result]);
}

function zeroy_runtime_theme_copy_read_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $locale = (string) $request->get_param('locale');
    $definition = zeroy_runtime_theme_copy_definition();
    if (is_wp_error($definition)) {
        return zeroy_runtime_response_error($definition);
    }
    $head = zeroy_runtime_get_head(ZEROY_RUNTIME_THEME_COPY_OBJECT_ID, $locale);
    if ($head === null) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_theme_copy_missing', "ThemeCopy LocaleHead {$locale} does not exist.", 404));
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/theme-copy@1',
        'themeCopy' => zeroy_runtime_project_head($head, true),
    ]);
}

function zeroy_runtime_theme_copy_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $action = (string) ($payload['action'] ?? '');
    if ($action === 'writeThemeCopyDraft') {
        $document = $payload['document'] ?? null;
        $result = is_array($document)
            ? zeroy_runtime_write_theme_copy_draft(
                (string) ($payload['locale'] ?? ''),
                $document,
                (int) ($payload['expectedRevision'] ?? -1)
            )
            : zeroy_runtime_error('zeroy_document_invalid', 'document must be an object.', 400);
    } elseif ($action === 'publishThemeCopy') {
        $result = zeroy_runtime_publish_theme_copy_draft(
            (string) ($payload['locale'] ?? ''),
            (int) ($payload['expectedRevision'] ?? -1)
        );
    } elseif ($action === 'unpublishThemeCopy') {
        $result = zeroy_runtime_unpublish_theme_copy(
            (string) ($payload['locale'] ?? ''),
            (int) ($payload['expectedRevision'] ?? -1)
        );
    } else {
        $result = zeroy_runtime_error('zeroy_theme_copy_action_invalid', 'ThemeCopy action must be writeThemeCopyDraft, publishThemeCopy, or unpublishThemeCopy.', 400);
    }
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/theme-copy-mutation-receipt@1', 'receipt' => $result]);
}

function zeroy_runtime_integrity_endpoint(): WP_REST_Response
{
    return new WP_REST_Response(['contract' => 'zeroy/integrity@1', ...zeroy_runtime_integrity()]);
}

function zeroy_runtime_register_rest_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_endpoint']);
    register_rest_route('zeroy/v1', '/schema', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_schema_endpoint']);
    register_rest_route('zeroy/v1', '/inventory', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_inventory_endpoint']);
    register_rest_route('zeroy/v1', '/acf', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_acf_endpoint']);
    register_rest_route('zeroy/v1', '/adoption-candidates', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_adoption_candidates_endpoint']);
    register_rest_route('zeroy/v1', '/existing-post', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_existing_post_endpoint']);
    register_rest_route('zeroy/v1', '/theme-files', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_files_endpoint']);
    register_rest_route('zeroy/v1', '/theme-files', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_files_write_endpoint']);
    register_rest_route('zeroy/v1', '/site-config', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_config_write_endpoint']);
    register_rest_route('zeroy/v1', '/canonical', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_canonical_write_endpoint']);
    register_rest_route('zeroy/v1', '/locale-content', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_locale_read_endpoint']);
    register_rest_route('zeroy/v1', '/locale-content', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_locale_write_endpoint']);
    register_rest_route('zeroy/v1', '/theme-copy', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_copy_read_endpoint']);
    register_rest_route('zeroy/v1', '/theme-copy', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_copy_write_endpoint']);
    register_rest_route('zeroy/v1', '/integrity', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_integrity_endpoint']);
}
add_action('rest_api_init', 'zeroy_runtime_register_rest_routes');
