<?php

defined('ABSPATH') || exit;

const ZEROY_BROWSER_VERIFICATION_CHALLENGE_CONTRACT = 'zeroy/browser-verification-challenge@1';
const ZEROY_BROWSER_EVIDENCE_CONTRACT = 'zeroy/browser-evidence@1';
const ZEROY_BROWSER_VERIFIER_ID = 'zeroy/pi-browser-verifier@1';

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
    return [
        ['id' => 'surface', 'foreground' => '--z-color-on-surface', 'background' => '--z-color-surface', 'minimum' => 4.5],
        ['id' => 'action', 'foreground' => '--z-color-on-action', 'background' => '--z-color-action', 'minimum' => 4.5],
        ['id' => 'success', 'foreground' => '--z-color-on-status-success', 'background' => '--z-color-status-success', 'minimum' => 4.5],
        ['id' => 'warning', 'foreground' => '--z-color-on-status-warning', 'background' => '--z-color-status-warning', 'minimum' => 4.5],
        ['id' => 'danger', 'foreground' => '--z-color-on-status-danger', 'background' => '--z-color-status-danger', 'minimum' => 4.5],
    ];
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
    $base = content_url('zeroy-runtime/artifacts/' . rawurlencode(str_replace(':', '-', (string) $release['theme_artifact_id'])));
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
                'url' => zeroy_runtime_candidate_scenario_url((string) $release['release_id'], $scenario),
                'expectedStatus' => (int) $scenario['expectedStatus'],
                'expectedRouteKind' => is_string($scenario['expectedRouteKind'] ?? null) ? $scenario['expectedRouteKind'] : null,
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
        if (!zeroy_runtime_is_keyed_map($result) || !zeroy_runtime_browser_evidence_exact_keys($result, ['scenario', 'viewport', 'status', 'routeKind', 'stylesheetIdentity', 'stylesheets', 'documentClientWidth', 'documentScrollWidth', 'overflowElements', 'overflowSamples', 'mediaOverflowElements', 'mediaOverflowSamples', 'focusVisible', 'reducedMotion', 'contrastRatios'])) {
            return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Every browser result must use the exact result shape.', 400);
        }
        if (
            !is_string($result['scenario']) || $result['scenario'] === ''
            || !is_string($result['viewport']) || $result['viewport'] === ''
            || !is_int($result['status']) || $result['status'] < 100 || $result['status'] > 599
            || (!is_string($result['routeKind']) && $result['routeKind'] !== null)
            || !is_string($result['stylesheetIdentity'])
            || !is_array($result['stylesheets']) || !array_is_list($result['stylesheets']) || array_filter($result['stylesheets'], static fn(mixed $value): bool => !is_string($value)) !== []
            || !is_int($result['documentClientWidth']) || $result['documentClientWidth'] < 1
            || !is_int($result['documentScrollWidth']) || $result['documentScrollWidth'] < 1
            || !is_int($result['overflowElements']) || $result['overflowElements'] < 0
            || !is_array($result['overflowSamples']) || !array_is_list($result['overflowSamples']) || count($result['overflowSamples']) > 5 || array_filter($result['overflowSamples'], static fn(mixed $value): bool => !is_string($value) || $value === '') !== []
            || !is_int($result['mediaOverflowElements']) || $result['mediaOverflowElements'] < 0
            || !is_array($result['mediaOverflowSamples']) || !array_is_list($result['mediaOverflowSamples']) || count($result['mediaOverflowSamples']) > 5 || array_filter($result['mediaOverflowSamples'], static fn(mixed $value): bool => !is_string($value) || $value === '') !== []
            || (!is_bool($result['focusVisible']) && $result['focusVisible'] !== null)
            || !is_bool($result['reducedMotion'])
            || !zeroy_runtime_is_keyed_map($result['contrastRatios'])
            || array_filter($result['contrastRatios'], static fn(mixed $value): bool => !is_int($value) && !is_float($value)) !== []
        ) return zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Browser result contains an invalid measurement.', 400, ['scenario' => $result['scenario'] ?? null, 'viewport' => $result['viewport'] ?? null]);
    }
    return $input;
}

function zeroy_runtime_browser_failure(string $code, string $invariant, string $evidence, string $repair, ?string $scenario = null, ?string $viewport = null): array
{
    return [
        'code' => $code,
        'invariant' => $invariant,
        'scenario' => $scenario,
        'viewport' => $viewport,
        'evidence' => $evidence,
        'repair' => $repair,
    ];
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
            if ($result['stylesheetIdentity'] !== $challenge['stylesheetSetHash'] || $result['stylesheets'] !== $expected_stylesheets) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_stylesheet_identity_failed', 'Every browser scenario must load the exact ordered stylesheet set pinned by the candidate ThemeArtifact.', 'Browser stylesheet identity or ordered URLs differ from the candidate challenge.', 'Remove stylesheet side paths and restore the manifest-declared generated plus custom order.', $scenario_id, $viewport_id);
            }
            if ($result['documentScrollWidth'] > $result['documentClientWidth'] || $result['overflowElements'] > 0) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_overflow', 'Executed viewports must not produce document-level horizontal overflow.', 'clientWidth=' . $result['documentClientWidth'] . ', scrollWidth=' . $result['documentScrollWidth'] . ', overflowingElements=' . $result['overflowElements'] . ', samples=' . implode(', ', $result['overflowSamples']) . '.', 'Repair the component or layout rule that exceeds the viewport.', $scenario_id, $viewport_id);
            }
            if ($result['mediaOverflowElements'] > 0) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_media_overflow', 'Images, video, canvas, SVG, and iframe media must remain inside their layout boundary.', 'Overflowing media elements=' . $result['mediaOverflowElements'] . ', samples=' . implode(', ', $result['mediaOverflowSamples']) . '.', 'Constrain the reported media to its container.', $scenario_id, $viewport_id);
            }
            if ($result['focusVisible'] === false) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_focus_visible_failed', 'A keyboard-focusable control must expose a visible focus indicator.', 'The focused control did not match :focus-visible with a visible outline.', 'Restore the ZCSS focus-visible rule or remove the overriding site rule.', $scenario_id, $viewport_id);
            } elseif ($result['focusVisible'] === true) $focus_observed = true;
            if ($result['reducedMotion'] !== true) {
                $failures[] = zeroy_runtime_browser_failure('candidate_browser_reduced_motion_failed', 'The reduced-motion media preference must suppress executed CSS animations and transitions.', 'At least one executed animation or transition exceeded the reduced-motion bound.', 'Remove the override that defeats the ZCSS reduced-motion rule.', $scenario_id, $viewport_id);
            }
            foreach ($expected_pairs as $pair_id => $pair) {
                $ratio = (float) $result['contrastRatios'][$pair_id];
                if ($ratio + 0.0001 < (float) $pair['minimum']) {
                    $failures[] = zeroy_runtime_browser_failure('candidate_browser_contrast_failed', 'Declared ZCSS semantic foreground and background pairs must meet their contrast threshold in the executed browser.', $pair_id . ' contrast=' . $ratio . ', minimum=' . $pair['minimum'] . '.', 'Repair the ZCSS palette or a site override of the semantic color pair.', $scenario_id, $viewport_id);
                }
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
        'warnings' => [],
    ];
}
