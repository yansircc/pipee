<?php

defined('ABSPATH') || exit;

function zeroy_zcss_stylesheet_ast(string $directory, string $path, int $remaining_nodes, int $remaining_declarations): array|WP_Error
{
    $absolute = rtrim($directory, '/') . '/' . $path;
    if (!is_file($absolute) || is_link($absolute)) return zeroy_runtime_error('zeroy_zcss_stylesheet_missing', 'StyleSurface references a missing or unsafe stylesheet.', 409, ['path' => $path]);
    $css = file_get_contents($absolute);
    if (!is_string($css) || strlen($css) > ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES) return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'Stylesheet exceeds the StyleSurface byte limit.', 409, ['path' => $path, 'limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES]);
    $parsed = zeroy_zcss_parse_css($css, $remaining_nodes, ZEROY_ZCSS_STYLE_SURFACE_MAX_NESTING, $remaining_declarations);
    if (!$parsed['ok']) {
        $limit = array_values(array_filter(
            $parsed['errors'],
            static fn(array $error): bool => in_array($error['code'] ?? null, ['zcss_css_node_limit', 'zcss_css_declaration_limit', 'zcss_css_nesting_limit'], true),
        ))[0] ?? null;
        if (is_array($limit)) {
            return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'Stylesheet exceeds the bounded StyleSurface parse budget.', 409, ['path' => $path, 'budget' => $limit]);
        }
        return zeroy_runtime_error('zeroy_zcss_css_invalid', 'Stylesheet cannot be parsed as a complete CSS AST.', 409, ['path' => $path, 'errors' => $parsed['errors']]);
    }
    return ['path' => $path, 'css' => $css, 'nodes' => $parsed['nodes'], 'nodeCount' => $parsed['nodeCount'], 'declarationCount' => $parsed['declarationCount']];
}

function zeroy_zcss_style_surface_from_directory(string $directory): array|WP_Error
{
    $manifest = zeroy_runtime_theme_runtime_manifest($directory);
    if (is_wp_error($manifest)) return $manifest;
    $compiled_path = rtrim($directory, '/') . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH;
    $generated_path = rtrim($directory, '/') . '/' . ZEROY_ZCSS_GENERATED_CSS_PATH;
    if (!is_file($compiled_path) || is_link($compiled_path) || !is_file($generated_path) || is_link($generated_path)) {
        return zeroy_runtime_error('zeroy_zcss_output_missing', 'StyleSurface requires both generated ZCSS files.', 409);
    }
    $compiled = is_file($compiled_path) && !is_link($compiled_path) ? zeroy_runtime_decode_json((string) file_get_contents($compiled_path)) : null;
    if (!is_array($compiled) || ($compiled['contract'] ?? null) !== ZEROY_ZCSS_COMPILED_CONTRACT || hash_file('sha256', $generated_path) !== ($compiled['outputHash'] ?? null)) {
        return zeroy_runtime_error('zeroy_zcss_output_invalid', 'StyleSurface requires compiler output bound to the exact generated CSS bytes.', 409);
    }
    $known_tokens = [];
    foreach ($compiled['tokens'] ?? [] as $token) if (is_string($token['name'] ?? null)) $known_tokens[$token['name']] = true;
    $known_primitives = [];
    $configurable = [];
    foreach ($compiled['primitives'] ?? [] as $primitive) {
        if (is_string($primitive['className'] ?? null)) $known_primitives[$primitive['className']] = true;
        foreach ($primitive['configurableProperties'] ?? [] as $property) if (is_string($property)) $configurable[$property] = true;
    }
    $sources = [];
    $stylesheet_hashes = [];
    $stylesheet_paths = [ZEROY_ZCSS_GENERATED_CSS_PATH, ...$manifest['zcss']['styles']];
    if (count($stylesheet_paths) > ZEROY_ZCSS_STYLE_SURFACE_MAX_STYLESHEETS) {
        return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'StyleSurface has too many stylesheets.', 409, ['stylesheets' => count($stylesheet_paths), 'limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_STYLESHEETS]);
    }
    $total_bytes = 0;
    foreach ($stylesheet_paths as $path) {
        $absolute = rtrim($directory, '/') . '/' . $path;
        if (!is_file($absolute) || is_link($absolute)) return zeroy_runtime_error('zeroy_zcss_stylesheet_missing', 'StyleSurface references a missing or unsafe stylesheet.', 409, ['path' => $path]);
        $bytes = filesize($absolute);
        if (!is_int($bytes) || $bytes < 0) return zeroy_runtime_error('zeroy_zcss_stylesheet_missing', 'StyleSurface could not measure a stylesheet.', 409, ['path' => $path]);
        $total_bytes += $bytes;
        if ($total_bytes > ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES) {
            return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'StyleSurface exceeds its total stylesheet byte limit.', 409, ['bytes' => $total_bytes, 'limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES]);
        }
    }
    $node_count = 0;
    $declaration_count = 0;
    foreach ($stylesheet_paths as $path) {
        $source = zeroy_zcss_stylesheet_ast($directory, $path, ZEROY_ZCSS_STYLE_SURFACE_MAX_NODES - $node_count, ZEROY_ZCSS_STYLE_SURFACE_MAX_DECLARATIONS - $declaration_count);
        if (is_wp_error($source)) return $source;
        $node_count += $source['nodeCount'];
        $declaration_count += $source['declarationCount'];
        if ($path !== ZEROY_ZCSS_GENERATED_CSS_PATH) {
            $import = null;
            zeroy_zcss_walk_css_nodes($source['nodes'], static function (array $node) use (&$import): void {
                if ($import !== null || ($node['type'] ?? null) !== 'at-rule') return;
                $prelude = (string) ($node['prelude'] ?? '');
                if (preg_match('/^@import\b/i', $prelude) === 1) $import = ['line' => (int) ($node['line'] ?? 1), 'prelude' => $prelude];
            });
            if ($import !== null) {
                return zeroy_runtime_error('zeroy_zcss_stylesheet_import_forbidden', 'Manifest-declared custom CSS cannot import another stylesheet.', 409, ['path' => $path, 'line' => $import['line'], 'atRule' => $import['prelude'], 'repair' => 'Place the required CSS in one manifest-declared ThemeArtifact stylesheet.']);
            }
        }
        $sources[] = $source;
        $stylesheet_hashes[$path] = hash('sha256', $source['css']);
    }
    $custom_properties = [];
    $custom_selectors = [];
    $source_mapping = [];
    $references = [];
    $declared = $known_tokens + $configurable;
    $violations = [];
    foreach ($sources as $source_index => $source) {
        $generated = $source_index === 0;
        zeroy_zcss_walk_css_nodes($source['nodes'], static function (array $node) use (&$custom_properties, &$custom_selectors, &$source_mapping, &$references, &$declared, &$violations, $source, $generated, $known_primitives, $configurable): void {
            if (($node['type'] ?? null) === 'rule') {
                $selector = (string) ($node['prelude'] ?? '');
                if (!$generated) {
                    $custom_selectors[$selector] = true;
                    $source_mapping[] = ['kind' => 'selector', 'name' => $selector, 'source' => $source['path'], 'line' => $node['line']];
                    foreach (zeroy_zcss_css_identifiers($selector, '.z-') as $class) {
                        $name = substr($class, 1);
                        if (!isset($known_primitives[$name])) $violations[] = ['code' => 'zcss_reserved_class_unknown', 'name' => $class, 'source' => $source['path'], 'line' => $node['line']];
                    }
                }
            }
            foreach ($node['declarations'] ?? [] as $declaration) {
                $property = $declaration['property'];
                if (str_starts_with($property, '--')) {
                    $declared[$property] = true;
                    if (!$generated && str_starts_with($property, '--z-') && !isset($configurable[$property])) $violations[] = ['code' => 'zcss_reserved_property_redefined', 'name' => $property, 'source' => $source['path'], 'line' => $declaration['line']];
                    elseif (!$generated && !str_starts_with($property, '--z-')) $custom_properties[$property] = $declaration['value'];
                    if (!$generated) $source_mapping[] = ['kind' => 'property', 'name' => $property, 'source' => $source['path'], 'line' => $declaration['line']];
                }
                foreach (zeroy_zcss_css_identifiers($declaration['value'], '--') as $reference) $references[$reference] = true;
            }
        });
    }
    $undefined = array_values(array_diff(array_keys($references), array_keys($declared)));
    sort($undefined, SORT_STRING);
    ksort($custom_properties, SORT_STRING);
    $selectors = array_keys($custom_selectors);
    sort($selectors, SORT_STRING);
    return [
        'contract' => ZEROY_ZCSS_STYLE_SURFACE_CONTRACT,
        'compiler' => $compiled['compiler'],
        'designHash' => $compiled['designHash'],
        'outputHash' => $compiled['outputHash'],
        'stylesheetHashes' => $stylesheet_hashes,
        'stylesheetSetHash' => zeroy_zcss_hash($stylesheet_hashes),
        'tokens' => $compiled['tokens'],
        'primitives' => $compiled['primitives'],
        'customProperties' => $custom_properties,
        'customSelectors' => $selectors,
        'sourceMapping' => $source_mapping,
        'undefinedReferences' => $undefined,
        'reservedNamespaceViolations' => $violations,
        'summary' => ['stylesheets' => count($sources), 'nodes' => $node_count, 'declarations' => $declaration_count, 'customSelectors' => count($selectors), 'customProperties' => count($custom_properties)],
    ];
}
