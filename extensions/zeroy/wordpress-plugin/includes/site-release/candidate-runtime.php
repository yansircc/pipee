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

/**
 * PHP may render an error before WordPress can turn it into structured data.
 * The candidate response is untrusted diagnostic transport, not an API: retain
 * only the error kind, message, basename, and line so no host path or page body
 * crosses the Agent boundary.
 */
function zeroy_runtime_candidate_php_error(string $body): ?array
{
    if ($body === '') return null;
    $text = html_entity_decode($body, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/<br\\s*\\/?\s*>/i', "\n", $text) ?? $text;
    $text = wp_strip_all_tags($text, false);
    $lines = preg_split('/\\R/u', $text) ?: [];
    foreach ($lines as $line) {
        $line = trim((string) preg_replace('/[\\t ]+/', ' ', $line));
        if ($line === '') continue;
        $match = [];
        if (preg_match('/\\b(?<kind>fatal error|parse error|warning|deprecated)\\b\\s*:\\s*(?<message>.+?)\\s+in\\s+(?<file>.+?)\\s+on\\s+line\\s+(?<line>\\d+)\\.?$/i', $line, $match) !== 1) {
            if (preg_match('/\\b(?<kind>fatal error|parse error|warning|deprecated)\\b\\s*:\\s*(?<message>.+)$/i', $line, $match) !== 1) continue;
        }
        $kind = strtolower((string) $match['kind']);
        $message = trim((string) preg_replace('/\\s+/', ' ', (string) $match['message']));
        // Error messages can themselves contain an absolute path; redact it
        // before projecting evidence beyond the WordPress host.
        $message = (string) preg_replace('#(?<![A-Za-z0-9_.-])(?:[A-Za-z]:)?(?:/[^\\s<>()]+)+#', '<path>', $message);
        $message = substr($message, 0, 400);
        $file = isset($match['file']) ? basename(str_replace('\\\\', '/', trim((string) $match['file']))) : null;
        $line_number = isset($match['line']) ? (int) $match['line'] : null;
        $location = $file !== null && $file !== '' && $line_number !== null && $line_number > 0
            ? ' at ' . $file . ':' . $line_number
            : '';
        return array_filter([
            'kind' => $kind,
            'file' => $file,
            'line' => $line_number,
            'evidence' => 'PHP ' . $kind . ': ' . $message . $location . '.',
        ], static fn(mixed $value): bool => $value !== null && $value !== '');
    }
    return null;
}

function zeroy_runtime_candidate_runtime_checks(string $candidate_kind, string $candidate_id, array $scenarios): array
{
    $checks = [];
    $failures = [];
    foreach ($scenarios as $scenario) {
        $response = wp_remote_get(zeroy_runtime_candidate_scenario_url($candidate_kind, $candidate_id, $scenario), ['timeout' => 20, 'redirection' => 0]);
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
        $php_error = zeroy_runtime_candidate_php_error($body);
        if ($php_error !== null) {
            $failure = zeroy_runtime_candidate_failure('candidate_php_error_output', 'Candidate runtime must not emit PHP errors into a public response.', $scenario, (string) $php_error['evidence'], 'Repair the reported PHP runtime error and prepare a new release.');
            if (is_string($php_error['file'] ?? null)) $failure['file'] = $php_error['file'];
            if (is_int($php_error['line'] ?? null)) $failure['line'] = $php_error['line'];
            $failures[] = $failure;
        }
    }
    return ['checks' => $checks, 'failures' => $failures];
}
