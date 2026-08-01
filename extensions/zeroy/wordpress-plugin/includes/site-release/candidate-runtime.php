<?php

defined('ABSPATH') || exit;

function zeroy_runtime_candidate_failure(string $code, string $invariant, array $scenario, string $evidence, string $repair): array
{
    return [
        'code' => $code,
        'invariant' => $invariant,
        'scenario' => $scenario['id'],
        'evidence' => $evidence,
        'repair' => $repair,
    ];
}

function zeroy_runtime_candidate_runtime_checks(string $release_id, array $scenarios): array
{
    $checks = [];
    $failures = [];
    foreach ($scenarios as $scenario) {
        $response = wp_remote_get(zeroy_runtime_candidate_scenario_url($release_id, $scenario), ['timeout' => 20, 'redirection' => 0]);
        if (is_wp_error($response)) {
            $failures[] = zeroy_runtime_candidate_failure('candidate_runtime_unavailable', 'A SiteRelease must render every selected real WordPress scenario before activation.', $scenario, $response->get_error_message(), 'Repair the candidate request failure and prepare a new release.');
            continue;
        }
        $status = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $robots = wp_remote_retrieve_header($response, 'x-robots-tag');
        $route_kind = wp_remote_retrieve_header($response, 'x-zeroy-route-kind');
        $checks[] = ['scenario' => $scenario['id'], 'kind' => $scenario['kind'], 'locale' => $scenario['locale'], 'path' => $scenario['path'], 'query' => $scenario['query'] ?? [], 'status' => $status, 'bytes' => strlen($body)];
        if ($status !== $scenario['expectedStatus'] || trim($body) === '' || (isset($scenario['expectedRouteKind']) && $route_kind !== $scenario['expectedRouteKind'])) {
            $evidence = 'Expected HTTP ' . $scenario['expectedStatus'] . ', received HTTP ' . $status . '.';
            if (isset($scenario['expectedRouteKind']) && $route_kind !== $scenario['expectedRouteKind']) {
                $evidence .= ' Expected routeKind ' . $scenario['expectedRouteKind'] . ', received ' . ($route_kind === '' ? '<missing>' : $route_kind) . '.';
            }
            $failures[] = zeroy_runtime_candidate_failure('candidate_runtime_failed', 'A candidate must produce the expected non-empty response for every executed scenario.', $scenario, $evidence, 'Repair the ThemeArtifact, SiteLogicArtifact, or route contract and prepare a new release.');
        }
        if (!is_string($robots) || !str_contains(strtolower($robots), 'noindex')) {
            $failures[] = zeroy_runtime_candidate_failure('candidate_cache_boundary_missing', 'Candidate requests must never be indexable or publicly cacheable.', $scenario, 'X-Robots-Tag did not contain noindex.', 'Restore the Connector candidate request boundary.');
        }
        if (preg_match('/(?:fatal error|parse error|\bwarning\b|\bdeprecated\b)/i', $body) === 1) {
            $failures[] = zeroy_runtime_candidate_failure('candidate_php_error_output', 'Candidate runtime must not emit PHP errors into a public response.', $scenario, 'Candidate HTML contained a PHP error marker.', 'Repair the reported PHP runtime error and prepare a new release.');
        }
    }
    return ['checks' => $checks, 'failures' => $failures];
}
