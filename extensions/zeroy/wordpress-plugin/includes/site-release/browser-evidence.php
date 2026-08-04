<?php

defined('ABSPATH') || exit;

const ZEROY_BROWSER_VERIFICATION_CHALLENGE_CONTRACT = 'zeroy/browser-verification-challenge@4';
const ZEROY_BROWSER_EVIDENCE_CONTRACT = 'zeroy/browser-evidence@4';
const ZEROY_BROWSER_VERIFIER_ID = 'zeroy/pi-browser-verifier@4';

function zeroy_runtime_browser_viewports(): array
{
    $widths = zeroy_zcss_browser_policy()['viewports'];
    return [
        ['id' => 'mobile', 'width' => (int) $widths['mobile'], 'height' => 800],
        ['id' => 'tablet', 'width' => (int) $widths['tablet'], 'height' => 1024],
        ['id' => 'desktop', 'width' => (int) $widths['desktop'], 'height' => 900],
    ];
}

function zeroy_runtime_browser_contrast_pairs(): array
{
    return zeroy_zcss_contrast_pairs();
}

/**
 * The challenge is a pure projection of the immutable candidate. Browser
 * evidence never chooses its own scenario, stylesheet, viewport, or contrast
 * scope; it can only answer this exact challenge.
 */
function zeroy_runtime_browser_verification_challenge(array $release, array $scenarios): array|WP_Error
{
    $surface = zeroy_zcss_style_surface_from_directory(zeroy_runtime_artifact_directory((string) $release['theme_artifact_id']));
    if (is_wp_error($surface)) return $surface;
    $base = zeroy_runtime_evidence_asset_base_url((string) $release['release_id']);
    $stylesheets = [];
    foreach ($surface['stylesheetHashes'] as $path => $hash) {
        $stylesheets[] = [
            'path' => $path,
            'hash' => $hash,
            'url' => add_query_arg('ver', $hash, rtrim($base, '/') . '/' . $path),
        ];
    }
    $challenge = [
        'contract' => ZEROY_BROWSER_VERIFICATION_CHALLENGE_CONTRACT,
        'verifier' => ['id' => ZEROY_BROWSER_VERIFIER_ID, 'version' => '1'],
        'releaseId' => (string) $release['release_id'],
        'themeArtifactId' => (string) $release['theme_artifact_id'],
        'scenarioSetHash' => zeroy_runtime_hash($scenarios),
        'stylesheetSetHash' => (string) $surface['stylesheetSetHash'],
        'stylesheets' => $stylesheets,
        'viewports' => zeroy_runtime_browser_viewports(),
        'contrastPairs' => zeroy_runtime_browser_contrast_pairs(),
        'scenarios' => array_map(
            static fn(array $scenario): array => [
                'id' => (string) $scenario['id'],
                'kind' => (string) $scenario['kind'],
                'locale' => (string) $scenario['locale'],
                'url' => zeroy_runtime_candidate_scenario_url('release', (string) $release['release_id'], $scenario),
                'expectedStatus' => (int) $scenario['expectedStatus'],
                'expectedRouteKind' => is_string($scenario['expectedRouteKind'] ?? null) ? $scenario['expectedRouteKind'] : null,
                'requiredFields' => array_values(is_array($scenario['requiredFields'] ?? null) ? $scenario['requiredFields'] : []),
            ],
            $scenarios,
        ),
    ];
    $challenge['challengeHash'] = zeroy_runtime_hash($challenge);
    return $challenge;
}

function zeroy_runtime_browser_evidence_exact_keys(array $value, array $keys): bool
{
    $actual = array_keys($value);
    sort($actual, SORT_STRING);
    sort($keys, SORT_STRING);
    return $actual === $keys;
}

/**
 * Browser measurements are a finite product, not one opaque blob. Keeping the
 * invalid field names lets the verifier and the Worker repair their boundary
 * without exposing response bodies or asking an Agent to guess.
 */
function zeroy_runtime_browser_result_invalid_fields(array $result): array
{
    $invalid = [];
    foreach (['scenario', 'viewport', 'stylesheetIdentity'] as $field) {
        if (!is_string($result[$field] ?? null) || $result[$field] === '') $invalid[] = $field;
    }
    if (!is_int($result['status'] ?? null) || $result['status'] < 100 || $result['status'] > 599) $invalid[] = 'status';
    if (!is_string($result['routeKind'] ?? null) && ($result['routeKind'] ?? null) !== null) $invalid[] = 'routeKind';
    foreach (['documentClientWidth', 'documentScrollWidth', 'overflowElements', 'mediaOverflowElements', 'visibleTextContrastFailures', 'visibleTextContrastIndeterminate'] as $field) {
        if (!is_int($result[$field] ?? null) || $result[$field] < (in_array($field, ['documentClientWidth', 'documentScrollWidth'], true) ? 1 : 0)) $invalid[] = $field;
    }
    foreach ([
        'stylesheets' => [false, 0],
        'overflowSamples' => [true, 5],
        'mediaOverflowSamples' => [true, 5],
        'visibleTextContrastSamples' => [true, 5],
        'visibleTextContrastIndeterminateSamples' => [true, 5],
        'renderedFields' => [false, 0],
    ] as $field => [$non_empty, $maximum]) {
        $value = $result[$field] ?? null;
        if (!is_array($value) || !array_is_list($value) || ($maximum > 0 && count($value) > $maximum) || array_filter($value, static fn(mixed $item): bool => !is_string($item) || ($non_empty && $item === '')) !== []) $invalid[] = $field;
    }
    if (!is_bool($result['focusVisible'] ?? null) && ($result['focusVisible'] ?? null) !== null) $invalid[] = 'focusVisible';
    if (!is_bool($result['reducedMotion'] ?? null)) $invalid[] = 'reducedMotion';
    $contrast = $result['contrastRatios'] ?? null;
    if (!zeroy_runtime_is_keyed_map($contrast) || array_filter($contrast, static fn(mixed $value): bool => (!is_int($value) && !is_float($value)) || !is_finite((float) $value) || $value < 0) !== []) $invalid[] = 'contrastRatios';
    foreach ([
        'visibleTextContrastFailures' => 'visibleTextContrastSamples',
        'visibleTextContrastIndeterminate' => 'visibleTextContrastIndeterminateSamples',
    ] as $count_field => $sample_field) {
        $count = $result[$count_field] ?? null;
        $samples = $result[$sample_field] ?? null;
        if (is_int($count) && is_array($samples) && (($count === 0 && $samples !== []) || ($count > 0 && ($samples === [] || count($samples) > $count)))) $invalid[] = $sample_field;
    }
    if (is_array($result['renderedFields'] ?? null) && array_filter($result['renderedFields'], static fn(mixed $value): bool => !is_string($value) || !str_starts_with($value, '/acf/')) !== []) $invalid[] = 'renderedFields';
    return array_values(array_unique($invalid));
}

function zeroy_runtime_decode_browser_evidence(mixed $input): array|WP_Error
{
    if (!zeroy_runtime_is_keyed_map($input) || !zeroy_runtime_browser_evidence_exact_keys($input, ['contract', 'challengeHash', 'releaseId', 'themeArtifactId', 'scenarioSetHash', 'stylesheetSetHash', 'verifier', 'results'])) {
        return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser evidence must be one exact keyed document.', 400);
    }
    if (
        ($input['contract'] ?? null) !== ZEROY_BROWSER_EVIDENCE_CONTRACT
        || !is_string($input['challengeHash'] ?? null)
        || !is_string($input['releaseId'] ?? null)
        || !is_string($input['themeArtifactId'] ?? null)
        || !is_string($input['scenarioSetHash'] ?? null)
        || !is_string($input['stylesheetSetHash'] ?? null)
        || !zeroy_runtime_is_keyed_map($input['verifier'] ?? null)
        || !zeroy_runtime_browser_evidence_exact_keys($input['verifier'], ['id', 'version', 'engine', 'engineVersion'])
        || ($input['verifier']['id'] ?? null) !== ZEROY_BROWSER_VERIFIER_ID
        || ($input['verifier']['version'] ?? null) !== '1'
        || !is_string($input['verifier']['engine'] ?? null)
        || $input['verifier']['engine'] === ''
        || !is_string($input['verifier']['engineVersion'] ?? null)
        || $input['verifier']['engineVersion'] === ''
        || !is_array($input['results'] ?? null)
        || !array_is_list($input['results'])
    ) return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser evidence identity or verifier metadata is invalid.', 400);
    foreach ($input['results'] as $result) {
        if (!zeroy_runtime_is_keyed_map($result) || !zeroy_runtime_browser_evidence_exact_keys($result, ['scenario', 'viewport', 'status', 'routeKind', 'stylesheetIdentity', 'stylesheets', 'documentClientWidth', 'documentScrollWidth', 'overflowElements', 'overflowSamples', 'mediaOverflowElements', 'mediaOverflowSamples', 'focusVisible', 'reducedMotion', 'contrastRatios', 'visibleTextContrastFailures', 'visibleTextContrastSamples', 'visibleTextContrastIndeterminate', 'visibleTextContrastIndeterminateSamples', 'renderedFields'])) {
            return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Every browser result must use the exact result shape.', 400);
        }
        $invalid_fields = zeroy_runtime_browser_result_invalid_fields($result);
        if ($invalid_fields !== []) return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser result contains an invalid measurement.', 400, ['scenario' => $result['scenario'] ?? null, 'viewport' => $result['viewport'] ?? null, 'invalidFields' => $invalid_fields]);
    }
    return $input;
}

function zeroy_runtime_browser_failure(string $code, string $invariant, string $evidence, string $repair, ?string $scenario = null, ?string $viewport = null, ?string $document_path = null): array
{
    return [
        'code' => $code,
        'invariant' => $invariant,
        'scenario' => $scenario,
        'viewport' => $viewport,
        'evidence' => $evidence,
        'repair' => $repair,
        ...($document_path === null ? [] : ['documentPath' => $document_path]),
    ];
}

function zeroy_runtime_browser_stylesheet_mismatch_evidence(array $expected_urls, array $observed_urls, string $expected_identity, string $observed_identity): string
{
    $limit = 4;
    $truncate = static fn(string $value): string => strlen($value) <= 256 ? $value : substr($value, 0, 253) . '...';
    $first_difference = null;
    $length = max(count($expected_urls), count($observed_urls));
    for ($index = 0; $index < $length; $index++) {
        if (($expected_urls[$index] ?? null) !== ($observed_urls[$index] ?? null)) {
            $first_difference = $index;
            break;
        }
    }
    return (string) wp_json_encode([
        'expectedIdentity' => $truncate($expected_identity),
        'observedIdentity' => $truncate($observed_identity),
        'expectedCount' => count($expected_urls),
        'observedCount' => count($observed_urls),
        'firstDifferenceIndex' => $first_difference,
        'expectedUrls' => array_map($truncate, array_slice($expected_urls, 0, $limit)),
        'observedUrls' => array_map($truncate, array_slice($observed_urls, 0, $limit)),
        'urlListTruncated' => count($expected_urls) > $limit || count($observed_urls) > $limit,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function zeroy_runtime_verify_browser_evidence(array $challenge, array $evidence): array|WP_Error
{
    foreach (['challengeHash', 'releaseId', 'themeArtifactId', 'scenarioSetHash', 'stylesheetSetHash'] as $field) {
        if (!hash_equals((string) $challenge[$field], (string) $evidence[$field])) {
            return zeroy_runtime_error('zeroy_browser_evidence_stale', 'Browser evidence does not bind the current immutable candidate challenge.', 409, ['fieldId' => $field]);
        }
    }
    $expected_stylesheets = array_column($challenge['stylesheets'], 'url');
    $expected_scenarios = array_column($challenge['scenarios'], null, 'id');
    $expected_viewports = array_column($challenge['viewports'], null, 'id');
    $expected_pairs = array_column($challenge['contrastPairs'], null, 'id');
    $results = [];
    foreach ($evidence['results'] as $result) {
        $key = $result['scenario'] . ':' . $result['viewport'];
        if (isset($results[$key])) return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser evidence contains a duplicate scenario and viewport result.', 400, ['result' => $key]);
        if (!isset($expected_scenarios[$result['scenario']]) || !isset($expected_viewports[$result['viewport']])) {
            return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser evidence contains a result outside the declared challenge.', 400, ['result' => $key]);
        }
        if (array_diff(array_keys($result['contrastRatios']), array_keys($expected_pairs)) !== [] || array_diff(array_keys($expected_pairs), array_keys($result['contrastRatios'])) !== []) {
            return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser evidence contrast scope differs from the declared challenge.', 400, ['result' => $key]);
        }
        $results[$key] = $result;
    }
    $failures = [];
    $warnings = [];
    $stylesheet_mismatches = [];
    $focus_observed = false;
    foreach ($expected_scenarios as $scenario_id => $scenario) {
        foreach ($expected_viewports as $viewport_id => $_viewport) {
            $key = $scenario_id . ':' . $viewport_id;
            if (!isset($results[$key])) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_result_missing', 'Every declared candidate scenario must execute at every declared viewport.', 'Missing browser result ' . $key . '.', 'Run the complete browser challenge before finalizing the candidate.', $scenario_id, $viewport_id);
                continue;
            }
            $result = $results[$key];
            if ($result['status'] !== $scenario['expectedStatus'] || $result['routeKind'] !== $scenario['expectedRouteKind']) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_route_failed', 'Browser navigation must observe the declared HTTP and route identity.', 'Expected HTTP ' . $scenario['expectedStatus'] . ' and route ' . ($scenario['expectedRouteKind'] ?? '<none>') . '; observed HTTP ' . $result['status'] . ' and route ' . ($result['routeKind'] ?? '<none>') . '.', 'Repair the candidate route or template.', $scenario_id, $viewport_id);
            }
            $missing_fields = array_values(array_diff($scenario['requiredFields'] ?? [], $result['renderedFields']));
            if ($missing_fields !== []) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_content_field_missing', 'Every populated ACF field must own one visible semantic render region.', 'Missing data-zeroy-field markers: ' . implode(', ', $missing_fields) . '.', 'Render each populated field inside a visible element whose data-zeroy-field value is the stable field id from ThemeRenderContext.', $scenario_id, $viewport_id);
            }
            if ($result['stylesheetIdentity'] !== $challenge['stylesheetSetHash'] || $result['stylesheets'] !== $expected_stylesheets) {
                $mismatch_key = zeroy_runtime_hash([$result['stylesheetIdentity'], $result['stylesheets']]);
                if (!isset($stylesheet_mismatches[$mismatch_key])) {
                    $stylesheet_mismatches[$mismatch_key] = true;
                    $failures[] = zeroy_runtime_browser_failure(
                        'candidate_browser_stylesheet_identity_failed',
                        'Every browser scenario must load the exact ordered stylesheet set pinned by the candidate ThemeArtifact.',
                        zeroy_runtime_browser_stylesheet_mismatch_evidence($expected_stylesheets, $result['stylesheets'], (string) $challenge['stylesheetSetHash'], (string) $result['stylesheetIdentity']),
                        'Ensure every rendered Theme template calls wp_head() and wp_footer(), then remove stylesheet side paths so only the manifest-declared generated plus custom order remains.',
                        $scenario_id,
                        $viewport_id,
                    );
                }
            }
            if ($result['documentScrollWidth'] > $result['documentClientWidth'] || $result['overflowElements'] > 0) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_overflow', 'Executed viewports must not produce document-level horizontal overflow.', 'clientWidth=' . $result['documentClientWidth'] . ', scrollWidth=' . $result['documentScrollWidth'] . ', overflowingElements=' . $result['overflowElements'] . ', samples=' . implode(', ', $result['overflowSamples']) . '.', 'Repair the component or layout rule that exceeds the viewport.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            }
            if ($result['mediaOverflowElements'] > 0) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_media_overflow', 'Images, video, canvas, SVG, and iframe media must remain inside their layout boundary.', 'Overflowing media elements=' . $result['mediaOverflowElements'] . ', samples=' . implode(', ', $result['mediaOverflowSamples']) . '.', 'Constrain the reported media to its container.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            }
            if ($result['focusVisible'] === false) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_focus_visible_failed', 'A keyboard-focusable control must expose a visible focus indicator.', 'The focused control did not match :focus-visible with a visible outline.', 'Restore the ZCSS focus-visible rule or remove the overriding site rule.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            } elseif ($result['focusVisible'] === true) $focus_observed = true;
            if ($result['reducedMotion'] !== true) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_reduced_motion_failed', 'The reduced-motion media preference must suppress executed CSS animations and transitions.', 'At least one executed animation or transition exceeded the reduced-motion bound.', 'Remove the override that defeats the ZCSS reduced-motion rule.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            }
            foreach ($expected_pairs as $pair_id => $pair) {
                $ratio = (float) $result['contrastRatios'][$pair_id];
                if ($ratio + 0.0001 < (float) $pair['minimum']) {
                    $failures[] = zeroy_runtime_browser_failure('candidate_browser_contrast_failed', 'Declared ZCSS semantic foreground and background pairs must meet their contrast threshold in the executed browser.', $pair_id . ' contrast=' . $ratio . ', minimum=' . $pair['minimum'] . '.', 'Repair the site CSS override using the exact semantic token pair in .zeroy/contracts/zcss-authoring.json.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
                }
            }
            if ($result['visibleTextContrastFailures'] > 0) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_visible_text_contrast_failed', 'Every visible text region must meet its WCAG contrast threshold against the executed painted background.', 'Failing visible text regions=' . $result['visibleTextContrastFailures'] . ', samples=' . implode('; ', $result['visibleTextContrastSamples']) . '.', 'Repair the reported component so one visual color vocabulary owns both its foreground and painted background. Text over background images requires an opaque contrast-preserving surface.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            }
            if ($result['visibleTextContrastIndeterminate'] > 0) {
                $warnings[] = zeroy_runtime_browser_failure('candidate_browser_visible_text_contrast_indeterminate', 'Visible text over a non-solid painted background could not be deterministically measured from the CSS cascade.', 'Indeterminate visible text regions=' . $result['visibleTextContrastIndeterminate'] . ', samples=' . implode('; ', $result['visibleTextContrastIndeterminateSamples']) . '.', 'Use an opaque text surface or review this route with screenshot-based visual evidence before publication.', $scenario_id, $viewport_id, 'artifacts/theme/assets/css/site.css');
            }
        }
    }
    if (!$focus_observed) {
        $failures[] = zeroy_runtime_browser_failure('candidate_browser_focus_target_missing', 'Candidate browser verification must observe at least one keyboard focus target.', 'No executed scenario produced an observable keyboard focus target.', 'Provide a keyboard-accessible link, button, or form control in the scenario set.');
    }
    return [
        'kind' => 'browser-executed',
        'verifier' => $evidence['verifier'],
        'challengeHash' => $challenge['challengeHash'],
        'declared' => ['scenarios' => array_keys($expected_scenarios), 'viewports' => array_keys($expected_viewports)],
        'executed' => array_values($results),
        'failures' => $failures,
        'warnings' => $warnings,
    ];
}
