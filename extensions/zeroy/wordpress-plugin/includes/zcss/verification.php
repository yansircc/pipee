<?php

defined('ABSPATH') || exit;

function zeroy_zcss_verification_failures(string $theme_directory): array
{
    $manifest = zeroy_runtime_theme_runtime_manifest($theme_directory);
    if (is_wp_error($manifest)) {
        return [zeroy_runtime_verification_failure($manifest->get_error_code(), 'ThemeArtifact must use the exact ThemeManifest v3 stylesheet contract.', 'zeroy.theme.json', 1, $manifest->get_error_message(), 'Write a complete ThemeManifest v3 and its declared design/custom styles.')];
    }
    $design_path = rtrim($theme_directory, '/') . '/' . $manifest['zcss']['design'];
    $design = is_file($design_path) && !is_link($design_path) ? zeroy_runtime_decode_json((string) file_get_contents($design_path)) : null;
    $recompiled = is_array($design) ? zeroy_zcss_compile($design) : ['ok' => false, 'diagnostics' => [['code' => 'zcss_design_invalid']]];
    if (($recompiled['ok'] ?? false) !== true) {
        return [zeroy_runtime_verification_failure('zcss_design_invalid', 'DesignDocument must decode and compile with the pinned ZCSS compiler.', 'zcss.design.json', 1, zeroy_runtime_json($recompiled['diagnostics'] ?? []), 'Repair zcss.design.json using the zcssContract resource.')];
    }
    $actual_css = file_get_contents(rtrim($theme_directory, '/') . '/' . ZEROY_ZCSS_GENERATED_CSS_PATH);
    $actual_manifest = file_get_contents(rtrim($theme_directory, '/') . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH);
    if (!is_string($actual_css) || !is_string($actual_manifest) || $actual_css !== $recompiled['css'] || $actual_manifest !== $recompiled['manifestJson']) {
        return [zeroy_runtime_verification_failure('zcss_generated_output_mismatch', 'Generated ZCSS bytes must equal a fresh compilation of the pinned DesignDocument.', ZEROY_ZCSS_GENERATED_CSS_PATH, 1, 'Generated CSS or compiled manifest differs from deterministic recompilation.', 'Do not write generated paths; restage the design so the SiteCheckout compiler replaces both outputs.')];
    }
    $surface = zeroy_zcss_style_surface_from_directory($theme_directory);
    if (is_wp_error($surface)) {
        return [zeroy_runtime_verification_failure($surface->get_error_code(), 'ThemeArtifact stylesheets must form one valid compiled StyleSurface.', ZEROY_ZCSS_COMPILED_MANIFEST_PATH, 1, $surface->get_error_message(), 'Repair the ZCSS design or custom CSS, then retry the same SiteCheckout.')];
    }
    $failures = [];
    foreach ($surface['reservedNamespaceViolations'] as $violation) {
        $failures[] = zeroy_runtime_verification_failure($violation['code'], 'Compiler-owned .z-* and --z-* namespaces must remain closed.', $violation['source'], $violation['line'], $violation['name'], 'Use a public ZCSS primitive/configurable property or a site/component-owned name.');
    }
    foreach ($surface['undefinedReferences'] as $reference) {
        if (!str_starts_with($reference, '--z-')) continue;
        $failures[] = zeroy_runtime_verification_failure('zcss_reserved_reference_undefined', 'Every --z-* reference must resolve in the compiled contract.', ZEROY_ZCSS_COMPILED_MANIFEST_PATH, 1, $reference, 'Use a token published by zcssContract/styleSurface.');
    }
    $known = array_fill_keys(array_column($surface['primitives'], 'className'), true);
    foreach (zeroy_runtime_php_files($theme_directory) as $path) {
        $source = file_get_contents($path);
        if (!is_string($source)) continue;
        foreach (token_get_all($source) as $token) {
            if (!is_array($token) || !in_array($token[0], [T_INLINE_HTML, T_CONSTANT_ENCAPSED_STRING, T_ENCAPSED_AND_WHITESPACE], true)) continue;
            foreach (zeroy_zcss_css_identifiers($token[1], 'z-') as $class) {
                if (isset($known[$class])) continue;
                $failures[] = zeroy_runtime_verification_failure('zcss_template_primitive_unknown', 'Theme templates may reference only public ZCSS Core primitive classes.', ltrim(substr($path, strlen(rtrim($theme_directory, '/'))), '/'), (int) $token[2], $class, 'Inspect zcssContract and use a published primitive or a non-reserved semantic class.');
            }
        }
    }
    return $failures;
}
