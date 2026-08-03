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

/**
 * Candidate verification loads SiteLogic bootstrap so that Theme/logic
 * composition is tested together. Its top level must therefore be a pure
 * declaration program: one ABSPATH guard, named handler definitions, and
 * literal capability registrations. Effects only become reachable through a
 * registered handler and zeroy_site_logic_call().
 */
function zeroy_runtime_site_logic_bootstrap_failures(string $directory): array
{
    $path = rtrim($directory, '/') . '/bootstrap.php';
    $source = is_file($path) && !is_link($path) ? file_get_contents($path) : false;
    if (!is_string($source)) return [zeroy_runtime_verification_failure('site_logic_bootstrap_missing', 'SiteLogicArtifact must have a readable bootstrap declaration program.', 'bootstrap.php', 1, 'bootstrap.php is missing or unreadable.', 'Provide a regular bootstrap.php.')];
    $guarded = preg_replace('/\A\s*<\?php\s+defined\(\s*[\'\"]ABSPATH[\'\"]\s*\)\s*\|\|\s*exit\s*;\s*/', '<?php ', $source, 1, $guard_count);
    if ($guarded === null || $guard_count !== 1) {
        return [zeroy_runtime_verification_failure('site_logic_bootstrap_guard_invalid', 'SiteLogic bootstrap must start with the standard ABSPATH guard.', 'bootstrap.php', 1, 'Missing exact defined(ABSPATH) || exit guard.', 'Start bootstrap.php with defined(\'ABSPATH\') || exit;')];
    }
    $tokens = token_get_all($guarded);
    $failures = [];
    $depth = 0;
    $declaration = false;
    $function_name_required = false;
    $count = count($tokens);
    for ($index = 0; $index < $count; $index++) {
        $token = $tokens[$index];
        $text = is_array($token) ? $token[1] : $token;
        $line = is_array($token) ? $token[2] : 1;
        if ($depth > 0) {
            if ($text === '{') $depth++;
            if ($text === '}') $depth--;
            continue;
        }
        if ($declaration) {
            if ($function_name_required) {
                if (is_array($token) && $token[0] === T_STRING) {
                    $function_name_required = false;
                    continue;
                }
                if (is_array($token) && in_array($token[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
                $failures[] = zeroy_runtime_verification_failure('site_logic_bootstrap_function_invalid', 'SiteLogic bootstrap may declare only named top-level handler functions.', 'bootstrap.php', $line, $text, 'Declare a named function, then register that function with a literal zeroy_register_site_logic_capability call.');
                $declaration = false;
                $function_name_required = false;
                continue;
            }
            if ($text === '{') {
                $depth = 1;
                $declaration = false;
            }
            continue;
        }
        if (is_array($token) && in_array($token[0], [T_OPEN_TAG, T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
        if (is_array($token) && $token[0] === T_FUNCTION) {
            $declaration = true;
            $function_name_required = true;
            continue;
        }
        if (is_array($token) && $token[0] === T_STRING && $text === 'zeroy_register_site_logic_capability') {
            $statement = $text;
            while (++$index < $count) {
                $part = $tokens[$index];
                $part_text = is_array($part) ? $part[1] : $part;
                $statement .= $part_text;
                if ($part_text === ';') break;
            }
            if (preg_match('/\Azeroy_register_site_logic_capability\s*\(\s*[\'\"][a-z][a-z0-9]*(?:[.-][a-z0-9]+)*[\'\"]\s*,\s*[\'\"][1-9][0-9]*[\'\"]\s*,\s*[\'\"][a-zA-Z_][a-zA-Z0-9_]*[\'\"]\s*\)\s*;\z/', $statement) === 1) continue;
            $failures[] = zeroy_runtime_verification_failure('site_logic_bootstrap_registration_invalid', 'SiteLogic bootstrap may register only a literal capability/version/named-handler triple.', 'bootstrap.php', $line, $statement, 'Use zeroy_register_site_logic_capability(\'capability\', \'1\', \'handler_name\').');
            continue;
        }
        $statement = $text;
        $nesting = 0;
        while (++$index < $count) {
            $part = $tokens[$index];
            $part_text = is_array($part) ? $part[1] : $part;
            $statement .= $part_text;
            if (in_array($part_text, ['(', '[', '{'], true)) $nesting++;
            if (in_array($part_text, [')', ']', '}'], true)) $nesting--;
            if ($part_text === ';' && $nesting === 0) break;
        }
        $failures[] = zeroy_runtime_verification_failure('site_logic_bootstrap_effect_forbidden', 'SiteLogic bootstrap cannot execute arbitrary top-level code before CandidateProof.', 'bootstrap.php', $line, trim($statement), 'Move the statement into a named capability handler and register that handler with a literal zeroy_register_site_logic_capability call.');
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
        ['code' => 'theme_stylesheet_owner_forbidden', 'invariant' => 'ThemeManifest v3 and the Connector request adapter own the complete global stylesheet order.', 'pattern' => '/(?:\\b(?:wp_enqueue_style|wp_register_style|get_stylesheet_uri)\\s*\\(|<link\\b[^>]*\\brel\\s*=\\s*[\'\"]?stylesheet)/i', 'repair' => 'Declare Agent-owned CSS in zeroy.theme.json zcss.styles; do not enqueue or link a second global stylesheet from ThemeArtifact code.'],
        ['code' => 'theme_dynamic_include_forbidden', 'invariant' => 'ThemeArtifact include paths must be static and reviewable.', 'pattern' => '/\\b(?:include|include_once|require|require_once)\\s*\\(?\\s*\\$/i', 'repair' => 'Use a literal file suffix rooted in the pinned ThemeArtifact.'],
        ['code' => 'theme_live_projection_forbidden', 'invariant' => 'ThemeArtifact must consume its single ThemeRenderContext and cannot query a second content, locale, relation, or route projection.', 'pattern' => '/(?:\\b(?:get_post|get_posts|get_field|get_fields|get_terms|get_term|get_term_by|get_permalink|the_permalink|post_type_link|home_url|zeroy_localization_[a-z0-9_]+|zeroy_runtime_route_url|zeroy_locale_entities|zeroy_collection_items)\\s*\\(|\\bWP_Query\\b|\\$wpdb\\b|\\$_(?:GET|POST|REQUEST)\\b)/i', 'repair' => 'Read the required value, URL, relation, search query, or collection item from zeroy_theme_context().'],
        ['code' => 'theme_legacy_context_forbidden', 'invariant' => 'ThemeArtifact must consume one ThemeRenderContext rather than legacy injected variables.', 'pattern' => '/\\$zeroy_(?:object_id|schema_id)\\b/', 'repair' => 'Read zeroy_theme_context() and use resolvedContent, routeKind, locale, and seo.'],
        ['code' => 'theme_connector_lifecycle_forbidden', 'invariant' => 'ThemeArtifact cannot bypass the SiteCommit to SiteRelease lifecycle.', 'pattern' => '/\\b(?:zeroy_checkout_apply_materialization_plan|zeroy_runtime_(?:activate_site_release(?:_locked)?|create_canonical|adopt_canonical|write_template_content|write_canonical_content|write_site_config_locked)|zeroy_localization_(?:write_translation_draft|write_translation_values|publish_translation|unpublish_translation))\\s*\\(/i', 'repair' => 'Change the local SiteCheckout and push a verified release; ThemeArtifact may only render zeroy_theme_context().'],
    ];
    $logic_rules = [
        ['code' => 'site_logic_rendering_forbidden', 'invariant' => 'SiteLogicArtifact owns business behavior, not Theme rendering.', 'pattern' => '/\\b(?:get_header|get_footer|get_sidebar|wp_head|wp_footer|locate_template|load_template|the_content)\\s*\\(/i', 'repair' => 'Expose a capability output and render it in ThemeArtifact.'],
        ['code' => 'site_logic_connector_lifecycle_forbidden', 'invariant' => 'SiteLogicArtifact cannot bypass the SiteCommit to SiteRelease lifecycle.', 'pattern' => '/\\b(?:zeroy_checkout_apply_materialization_plan|zeroy_runtime_(?:activate_site_release(?:_locked)?|create_canonical|adopt_canonical|write_template_content|write_canonical_content|write_site_config_locked)|zeroy_localization_(?:write_translation_draft|write_translation_values|publish_translation|unpublish_translation))\\s*\\(/i', 'repair' => 'Use a declared SiteLogic capability for its own facts; site content and release lifecycle change only through a verified SiteCommit.'],
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
    $theme_failures = [...zeroy_runtime_lint_artifact_directory($theme_dir, 'ThemeArtifact'), ...zeroy_runtime_static_pattern_failures($theme_dir, $theme_rules), ...zeroy_zcss_verification_failures($theme_dir)];
    $logic_failures = [...zeroy_runtime_lint_artifact_directory($logic_dir, 'SiteLogicArtifact'), ...zeroy_runtime_site_logic_bootstrap_failures($logic_dir), ...zeroy_runtime_static_pattern_failures($logic_dir, $logic_rules)];
    return ['checks' => ['themeFiles' => count(zeroy_runtime_php_files($theme_dir)), 'siteLogicFiles' => count(zeroy_runtime_php_files($logic_dir)), 'boundaryRules' => count($theme_rules) + count($logic_rules)], 'failures' => [...$theme_failures, ...$logic_failures]];
}
