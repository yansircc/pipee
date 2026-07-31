<?php

defined('ABSPATH') || exit;

function zeroy_runtime_php_files(string $directory): array
{
    if (!is_dir($directory) || is_link($directory)) return [];
    $files = [];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
    foreach ($iterator as $file) {
        if ($file instanceof SplFileInfo && $file->isFile() && !$file->isLink() && str_ends_with($file->getFilename(), '.php')) $files[] = $file->getPathname();
    }
    sort($files, SORT_STRING);
    return $files;
}

function zeroy_runtime_verification_failure(string $code, string $invariant, string $file, int $line, string $evidence, string $repair): array
{
    return ['code' => $code, 'invariant' => $invariant, 'file' => $file, 'line' => $line, 'evidence' => $evidence, 'repair' => $repair];
}

function zeroy_runtime_static_pattern_failures(string $directory, array $rules): array
{
    $failures = [];
    foreach (zeroy_runtime_php_files($directory) as $path) {
        $source = file_get_contents($path);
        if (!is_string($source)) continue;
        foreach ($rules as $rule) {
            if (preg_match_all($rule['pattern'], $source, $matches, PREG_OFFSET_CAPTURE) !== false) {
                foreach ($matches[0] as $match) {
                    $line = substr_count(substr($source, 0, $match[1]), "\n") + 1;
                    $failures[] = zeroy_runtime_verification_failure($rule['code'], $rule['invariant'], ltrim(substr($path, strlen(rtrim($directory, '/'))), '/'), $line, $match[0], $rule['repair']);
                }
            }
        }
    }
    return $failures;
}

function zeroy_runtime_lint_artifact_directory(string $directory, string $owner): array
{
    $failures = [];
    foreach (zeroy_runtime_php_files($directory) as $path) {
        $lint = zeroy_runtime_php_lint($path);
        if ($lint !== null) $failures[] = zeroy_runtime_verification_failure((string) $lint['code'], $owner . ' must be syntactically valid PHP.', ltrim(substr($path, strlen(rtrim($directory, '/'))), '/'), 1, (string) $lint['message'], 'Repair the PHP syntax before creating another release candidate.');
    }
    return $failures;
}

function zeroy_runtime_verify_static_boundaries(string $theme_artifact_id, string $site_logic_artifact_id): array
{
    $theme_dir = zeroy_runtime_artifact_directory($theme_artifact_id);
    $logic_dir = zeroy_runtime_site_logic_directory($site_logic_artifact_id);
    $theme_rules = [
        ['code' => 'theme_persistence_forbidden', 'invariant' => 'ThemeArtifact is a read-only Presentation Artifact.', 'pattern' => '/\\b(?:update_option|add_option|delete_option|wp_insert_post|wp_update_post|wp_delete_post|update_post_meta|add_post_meta|delete_post_meta|update_field|add_row|update_row|delete_row)\\s*\\(/i', 'repair' => 'Move the write into a SiteLogic action capability.'],
        ['code' => 'theme_runtime_side_effect_forbidden', 'invariant' => 'ThemeArtifact cannot own jobs, migrations, Connector routes or request-time writes.', 'pattern' => '/\\b(?:register_rest_route|wp_schedule_event|wp_schedule_single_event|dbDelta|eval|shell_exec|exec|system|file_put_contents|fopen|unlink|rename)\\s*\\(/i', 'repair' => 'Move the effect into SiteLogic or Connector ownership.'],
        ['code' => 'theme_dynamic_include_forbidden', 'invariant' => 'ThemeArtifact include paths must be static and reviewable.', 'pattern' => '/\\b(?:include|include_once|require|require_once)\\s*\\(?\\s*\\$/i', 'repair' => 'Use a literal file suffix rooted in the pinned ThemeArtifact.'],
        ['code' => 'theme_route_guessing_forbidden', 'invariant' => 'ThemeArtifact must consume LocaleStore route projections rather than infer WordPress permalinks.', 'pattern' => '/\\b(?:get_permalink|the_permalink|post_type_link)\\s*\\(/i', 'repair' => 'Use zeroy_locale_entities() or a Connector-provided resolved URL.'],
    ];
    $logic_rules = [
        ['code' => 'site_logic_rendering_forbidden', 'invariant' => 'SiteLogicArtifact owns business behavior, not Theme rendering.', 'pattern' => '/\\b(?:get_header|get_footer|get_sidebar|wp_head|wp_footer|locate_template|load_template|the_content)\\s*\\(/i', 'repair' => 'Expose a capability output and render it in ThemeArtifact.'],
    ];
    $logic = zeroy_runtime_site_logic_artifact_row($site_logic_artifact_id);
    $contract = $logic === null ? null : zeroy_runtime_decode_json((string) $logic['contract_json']);
    $declared = [];
    foreach (is_array($contract['provides'] ?? null) ? $contract['provides'] : [] as $provided) {
        foreach (is_array($provided['effects'] ?? null) ? $provided['effects'] : [] as $effect) $declared[$effect] = true;
    }
    $effect_patterns = [
        'write' => '/(?:->(?:insert|update|delete|replace|query)\\s*\\(|\\b(?:wp_insert_|wp_update_|update_option|add_option|delete_option|update_post_meta|add_post_meta|delete_post_meta)\\w*\\s*\\()/i',
        'external-request' => '/\\b(?:wp_(?:safe_)?remote_(?:get|post|request)|curl_exec)\\s*\\(/i',
        'file-write' => '/\\b(?:file_put_contents|fopen|unlink|rename|copy|mkdir|rmdir)\\s*\\(/i',
        'background-job' => '/\\b(?:wp_schedule_event|wp_schedule_single_event|as_enqueue_async_action)\\s*\\(/i',
    ];
    foreach ($effect_patterns as $effect => $pattern) {
        if (!isset($declared[$effect])) {
            $logic_rules[] = ['code' => 'site_logic_effect_undeclared', 'invariant' => 'SiteLogic effects must be declared by its immutable public contract.', 'pattern' => $pattern, 'repair' => 'Declare the effect in SiteLogicContract or move the effect to its correct owner.'];
        }
    }
    $theme_failures = [...zeroy_runtime_lint_artifact_directory($theme_dir, 'ThemeArtifact'), ...zeroy_runtime_static_pattern_failures($theme_dir, $theme_rules)];
    $logic_failures = [...zeroy_runtime_lint_artifact_directory($logic_dir, 'SiteLogicArtifact'), ...zeroy_runtime_static_pattern_failures($logic_dir, $logic_rules)];
    return ['checks' => ['themeFiles' => count(zeroy_runtime_php_files($theme_dir)), 'siteLogicFiles' => count(zeroy_runtime_php_files($logic_dir)), 'boundaryRules' => count($theme_rules) + count($logic_rules)], 'failures' => [...$theme_failures, ...$logic_failures]];
}
