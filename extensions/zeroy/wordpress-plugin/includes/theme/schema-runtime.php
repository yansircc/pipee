<?php

defined('ABSPATH') || exit;

function zeroy_runtime_normalize_schema_definition(string $schema_id, mixed $input, string $theme_root, array &$errors, bool $stored): ?array
{
    $context = ['schemaId' => $schema_id];
    if (!is_array($input) || array_is_list($input)) {
        zeroy_runtime_schema_violation($errors, 'schema_definition_invalid', "Schema {$schema_id} must be an object.", $context);
        return null;
    }
    $label = is_string($input['label'] ?? null) ? trim($input['label']) : '';
    $template = is_string($input['template'] ?? null) ? ltrim(wp_normalize_path($input['template']), '/') : '';
    $post_types = $input['canonicalPostTypes'] ?? null;
    if ($label === '' || !is_array($post_types) || !array_is_list($post_types) || count($post_types) === 0) {
        zeroy_runtime_schema_violation($errors, 'schema_definition_invalid', "Schema {$schema_id} needs label, template, canonicalPostTypes and localization.", $context);
        return null;
    }
    if ($template === '' || str_contains($template, '..') || !preg_match('/\A[a-zA-Z0-9_\-\/]+\.php\z/', $template) || !is_file($theme_root . '/' . $template)) {
        zeroy_runtime_schema_violation($errors, 'schema_template_invalid', "Schema {$schema_id} references a missing or unsafe template.", $context + ['template' => $input['template'] ?? null]);
    }
    $normalized_types = [];
    foreach ($post_types as $post_type) {
        // A ThemeArtifact is prepared without loading its PHP.  Whether a CPT is
        // registered is therefore a runtime concern of WordPress/plugins, not a
        // property of the immutable artifact.  Validate the declared identifier
        // here; canonical assignment still verifies the actual post type.
        if (!is_string($post_type) || sanitize_key($post_type) !== $post_type || $post_type === '' || isset($normalized_types[$post_type])) {
            zeroy_runtime_schema_violation($errors, 'schema_post_type_invalid', "Schema {$schema_id} has an invalid canonical post type.", $context + ['postType' => $post_type]);
            continue;
        }
        $normalized_types[$post_type] = $post_type;
    }
    $policy = zeroy_localization_normalize_policy($input['localization'] ?? null, $errors, $context);
    $template_content = zeroy_runtime_normalize_template_content($input['templateContent'] ?? null, $context, $errors);
    $route = null;
    if (array_key_exists('route', $input)) {
        // Empty is the normalized storage representation of the front page;
        // public ThemeArtifact JSON must still spell that route as "/".
        $route = $stored && $input['route'] === ''
            ? ''
            : (is_string($input['route']) ? zeroy_runtime_normalize_route($input['route']) : zeroy_runtime_error('zeroy_invalid_route', 'route must be a string.', 409));
        if (is_wp_error($route)) {
            zeroy_runtime_schema_violation($errors, 'schema_route_invalid', $route->get_error_message(), $context);
            $route = null;
        }
    }
    return $label !== '' && $template !== '' && count($normalized_types) === count($post_types) && is_array($policy) && is_array($template_content)
        ? [
            'label' => $label,
            'template' => $template,
            'canonicalPostTypes' => array_values($normalized_types),
            'localization' => [
                'contract' => $policy['contract'],
                'rules' => $policy['rules'],
                'repeaterItemKeys' => $policy['repeaterItemKeys'],
            ],
            ...($template_content === [] ? [] : ['templateContent' => $template_content]),
            ...($route === null ? [] : ['route' => $route]),
        ]
        : null;
}

function zeroy_runtime_theme_schema_analysis(array $schema, ?string $theme_root = null, bool $stored = false): array
{
    $theme_root ??= get_stylesheet_directory();
    $errors = [];
    if (($schema['contract'] ?? null) !== ZEROY_THEME_SCHEMA_CONTRACT) {
        zeroy_runtime_schema_violation($errors, 'schema_contract_invalid', 'ThemeSchema has an unsupported contract.', ['expected' => ZEROY_THEME_SCHEMA_CONTRACT]);
    }
    $schemas = $schema['schemas'] ?? null;
    if (!is_array($schemas) || array_is_list($schemas) || count($schemas) === 0) {
        zeroy_runtime_schema_violation($errors, 'schema_schemas_invalid', 'ThemeSchema requires a non-empty keyed schemas object.', ['field' => 'schemas']);
        return ['schema' => null, 'errors' => $errors];
    }
    $normalized = ['contract' => ZEROY_THEME_SCHEMA_CONTRACT, 'schemas' => []];
    foreach ($schemas as $schema_id => $definition) {
        if (!is_string($schema_id) || !preg_match('/\A[a-z][a-z0-9-]{0,95}\z/', $schema_id)) {
            zeroy_runtime_schema_violation($errors, 'schema_id_invalid', 'Every ThemeSchema entry needs a valid schemaId.', ['schemaId' => $schema_id]);
            continue;
        }
        $normalized_definition = zeroy_runtime_normalize_schema_definition($schema_id, $definition, $theme_root, $errors, $stored);
        if (is_array($normalized_definition)) {
            $normalized['schemas'][$schema_id] = $normalized_definition;
        }
    }
    $subjects = $schema['localizationSubjects'] ?? [];
    if (!zeroy_runtime_is_keyed_map($subjects)) {
        zeroy_runtime_schema_violation($errors, 'localization_subjects_invalid', 'localizationSubjects must be a keyed object.', ['field' => 'localizationSubjects']);
    } else {
        $normalized_subjects = [];
        foreach ($subjects as $subject_kind => $definition) {
            if (!in_array($subject_kind, ['term', 'menu', 'siteCopy', 'media'], true) || !is_array($definition)) {
                zeroy_runtime_schema_violation($errors, 'localization_subject_invalid', 'Unsupported localization subject declaration.', ['subject' => $subject_kind]);
                continue;
            }
            $policy = zeroy_localization_normalize_policy($definition['localization'] ?? null, $errors, ['subject' => $subject_kind]);
            if (is_array($policy)) {
                $normalized_subjects[$subject_kind] = ['localization' => [
                    'contract' => $policy['contract'],
                    'rules' => $policy['rules'],
                    'repeaterItemKeys' => $policy['repeaterItemKeys'],
                ]];
            }
        }
        if ($normalized_subjects !== []) {
            $normalized['localizationSubjects'] = $normalized_subjects;
        }
    }
    $collections = zeroy_runtime_normalize_collections($schema['collections'] ?? null, $normalized['schemas'], $errors, $theme_root);
    if ($collections !== []) {
        $normalized['collections'] = $collections;
    }
    return ['schema' => $errors === [] ? $normalized : null, 'errors' => $errors];
}

function zeroy_runtime_schema_diagnostics_from_path(string $path, string $theme_root): array
{
    if (!is_file($path) || is_link($path)) {
        return ['valid' => false, 'errors' => [['code' => 'schema_missing', 'message' => 'ThemeArtifact has no regular zeroy.schema.json file.']]];
    }
    $schema = zeroy_runtime_decode_json((string) file_get_contents($path));
    if (is_wp_error($schema)) {
        return ['valid' => false, 'errors' => [['code' => 'schema_invalid_json', 'message' => $schema->get_error_message()]]];
    }
    $analysis = zeroy_runtime_theme_schema_analysis($schema, $theme_root);
    return $analysis['schema'] === null
        ? ['valid' => false, 'errors' => $analysis['errors']]
        : ['valid' => true, 'schema' => $analysis['schema'], 'contractHash' => zeroy_runtime_hash($analysis['schema']), 'schemaHashes' => zeroy_runtime_schema_hashes($analysis['schema']), 'errors' => []];
}

function zeroy_runtime_active_schema_row(): ?array
{
    $request = $GLOBALS['zeroy_runtime_request_artifact'] ?? null;
    if (is_array($request) && ($request['candidate'] ?? false) === true) {
        $artifact = zeroy_runtime_artifact_row((string) $request['artifactId']);
        return is_array($artifact) ? ['schema_json' => $artifact['schema_json'], 'contract_hash' => $artifact['schema_hash'], 'activated_at' => null, 'theme_root' => $request['directory']] : null;
    }
    $state = zeroy_runtime_active_theme_state();
    return is_array($state) ? ['schema_json' => $state['schema_json'], 'contract_hash' => $state['schema_hash'], 'activated_at' => $state['activated_at'], 'theme_root' => zeroy_runtime_artifact_directory((string) $state['artifact_id'])] : null;
}

function zeroy_runtime_schema_diagnostics(): array
{
    $row = zeroy_runtime_active_schema_row();
    if ($row === null) {
        return ['valid' => false, 'errors' => [['code' => 'schema_not_activated', 'message' => 'No active ThemeDeployment provides a ThemeSchema.']]];
    }
    $schema = zeroy_runtime_decode_json((string) $row['schema_json']);
    $analysis = is_wp_error($schema) ? ['schema' => null, 'errors' => [['code' => 'schema_snapshot_invalid', 'message' => 'The active ThemeSchema snapshot is invalid.']]] : zeroy_runtime_theme_schema_analysis($schema, (string) $row['theme_root'], true);
    if ($analysis['schema'] === null || !hash_equals((string) $row['contract_hash'], zeroy_runtime_hash($analysis['schema']))) {
        return ['valid' => false, 'errors' => $analysis['errors'] ?: [['code' => 'schema_snapshot_hash_mismatch', 'message' => 'The active ThemeSchema snapshot does not match its contract hash.']]];
    }
    return ['valid' => true, 'schema' => $analysis['schema'], 'contractHash' => $row['contract_hash'], 'schemaHashes' => zeroy_runtime_schema_hashes($analysis['schema']), 'activatedAt' => $row['activated_at'], 'errors' => []];
}

function zeroy_runtime_theme_schema(): array|WP_Error
{
    $diagnostics = zeroy_runtime_schema_diagnostics();
    return $diagnostics['valid'] ? $diagnostics['schema'] : zeroy_runtime_error('zeroy_schema_invalid', 'ThemeSchema is invalid.', 409, ['violations' => $diagnostics['errors']]);
}

function zeroy_runtime_schema_hash(array $definition): string
{
    return zeroy_runtime_hash($definition['localization']);
}

function zeroy_runtime_schema_hashes(array $schema): array
{
    return array_map('zeroy_runtime_schema_hash', $schema['schemas']);
}

function zeroy_runtime_schema_definition(string $schema_id): array|WP_Error
{
    $schema = zeroy_runtime_theme_schema();
    return is_wp_error($schema) ? $schema : (is_array($schema['schemas'][$schema_id] ?? null) ? $schema['schemas'][$schema_id] : zeroy_runtime_error('zeroy_schema_not_found', "Unknown ThemeSchema {$schema_id}.", 404));
}
