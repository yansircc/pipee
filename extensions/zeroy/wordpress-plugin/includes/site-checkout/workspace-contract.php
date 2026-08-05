<?php

defined('ABSPATH') || exit;

const ZEROY_WORKSPACE_DIAGNOSTICS_MAX_BYTES = 64 * 1024;

function zeroy_workspace_chunks_by_bytes(array $items, int $max_bytes): array
{
    $chunks = [];
    $current = [];
    foreach (array_values($items) as $item) {
        $candidate = [...$current, $item];
        if ($current !== [] && strlen(zeroy_checkout_canonical_json($candidate)) > $max_bytes) {
            $chunks[] = $current;
            $current = [$item];
        } else $current = $candidate;
    }
    if ($current !== []) $chunks[] = $current;
    return $chunks === [] ? [[]] : $chunks;
}

function zeroy_workspace_scalar_schema(array $field): array
{
    $type = (string) ($field['type'] ?? '');
    $description = sprintf(
        'ACF field key %s; label %s; name %s; type %s; required %s.',
        (string) ($field['key'] ?? ''),
        (string) ($field['label'] ?? ''),
        (string) ($field['name'] ?? ''),
        $type,
        !empty($field['required']) ? 'yes' : 'no',
    );
    $stable_ref = static fn(string $kind, array $extra = []): array => [
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['kind', 'ref'],
        'properties' => [
            'kind' => ['const' => $kind],
            'ref' => ['type' => 'string', 'pattern' => '^[a-z0-9](?:[a-z0-9._/-]{0,190}[a-z0-9])?$'],
            ...$extra,
        ],
    ];
    $post_ref = $stable_ref('post');
    $media_ref = $stable_ref('media');
    $term_ref = $stable_ref('term', ['taxonomy' => ['type' => 'string', 'minLength' => 1]]);
    $schema = match ($type) {
        'number', 'range' => ['type' => 'number'],
        'true_false' => ['type' => 'boolean'],
        'checkbox' => ['type' => 'array', 'items' => ['type' => 'string']],
        'gallery' => ['type' => 'array', 'items' => $media_ref],
        'relationship' => ['type' => 'array', 'items' => $post_ref],
        'image', 'file' => ['oneOf' => [$media_ref, ['type' => 'null']]],
        'post_object' => !empty($field['multiple']) ? ['type' => 'array', 'items' => $post_ref] : ['oneOf' => [$post_ref, ['type' => 'null']]],
        'taxonomy' => !empty($field['multiple']) || !empty($field['add_term']) ? ['type' => 'array', 'items' => $term_ref] : ['oneOf' => [$term_ref, ['type' => 'null']]],
        'link', 'google_map' => ['type' => 'object'],
        default => ['type' => 'string'],
    };
    $schema['description'] = $description;
    if (is_array($field['choices'] ?? null) && $field['choices'] !== []) {
        $choices = array_map('strval', array_keys($field['choices']));
        if ($type === 'checkbox') $schema['items']['enum'] = $choices;
        else $schema['enum'] = $choices;
        $schema['description'] .= ' Choices: ' . implode(', ', array_map(static fn(mixed $value, mixed $label): string => (string) $value . '=' . (string) $label, array_keys($field['choices']), $field['choices'])) . '.';
    }
    return $schema;
}

function zeroy_workspace_acf_field_schema(array $field, array $policy, string $field_id, bool $locale): ?array
{
    $type = (string) ($field['type'] ?? '');
    if ($type === 'group') {
        $properties = [];
        $required = [];
        foreach (is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [] as $child) {
            $key = (string) ($child['key'] ?? '');
            if ($key === '') continue;
            $schema = zeroy_workspace_acf_field_schema($child, $policy, $field_id . '/' . zeroy_localization_pointer_segment($key), $locale);
            if ($schema === null) continue;
            $properties[$key] = $schema;
            if (!$locale && !empty($child['required'])) $required[] = $key;
        }
        if ($locale && $properties === []) return null;
        return ['type' => 'object', 'additionalProperties' => false, 'properties' => $properties, ...($required === [] ? [] : ['required' => $required])];
    }
    if (in_array($type, ['repeater', 'flexible_content'], true) && isset($policy['repeaterItemKeys'][$field_id])) {
        $row_schemas = [];
        $layouts = $type === 'flexible_content' && is_array($field['layouts'] ?? null) ? $field['layouts'] : [['sub_fields' => $field['sub_fields'] ?? []]];
        foreach ($layouts as $layout) {
            $properties = [];
            $required = [];
            if ($type === 'flexible_content') {
                $layout_name = (string) ($layout['name'] ?? '');
                if ($layout_name === '') continue;
                $properties['acf_fc_layout'] = ['const' => $layout_name];
                $required[] = 'acf_fc_layout';
            }
            foreach (is_array($layout['sub_fields'] ?? null) ? $layout['sub_fields'] : [] as $child) {
                $key = (string) ($child['key'] ?? '');
                if ($key === '') continue;
                $schema = zeroy_workspace_acf_field_schema($child, $policy, $field_id . '/*/' . zeroy_localization_pointer_segment($key), $locale);
                if ($schema === null) continue;
                $properties[$key] = $schema;
                if (!$locale && !empty($child['required'])) $required[] = $key;
            }
            if (!$locale || count($properties) > ($type === 'flexible_content' ? 1 : 0)) $row_schemas[] = ['type' => 'object', 'additionalProperties' => false, 'properties' => $properties, ...($required === [] ? [] : ['required' => $required])];
        }
        if ($row_schemas === []) return null;
        return [
            'type' => 'object',
            'description' => 'Object keyed by the stable repeater item value from ACF field ' . $policy['repeaterItemKeys'][$field_id] . '.',
            'additionalProperties' => count($row_schemas) === 1 ? $row_schemas[0] : ['oneOf' => $row_schemas],
        ];
    }
    if (in_array($type, ['repeater', 'flexible_content'], true)) {
        return ['not' => new stdClass(), 'description' => "ACF {$type} requires a valid repeaterItemKeys entry in ThemeSchema before this document can be authored."];
    }
    if ($locale) {
        $rule = zeroy_localization_rule_for_field($policy, $field_id);
        if (is_wp_error($rule) || !in_array($rule['mode'] ?? null, ['translated', 'overridable'], true)) return null;
        $schema = zeroy_workspace_scalar_schema($field);
        $schema['description'] .= ' Locale mode: ' . $rule['mode'] . '; required: ' . (!empty($rule['required']) ? 'yes' : 'no') . '.';
        return $schema;
    }
    return zeroy_workspace_scalar_schema($field);
}

function zeroy_workspace_acf_schema(string $post_type, array $definition, bool $locale): array
{
    $compiled = zeroy_localization_compiled_policy($definition);
    $policy = is_wp_error($compiled) ? ['rules' => [], 'repeaterItemKeys' => []] : $compiled;
    $properties = [];
    $required = [];
    foreach (zeroy_document_acf_fields($post_type) as $key => $field) {
        $schema = zeroy_workspace_acf_field_schema($field, $policy, '/acf/' . zeroy_localization_pointer_segment($key), $locale);
        if ($schema === null) continue;
        $properties[$key] = $schema;
        if (!$locale && !empty($field['required'])) $required[] = $key;
    }
    return ['type' => 'object', 'additionalProperties' => false, 'properties' => $properties, ...($required === [] ? [] : ['required' => $required])];
}

function zeroy_workspace_post_schema(array $collection, array $definition, bool $locale): array
{
    $policy = zeroy_localization_compiled_policy($definition);
    $post_properties = [];
    foreach (['title', 'content', 'excerpt'] as $field) {
        if (!$locale) $post_properties[$field] = ['type' => 'string'];
        elseif (!is_wp_error($policy)) {
            $rule = zeroy_localization_rule_for_field($policy, '/post/' . $field);
            if (!is_wp_error($rule) && in_array($rule['mode'] ?? null, ['translated', 'overridable'], true)) $post_properties[$field] = ['type' => 'string', 'description' => 'Locale mode: ' . $rule['mode'] . '; required: ' . (!empty($rule['required']) ? 'yes' : 'no') . '.'];
        }
    }
    $template_properties = [];
    foreach ($definition['templateContent'] ?? [] as $key => $declaration) {
        $field_policy = is_array($declaration['localization'] ?? null) ? $declaration['localization'] : null;
        if (!$locale || in_array($field_policy['mode'] ?? null, ['translated', 'overridable'], true)) $template_properties[$key] = ['type' => 'string', 'description' => 'Template content ' . $key . ($locale ? '; locale mode ' . ($field_policy['mode'] ?? 'unknown') : '') . '.'];
    }
    $properties = [
        ...(!$locale ? ['route' => ['type' => 'string', 'pattern' => '^/']] : []),
        'post' => ['type' => 'object', 'additionalProperties' => false, 'properties' => $post_properties],
        'acf' => zeroy_workspace_acf_schema($collection['postType'], $definition, $locale),
        'templateContent' => ['type' => 'object', 'additionalProperties' => false, 'properties' => $template_properties],
        ...(!$locale ? ['terms' => [
            'type' => 'object',
            'additionalProperties' => [
                'type' => 'array',
                'items' => [
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => ['kind', 'ref'],
                    'properties' => [
                        'kind' => ['const' => 'term'],
                        'ref' => ['type' => 'string', 'pattern' => '^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$'],
                    ],
                ],
            ],
        ]] : []),
    ];
    if ($locale) $properties['review'] = zeroy_workspace_review_schema($properties);
    return ['$schema' => 'https://json-schema.org/draft/2020-12/schema', 'type' => 'object', 'additionalProperties' => false, 'properties' => $properties, ...(!$locale ? ['required' => ['route', 'post', 'acf', 'templateContent', 'terms']] : [])];
}

function zeroy_workspace_review_schema(array $writable): array
{
    $leaf = [
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['decision', 'reviewedAt', 'note'],
        'properties' => [
            'decision' => ['const' => 'confirmed-current'],
            'reviewedAt' => ['type' => 'string', 'format' => 'date-time'],
            'note' => ['type' => 'string', 'minLength' => 1],
        ],
    ];
    $project = static function (array $schema) use (&$project, $leaf): array {
        if (($schema['type'] ?? null) !== 'object') return $leaf;
        $properties = [];
        foreach (is_array($schema['properties'] ?? null) ? $schema['properties'] : [] as $key => $child) {
            if ($key === 'review' || !is_array($child)) continue;
            $properties[$key] = $project($child);
        }
        $result = ['type' => 'object', 'additionalProperties' => false, 'properties' => $properties];
        if (is_array($schema['additionalProperties'] ?? null)) $result['additionalProperties'] = $project($schema['additionalProperties']);
        return $result;
    };
    $schema = $project(['type' => 'object', 'properties' => $writable]);
    $schema['description'] = 'Optional stale-source acknowledgement only. Omit review for a new locale document or any leaf that is not listed stale in the current repair frontier; use it only to confirm a changed stale leaf.';
    return $schema;
}

function zeroy_workspace_site_schema(): array
{
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['workspaceFormat', 'defaultLocale', 'locales', 'collections'],
        'properties' => [
            'workspaceFormat' => ['const' => ZEROY_SITE_TREE_CONTRACT],
            'defaultLocale' => ['type' => 'string', 'pattern' => '^[a-z]{2,3}(?:-[A-Z]{2})?$'],
            'locales' => ['type' => 'array', 'minItems' => 1, 'uniqueItems' => true, 'items' => ['type' => 'string', 'pattern' => '^[a-z]{2,3}(?:-[A-Z]{2})?$']],
            'collections' => [
                'type' => 'object',
                'additionalProperties' => [
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => ['subjectKind', 'postType', 'schemaId'],
                    'properties' => [
                        'subjectKind' => ['const' => 'post'],
                        'postType' => ['type' => 'string', 'minLength' => 1],
                        'schemaId' => ['type' => 'string', 'minLength' => 1],
                    ],
                ],
            ],
        ],
    ];
}

function zeroy_workspace_term_schema(bool $locale): array
{
    $properties = $locale
        ? ['name' => ['type' => 'string'], 'description' => ['type' => 'string']]
        : ['slug' => ['type' => 'string', 'minLength' => 1], 'name' => ['type' => 'string'], 'description' => ['type' => 'string']];
    if ($locale) $properties['review'] = zeroy_workspace_review_schema($properties);
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'properties' => zeroy_runtime_json_map($properties),
        ...(!$locale ? ['required' => ['slug', 'name', 'description']] : []),
    ];
}

function zeroy_workspace_site_copy_schema(array $keys, bool $locale): array
{
    $properties = [];
    foreach ($keys as $key) $properties[$key] = ['type' => 'string'];
    if ($locale) $properties['review'] = zeroy_workspace_review_schema($properties);
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => $locale ? false : ['type' => 'string'],
        'properties' => zeroy_runtime_json_map($properties),
    ];
}

function zeroy_workspace_theme_manifest_schema(): array
{
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['contract', 'requiresCapabilities', 'zcss'],
        'properties' => [
            'contract' => ['const' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT],
            'requiresCapabilities' => ['type' => 'object', 'additionalProperties' => ['type' => 'string', 'pattern' => '^\\^?[0-9]+$']],
            'zcss' => [
                'type' => 'object',
                'additionalProperties' => false,
                'required' => ['contract', 'design', 'styles'],
                'properties' => [
                    'contract' => ['const' => ZEROY_ZCSS_DESIGN_CONTRACT],
                    'design' => ['const' => 'zcss.design.json'],
                    'styles' => ['type' => 'array', 'minItems' => 1, 'uniqueItems' => true, 'items' => ['type' => 'string']],
                ],
            ],
        ],
    ];
}

function zeroy_workspace_site_logic_schema(): array
{
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['contract', 'provides', 'requires', 'storageEpoch', 'migrations'],
        'properties' => [
            'contract' => ['const' => ZEROY_SITE_LOGIC_CONTRACT],
            'provides' => ['type' => 'array'],
            'requires' => ['type' => 'array'],
            'storageEpoch' => ['type' => 'integer', 'minimum' => 0],
            'migrations' => ['type' => 'array'],
        ],
    ];
}

function zeroy_workspace_theme_shell_template(string $main, bool $not_found = false): string
{
    $status = $not_found ? " status_header(404);" : '';
    return "<?php defined('ABSPATH') || exit;{$status} ?>\n"
        . "<!doctype html>\n"
        . "<html <?php language_attributes(); ?>>\n"
        . "<head>\n"
        . "  <meta charset=\"<?php bloginfo('charset'); ?>\">\n"
        . "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        . "  <?php wp_head(); ?>\n"
        . "</head>\n"
        . "<body <?php body_class(); ?>>\n"
        . "<?php wp_body_open(); ?>\n"
        . $main . "\n"
        . "<?php wp_footer(); ?>\n"
        . "</body>\n"
        . "</html>\n";
}

/**
 * PHP arrays cannot retain the JSON identity of an empty object.  Workspace
 * contracts are JSON Schema documents, so object-valued schema keywords must
 * be projected as JSON objects at every depth, not repaired one constructor at
 * a time.  This is the single wire boundary for that algebra.
 */
function zeroy_workspace_json_schema_wire(mixed $schema): mixed
{
    if ($schema instanceof stdClass || !is_array($schema)) return $schema;

    $result = $schema;
    foreach (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as $keyword) {
        if (!array_key_exists($keyword, $result) || !is_array($result[$keyword])) continue;
        $entries = [];
        foreach ($result[$keyword] as $name => $child) $entries[$name] = zeroy_workspace_json_schema_wire($child);
        $result[$keyword] = zeroy_runtime_json_map($entries);
    }
    foreach (['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'items', 'not', 'if', 'then', 'else'] as $keyword) {
        if (isset($result[$keyword]) && is_array($result[$keyword])) $result[$keyword] = zeroy_workspace_json_schema_wire($result[$keyword]);
    }
    foreach (['allOf', 'anyOf', 'oneOf', 'prefixItems'] as $keyword) {
        if (!isset($result[$keyword]) || !is_array($result[$keyword])) continue;
        $result[$keyword] = array_map('zeroy_workspace_json_schema_wire', $result[$keyword]);
    }
    return $result === [] ? new stdClass() : $result;
}

function zeroy_workspace_contract_projection(array $files, ?array $compiled, array $failures, string $build_id, string $state, array $authored_seeds = []): array
{
    $decode_failures = [];
    $site = zeroy_document_decode_site($files, $decode_failures);
    $site ??= ['workspaceFormat' => ZEROY_SITE_TREE_CONTRACT, 'defaultLocale' => '', 'locales' => [], 'collections' => []];
    $site_copy_body = is_array($files['content/site-copy.json'] ?? null) ? json_decode((string) ($files['content/site-copy.json']['bytes'] ?? ''), true) : [];
    $site_copy_keys = zeroy_runtime_is_keyed_map($site_copy_body) ? array_keys($site_copy_body) : [];
    sort($site_copy_keys, SORT_STRING);
    $render_variants = [];
    if (is_array($compiled['schema']['schemas'] ?? null)) foreach ($site['collections'] as $collection) {
        $definition = $compiled['schema']['schemas'][$collection['schemaId']] ?? null;
        if (is_array($definition)) $render_variants[] = zeroy_runtime_theme_resolved_content_schema((string) $collection['postType'], $definition);
    }
    $contracts = [
        '.zeroy/contracts/site.schema.json' => zeroy_workspace_site_schema(),
        '.zeroy/contracts/theme-schema.schema.json' => zeroy_workspace_theme_schema_contract(),
        '.zeroy/contracts/theme-manifest.schema.json' => zeroy_workspace_theme_manifest_schema(),
        '.zeroy/contracts/theme-context.schema.json' => zeroy_runtime_theme_render_context_schema($render_variants),
        '.zeroy/contracts/zcss-design.schema.json' => zeroy_zcss_design_json_schema(),
        '.zeroy/contracts/zcss-authoring.json' => zeroy_zcss_authoring_contract(),
        '.zeroy/contracts/site-logic.schema.json' => zeroy_workspace_site_logic_schema(),
        '.zeroy/contracts/content/site-copy.schema.json' => zeroy_workspace_site_copy_schema($site_copy_keys, false),
    ];
    $templates = [
        '.zeroy/templates/site.json' => ['workspaceFormat' => ZEROY_SITE_TREE_CONTRACT, 'defaultLocale' => 'en', 'locales' => ['en'], 'collections' => new stdClass()],
        '.zeroy/templates/theme-schema.json' => zeroy_workspace_theme_schema_template(),
        '.zeroy/templates/content/site-copy.json' => $site_copy_keys === [] ? new stdClass() : array_fill_keys($site_copy_keys, ''),
        '.zeroy/templates/artifacts/theme/zeroy.theme.json' => ['contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT, 'requiresCapabilities' => new stdClass(), 'zcss' => ['contract' => ZEROY_ZCSS_DESIGN_CONTRACT, 'design' => 'zcss.design.json', 'styles' => ['assets/css/site.css']]],
        '.zeroy/templates/artifacts/theme/zcss.design.json' => zeroy_zcss_minimal_design_document(),
        '.zeroy/templates/artifacts/theme/zeroy.schema.json' => zeroy_workspace_theme_schema_template(),
        '.zeroy/templates/artifacts/site-logic/sitelogic.json' => ['contract' => ZEROY_SITE_LOGIC_CONTRACT, 'provides' => [], 'requires' => [], 'storageEpoch' => 0, 'migrations' => []],
        '.zeroy/templates/artifacts/site-logic/bootstrap.php' => "<?php\n\ndefined('ABSPATH') || exit;\n",
        '.zeroy/templates/artifacts/theme/functions.php' => "<?php\n\n// Theme bootstrap. Render through zeroY runtime context only.\n",
        '.zeroy/templates/artifacts/theme/index.php' => zeroy_workspace_theme_shell_template("<main><?php echo esc_html(get_bloginfo('name')); ?></main>"),
        '.zeroy/templates/artifacts/theme/404.php' => zeroy_workspace_theme_shell_template('<main><h1>Not found</h1></main>', true),
        '.zeroy/templates/artifacts/theme/search.php' => zeroy_workspace_theme_shell_template('<main><h1>Search</h1></main>'),
        '.zeroy/templates/artifacts/theme/assets/css/site.css' => "body { margin: 0; }\n",
    ];
    $taxonomies = [];
    $document_paths = array_keys($files);
    foreach ($failures as $failure) {
        if (is_string($failure['documentPath'] ?? null)) $document_paths[] = $failure['documentPath'];
    }
    foreach (array_unique($document_paths) as $path) {
        $identity = zeroy_document_path($path, $site);
        if (($identity['kind'] ?? null) === 'term' && is_string($identity['taxonomy'] ?? null)) $taxonomies[$identity['taxonomy']] = true;
    }
    foreach (array_keys($taxonomies) as $taxonomy) {
        $contracts[".zeroy/contracts/content/terms/{$taxonomy}.schema.json"] = zeroy_workspace_term_schema(false);
        $templates[".zeroy/templates/content/terms/{$taxonomy}/new.json"] = ['slug' => '', 'name' => '', 'description' => ''];
        foreach ($site['locales'] as $locale) if ($locale !== $site['defaultLocale']) {
            $contracts[".zeroy/contracts/locales/{$locale}/terms/{$taxonomy}.schema.json"] = zeroy_workspace_term_schema(true);
            $templates[".zeroy/templates/locales/{$locale}/terms/{$taxonomy}/new.json"] = new stdClass();
        }
    }
    if (is_array($compiled)) foreach ($site['collections'] as $collection_id => $collection) {
        $definition = $compiled['schema']['schemas'][$collection['schemaId']] ?? null;
        if (!is_array($definition)) continue;
        $contracts[".zeroy/contracts/content/posts/{$collection_id}.schema.json"] = zeroy_workspace_post_schema($collection, $definition, false);
        $templates[".zeroy/templates/content/posts/{$collection_id}/new.json"] = ['route' => '/', 'post' => ['title' => '', 'content' => '', 'excerpt' => ''], 'acf' => new stdClass(), 'templateContent' => new stdClass(), 'terms' => new stdClass()];
        foreach ($site['locales'] as $locale) if ($locale !== $site['defaultLocale']) {
            $contracts[".zeroy/contracts/locales/{$locale}/posts/{$collection_id}.schema.json"] = zeroy_workspace_post_schema($collection, $definition, true);
            $templates[".zeroy/templates/locales/{$locale}/posts/{$collection_id}/new.json"] = new stdClass();
        }
    }
    foreach ($site['locales'] as $locale) if ($locale !== $site['defaultLocale']) {
        $contracts[".zeroy/contracts/locales/{$locale}/site-copy.schema.json"] = zeroy_workspace_site_copy_schema($site_copy_keys, true);
        $templates[".zeroy/templates/locales/{$locale}/site-copy.json"] = new stdClass();
    }
    $map_files = $files;
    foreach ($authored_seeds as $path => $seed) {
        if (!is_string($path) || !zeroy_checkout_path_is_safe($path) || !is_array($seed)) continue;
        $map_files[$path] = ['bytes' => (string) ($seed['content'] ?? '')];
    }
    $projection = [];
    $map = zeroy_workspace_construction_map($map_files, $site, $compiled, $failures, $build_id, $state);
    $projection['.zeroy/README.md'] = "# zeroY workspace\n\nRead brief.json, construction-map.json, and review.json before editing. construction-map.json is the bounded generated index of routes, ACF fields, mock data, artifact paths, and current diagnostics for this exact checkout. Edit only authored roots site.json, artifacts/, content/, locales/, and media/. locales/ is a top-level sibling of content/; content/locales/ is invalid. A file under .zeroy/templates/<path> is copied to the authored <path> by removing only the .zeroy/templates/ prefix. Theme PHP reads only zeroy_theme_context(); its exact input shape is .zeroy/contracts/theme-context.schema.json. Theme CSS may use custom selectors, Grid, Flex, gradients, pseudo-elements, animations, and media/container queries. The compiler owns only the reserved .z-* and --z-* namespaces. Push after one coherent repair slice; publication belongs to an administrator.\n";
    $projection['.zeroy/construction-map.json'] = $map;
    $projection['.zeroy/construction-map.md'] = zeroy_workspace_construction_map_markdown($map);
    $projection['.zeroy/status.json'] = ['buildId' => $build_id, 'state' => $state];
    $projection['.zeroy/status.md'] = "# Build status\n\nBuild: {$build_id}\nState: {$state}\nFailures: " . count($failures) . "\n";
    $projection['.zeroy/diagnostics/summary.md'] = "# Diagnostics\n\n" . count($failures) . " blocking failure(s).\n";
    $diagnostics_by_path = [];
    foreach ($failures as $failure) {
        $path = (string) ($failure['documentPath'] ?? 'site.json');
        $diagnostics_by_path[$path][] = $failure;
    }
    foreach ($diagnostics_by_path as $path => $items) {
        $diagnostic = '.zeroy/diagnostics/' . substr(hash('sha256', $path), 0, 16) . '.json';
        $chunks = zeroy_workspace_chunks_by_bytes($items, ZEROY_WORKSPACE_DIAGNOSTICS_MAX_BYTES - 2048);
        if (count($chunks) === 1) $projection[$diagnostic] = ['documentPath' => $path, 'failureCount' => count($items), 'failures' => $chunks[0]];
        else {
            $shards = [];
            foreach ($chunks as $position => $chunk) {
                $shard = preg_replace('/\.json$/', '-' . ($position + 1) . '.json', $diagnostic);
                $projection[$shard] = ['documentPath' => $path, 'shard' => $position + 1, 'failures' => $chunk];
                $shards[] = $shard;
            }
            $projection[$diagnostic] = ['documentPath' => $path, 'failureCount' => count($items), 'shards' => $shards];
        }
    }
    foreach ($contracts as $path => $contract) $contracts[$path] = zeroy_workspace_json_schema_wire($contract);
    return $projection + $contracts + $templates;
}

function zeroy_workspace_projection_budget_failures(array $projection): array
{
    $failures = [];
    foreach ($projection as $path => $value) {
        $limit = str_starts_with($path, '.zeroy/diagnostics/') && str_ends_with($path, '.json')
            ? ZEROY_WORKSPACE_DIAGNOSTICS_MAX_BYTES
            : null;
        if ($limit === null) continue;
        $bytes = strlen(is_string($value) ? $value : zeroy_checkout_canonical_json($value));
        if ($bytes <= $limit) continue;
        $failures[] = zeroy_document_failure('workspace_projection_budget_exceeded', 'site.json', '', "Derived projection {$path} is {$bytes} bytes; maximum is {$limit}.", 'Reduce one diagnostic item below the bounded projection limit; collections are automatically sharded.', ['projectionPath' => $path]);
    }
    return $failures;
}

function zeroy_workspace_projection_file_bytes(array $projection): array
{
    $files = [];
    foreach ($projection as $path => $value) {
        $files[$path] = is_string($value) ? $value : zeroy_checkout_canonical_json($value) . "\n";
    }
    return $files;
}

function zeroy_workspace_theme_schema_contract(): array
{
    $policy = [
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['contract', 'rules', 'repeaterItemKeys'],
        'properties' => [
            'contract' => ['const' => zeroy_localization_policy_contract()],
            'rules' => [
                'type' => 'array',
                'minItems' => 1,
                'items' => [
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => ['fieldPattern', 'mode', 'required', 'contextWeight'],
                    'properties' => [
                        'fieldPattern' => ['type' => 'string'],
                        'mode' => ['enum' => zeroy_localization_field_policy_modes()],
                        'required' => ['type' => 'boolean'],
                        'contextWeight' => ['enum' => zeroy_localization_field_policy_context_weights()],
                    ],
                ],
            ],
            'repeaterItemKeys' => ['type' => 'object', 'additionalProperties' => ['type' => 'string']],
        ],
    ];
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'required' => ['contract', 'schemas', 'routes'],
        'properties' => [
            'contract' => ['const' => ZEROY_THEME_SCHEMA_CONTRACT],
            'schemas' => [
                'type' => 'object',
                'additionalProperties' => [
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => ['label', 'template', 'routeKind', 'canonicalPostTypes', 'localization'],
                    'properties' => [
                        'label' => ['type' => 'string'],
                        'template' => ['type' => 'string'],
                        'routeKind' => ['enum' => zeroy_runtime_theme_authoring_route_kinds()],
                        'canonicalPostTypes' => ['type' => 'array', 'minItems' => 1, 'items' => ['type' => 'string']],
                        'localization' => $policy,
                        'templateContent' => ['type' => 'object'],
                    ],
                ],
            ],
            'routes' => [
                'type' => 'object',
                'additionalProperties' => false,
                'required' => ['search', 'notFound'],
                'properties' => [
                    'search' => ['type' => 'object', 'required' => ['route', 'template']],
                    'notFound' => ['type' => 'object', 'required' => ['template']],
                ],
            ],
            'collections' => ['type' => 'object'],
            'localizationSubjects' => ['type' => 'object'],
        ],
    ];
}

function zeroy_workspace_theme_schema_template(): array
{
    return [
        'contract' => ZEROY_THEME_SCHEMA_CONTRACT,
        'routes' => ['search' => ['route' => 'search', 'template' => 'search.php'], 'notFound' => ['template' => '404.php']],
        'localizationSubjects' => [
            'siteCopy' => ['localization' => ['contract' => zeroy_localization_policy_contract(), 'rules' => [['fieldPattern' => '/site-copy/*', 'mode' => 'translated', 'required' => false, 'contextWeight' => 'supporting']], 'repeaterItemKeys' => new stdClass()]],
            'term' => ['localization' => ['contract' => zeroy_localization_policy_contract(), 'rules' => [['fieldPattern' => '/term/name', 'mode' => 'translated', 'required' => true, 'contextWeight' => 'primary'], ['fieldPattern' => '/term/description', 'mode' => 'overridable', 'required' => false, 'contextWeight' => 'supporting']], 'repeaterItemKeys' => new stdClass()]],
        ],
        'schemas' => new stdClass(),
        'collections' => new stdClass(),
    ];
}

function zeroy_workspace_contract_for_document(string $path, array $site): string
{
    if ($path === 'artifacts/theme/zeroy.schema.json') return '.zeroy/contracts/theme-schema.schema.json';
    if ($path === 'artifacts/theme/zeroy.theme.json') return '.zeroy/contracts/theme-manifest.schema.json';
    if ($path === 'artifacts/theme/zcss.design.json') return '.zeroy/contracts/zcss-design.schema.json';
    if (str_starts_with($path, 'artifacts/theme/assets/css/')) return '.zeroy/contracts/zcss-authoring.json';
    if ($path === 'artifacts/site-logic/sitelogic.json') return '.zeroy/contracts/site-logic.schema.json';
    if (str_starts_with($path, 'artifacts/theme/')) return '.zeroy/contracts/theme-manifest.schema.json';
    if (str_starts_with($path, 'artifacts/site-logic/')) return '.zeroy/contracts/site-logic.schema.json';
    $identity = zeroy_document_path($path, $site);
    if (($identity['kind'] ?? null) === 'post') return '.zeroy/contracts/' . (is_string($identity['locale'] ?? null) ? 'locales/' . $identity['locale'] . '/' : 'content/') . 'posts/' . $identity['collection'] . '.schema.json';
    if (($identity['kind'] ?? null) === 'term') return '.zeroy/contracts/' . (is_string($identity['locale'] ?? null) ? 'locales/' . $identity['locale'] . '/' : 'content/') . 'terms/' . $identity['taxonomy'] . '.schema.json';
    if (($identity['kind'] ?? null) === 'site-copy') return '.zeroy/contracts/' . (is_string($identity['locale'] ?? null) ? 'locales/' . $identity['locale'] . '/' : 'content/') . 'site-copy.schema.json';
    return '.zeroy/contracts/site.schema.json';
}

function zeroy_workspace_template_for_document(string $path, array $site): string
{
    if (str_starts_with($path, 'artifacts/theme/')) return '.zeroy/templates/' . $path;
    if (str_starts_with($path, 'artifacts/site-logic/')) return '.zeroy/templates/' . $path;
    $identity = zeroy_document_path($path, $site);
    if (($identity['kind'] ?? null) === 'post') return '.zeroy/templates/' . (is_string($identity['locale'] ?? null) ? 'locales/' . $identity['locale'] . '/' : 'content/') . 'posts/' . $identity['collection'] . '/new.json';
    if (($identity['kind'] ?? null) === 'term') return '.zeroy/templates/' . (is_string($identity['locale'] ?? null) ? 'locales/' . $identity['locale'] . '/' : 'content/') . 'terms/' . $identity['taxonomy'] . '/new.json';
    return str_replace('/contracts/', '/templates/', preg_replace('/\.schema\.json$/', '.json', zeroy_workspace_contract_for_document($path, $site)));
}
