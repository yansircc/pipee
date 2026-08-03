<?php

defined('ABSPATH') || exit;

/**
 * This is deliberately an output-contract smoke check, not a claimed browser
 * automation result. The Connector has no browser process owner. It catches
 * deterministic HTML violations; a future browser runner can append evidence
 * without changing SiteRelease identity or activation semantics.
 */
function zeroy_runtime_candidate_browser_smoke(array $checks, string $candidate_kind, string $candidate_id): array
{
    $scenarios = [];
    $warnings = [];
    $failures = [];
    foreach ($checks as $check) {
        if ($check['status'] !== 200) {
            continue;
        }
        $scenario = ['id' => $check['scenario'], 'path' => $check['path'], 'query' => $check['query']];
        $response = wp_remote_get(zeroy_runtime_candidate_scenario_url($candidate_kind, $candidate_id, $scenario), ['timeout' => 20, 'redirection' => 0]);
        if (is_wp_error($response)) {
            $warnings[] = ['code' => 'browser_smoke_unavailable', 'scenario' => $check['scenario'], 'evidence' => $response->get_error_message()];
            continue;
        }
        $body = wp_remote_retrieve_body($response);
        $has_title = preg_match('/<title\b[^>]*>\s*[^<]/i', $body) === 1;
        $missing_alt = preg_match('/<img\b(?![^>]*\balt=)[^>]*>/i', $body) === 1;
        $empty_image_source = preg_match('/<img\b[^>]*\bsrc\s*=\s*(["\'])\s*\1/i', $body) === 1;
        $unsafe_blank = preg_match('/<a\b(?=[^>]*\btarget=["\']_blank["\'])(?![^>]*\brel=["\'][^"\']*\bnoopener\b)/i', $body) === 1;
        $scenarios[] = ['scenario' => $check['scenario'], 'hasTitle' => $has_title, 'missingAlt' => $missing_alt, 'emptyImageSource' => $empty_image_source, 'unsafeTargetBlank' => $unsafe_blank];
        if (!$has_title) $warnings[] = ['code' => 'browser_smoke_title_missing', 'scenario' => $check['scenario'], 'evidence' => 'Successful HTML response has no non-empty title.'];
        if ($missing_alt) $warnings[] = ['code' => 'browser_smoke_image_alt_missing', 'scenario' => $check['scenario'], 'evidence' => 'Successful HTML response contains an image without alt.'];
        if ($empty_image_source) $failures[] = zeroy_runtime_candidate_failure('candidate_empty_image_source', 'A released page must not emit an image element without a usable source.', ['id' => $check['scenario']], 'Candidate HTML contains an <img> with an empty src attribute.', 'Omit optional media with no source, or provide a valid source before preparing the release.');
        if ($unsafe_blank) $warnings[] = ['code' => 'browser_smoke_target_blank_unsafe', 'scenario' => $check['scenario'], 'evidence' => 'target=_blank link has no noopener relation.'];
    }
    return ['kind' => 'html-output-smoke', 'scenarios' => $scenarios, 'failures' => $failures, 'warnings' => $warnings];
}
