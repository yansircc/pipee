<?php

defined('ABSPATH') || exit;

const ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES = 2_000_000;
const ZEROY_ZCSS_STYLE_SURFACE_MAX_NODES = 10_000;

function zeroy_zcss_stylesheet_ast(string $directory, string $path): array|WP_Error
{
    $absolute = rtrim($directory, '/') . '/' . $path;
    if (!is_file($absolute) || is_link($absolute)) return zeroy_runtime_error('zeroy_zcss_stylesheet_missing', 'StyleSurface references a missing or unsafe stylesheet.', 409, ['path' => $path]);
    $css = file_get_contents($absolute);
    if (!is_string($css) || strlen($css) > ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES) return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'Stylesheet exceeds the StyleSurface byte limit.', 409, ['path' => $path, 'limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES]);
    $parsed = zeroy_zcss_parse_css($css);
    if (!$parsed['ok']) return zeroy_runtime_error('zeroy_zcss_css_invalid', 'Stylesheet cannot be parsed as a complete CSS AST.', 409, ['path' => $path, 'errors' => $parsed['errors']]);
    return ['path' => $path, 'css' => $css, 'nodes' => $parsed['nodes']];
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
    foreach ([ZEROY_ZCSS_GENERATED_CSS_PATH, ...$manifest['zcss']['styles']] as $path) {
        $source = zeroy_zcss_stylesheet_ast($directory, $path);
        if (is_wp_error($source)) return $source;
        $sources[] = $source;
        $stylesheet_hashes[$path] = hash('sha256', $source['css']);
    }
    $node_count = 0;
    $site_tokens = [];
    $private_properties = [];
    $custom_selectors = [];
    $source_mapping = [];
    $references = [];
    $declared = $known_tokens + $configurable;
    $violations = [];
    foreach ($sources as $source_index => $source) {
        $generated = $source_index === 0;
        zeroy_zcss_walk_css_nodes($source['nodes'], static function (array $node) use (&$node_count, &$site_tokens, &$private_properties, &$custom_selectors, &$source_mapping, &$references, &$declared, &$violations, $source, $generated, $known_primitives, $configurable): void {
            $node_count++;
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
                    if (!$generated && str_starts_with($property, '--site-')) $site_tokens[$property] = $declaration['value'];
                    elseif (!$generated && str_starts_with($property, '--z-') && !isset($configurable[$property])) $violations[] = ['code' => 'zcss_reserved_property_redefined', 'name' => $property, 'source' => $source['path'], 'line' => $declaration['line']];
                    elseif (!$generated && !str_starts_with($property, '--z-')) $private_properties[$property] = true;
                    if (!$generated) $source_mapping[] = ['kind' => 'property', 'name' => $property, 'source' => $source['path'], 'line' => $declaration['line']];
                }
                foreach (zeroy_zcss_css_identifiers($declaration['value'], '--') as $reference) $references[$reference] = true;
            }
        });
    }
    if ($node_count > ZEROY_ZCSS_STYLE_SURFACE_MAX_NODES) return zeroy_runtime_error('zeroy_zcss_stylesheet_limit', 'Stylesheet AST exceeds the StyleSurface node limit.', 409, ['nodes' => $node_count, 'limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_NODES]);
    $undefined = array_values(array_diff(array_keys($references), array_keys($declared)));
    sort($undefined, SORT_STRING);
    ksort($site_tokens, SORT_STRING);
    $private = array_keys($private_properties);
    $selectors = array_keys($custom_selectors);
    sort($private, SORT_STRING);
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
        'siteTokens' => $site_tokens,
        'customSelectors' => $selectors,
        'componentPrivateProperties' => $private,
        'sourceMapping' => $source_mapping,
        'undefinedReferences' => $undefined,
        'reservedNamespaceViolations' => $violations,
        'summary' => ['stylesheets' => count($sources), 'nodes' => $node_count, 'customSelectors' => count($selectors), 'siteTokens' => count($site_tokens), 'privateProperties' => count($private)],
    ];
}
