<?php

defined('ABSPATH') || exit;

/**
 * This is deliberately an output-contract smoke check, not a claimed browser
 * automation result. The Connector has no browser process owner. It catches
 * deterministic HTML violations; a future browser runner can append evidence
 * without changing SiteRelease identity or activation semantics.
 */
function zeroy_runtime_candidate_browser_smoke(array $checks, string $release_id): array
{
    $scenarios = [];
    $warnings = [];
    foreach ($checks as $check) {
        if ($check['status'] !== 200) {
            continue;
        }
        $scenario = ['id' => $check['scenario'], 'path' => $check['path'], 'query' => $check['query']];
        $response = wp_remote_get(zeroy_runtime_candidate_scenario_url($release_id, $scenario), ['timeout' => 20, 'redirection' => 0]);
        if (is_wp_error($response)) {
            $warnings[] = ['code' => 'browser_smoke_unavailable', 'scenario' => $check['scenario'], 'evidence' => $response->get_error_message()];
            continue;
        }
        $body = wp_remote_retrieve_body($response);
        $has_title = preg_match('/<title\b[^>]*>\s*[^<]/i', $body) === 1;
        $missing_alt = preg_match('/<img\b(?![^>]*\balt=)[^>]*>/i', $body) === 1;
        $unsafe_blank = preg_match('/<a\b(?=[^>]*\btarget=["\']_blank["\'])(?![^>]*\brel=["\'][^"\']*\bnoopener\b)/i', $body) === 1;
        $scenarios[] = ['scenario' => $check['scenario'], 'hasTitle' => $has_title, 'missingAlt' => $missing_alt, 'unsafeTargetBlank' => $unsafe_blank];
        if (!$has_title) $warnings[] = ['code' => 'browser_smoke_title_missing', 'scenario' => $check['scenario'], 'evidence' => 'Successful HTML response has no non-empty title.'];
        if ($missing_alt) $warnings[] = ['code' => 'browser_smoke_image_alt_missing', 'scenario' => $check['scenario'], 'evidence' => 'Successful HTML response contains an image without alt.'];
        if ($unsafe_blank) $warnings[] = ['code' => 'browser_smoke_target_blank_unsafe', 'scenario' => $check['scenario'], 'evidence' => 'target=_blank link has no noopener relation.'];
    }
    return ['kind' => 'html-output-smoke', 'scenarios' => $scenarios, 'warnings' => $warnings];
}
