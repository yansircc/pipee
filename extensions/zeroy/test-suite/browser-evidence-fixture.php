<?php

defined('ABSPATH') || exit;

/**
 * Server-side acceptance tests exercise evidence decoding, binding, and
 * activation. The real Chromium execution path is covered separately by the
 * Pi-owned browser acceptance; this fixture must never enter production code.
 */
function zeroy_acceptance_synthetic_browser_evidence(array $challenge): array
{
    $stylesheets = array_column($challenge['stylesheets'], 'url');
    $ratios = [];
    foreach ($challenge['contrastPairs'] as $pair) $ratios[$pair['id']] = (float) $pair['minimum'] + 1;
    $results = [];
    foreach ($challenge['scenarios'] as $scenario) {
        foreach ($challenge['viewports'] as $viewport) {
            $results[] = [
                'scenario' => $scenario['id'],
                'viewport' => $viewport['id'],
                'status' => $scenario['expectedStatus'],
                'routeKind' => $scenario['expectedRouteKind'],
                'stylesheetIdentity' => $challenge['stylesheetSetHash'],
                'stylesheets' => $stylesheets,
                'documentClientWidth' => $viewport['width'],
                'documentScrollWidth' => $viewport['width'],
                'overflowElements' => 0,
                'overflowSamples' => [],
                'mediaOverflowElements' => 0,
                'mediaOverflowSamples' => [],
                'focusVisible' => true,
                'reducedMotion' => true,
                'contrastRatios' => $ratios,
            ];
        }
    }
    return [
        'contract' => ZEROY_BROWSER_EVIDENCE_CONTRACT,
        'challengeHash' => $challenge['challengeHash'],
        'releaseId' => $challenge['releaseId'],
        'themeArtifactId' => $challenge['themeArtifactId'],
        'scenarioSetHash' => $challenge['scenarioSetHash'],
        'stylesheetSetHash' => $challenge['stylesheetSetHash'],
        'verifier' => ['id' => ZEROY_BROWSER_VERIFIER_ID, 'version' => '1', 'engine' => 'acceptance-fixture', 'engineVersion' => '1'],
        'results' => $results,
    ];
}

function zeroy_acceptance_attach_browser_evidence(array $receipt, string $owner_id): array|WP_Error
{
    $challenge = $receipt['browserVerification'] ?? null;
    if (!is_array($challenge)) return zeroy_runtime_error('zeroy_acceptance_browser_challenge_missing', 'Acceptance candidate has no browser challenge.', 500);
    return zeroy_runtime_finalize_site_release_browser_evidence(
        (string) $receipt['releaseId'],
        zeroy_acceptance_synthetic_browser_evidence($challenge),
        $owner_id,
    );
}

function zeroy_acceptance_commit_site_draft(string $draft_id, ?string $expected_base_release_id, string $message, string $owner_id): array|WP_Error
{
    $prepared = zeroy_runtime_prepare_site_draft_commit($draft_id, $expected_base_release_id, $message, $owner_id);
    if (is_wp_error($prepared) || ($prepared['state'] ?? null) !== 'awaiting-browser') return $prepared;
    $verified = zeroy_acceptance_attach_browser_evidence($prepared, $owner_id);
    if (is_wp_error($verified) || ($verified['state'] ?? null) !== 'prepared') return $verified;
    return zeroy_runtime_activate_site_release((string) $verified['releaseId']);
}
