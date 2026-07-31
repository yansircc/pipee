<?php

defined('ABSPATH') || exit;

function zeroy_runtime_verify_candidate_site_release(array $release, array $compiled): array|WP_Error
{
    $static = zeroy_runtime_verify_static_boundaries((string) $release['theme_artifact_id'], (string) $release['site_logic_artifact_id']);
    $declared_scenarios = zeroy_runtime_site_release_scenario_set($compiled['contract']);
    $runtime = ['checks' => [], 'failures' => []];
    $browser = ['kind' => 'not-run', 'scenarios' => [], 'warnings' => []];
    if ($static['failures'] === []) {
        $executed_scenarios = zeroy_runtime_compile_candidate_scenarios($compiled['contract'], $compiled['schema']);
        $runtime = zeroy_runtime_candidate_runtime_checks((string) $release['release_id'], $executed_scenarios);
        $browser = zeroy_runtime_candidate_browser_smoke($runtime['checks'], (string) $release['release_id']);
    }
    $failures = [...$static['failures'], ...$runtime['failures']];
    $scenario_hash = zeroy_runtime_hash($declared_scenarios);
    $theme_proof = [
        'contract' => ZEROY_VERIFICATION_PROOF_CONTRACT,
        'artifactId' => $release['theme_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'runtimeVersion' => ZEROY_RUNTIME_VERSION,
        'verifierVersion' => ZEROY_SITE_RELEASE_VERIFIER_VERSION,
        'scenarioSetHash' => $scenario_hash,
        'staticChecks' => $static['checks'],
        'runtimeChecks' => ['declaredScenarios' => $declared_scenarios, 'executedScenarios' => $runtime['checks']],
        'browserChecks' => $browser,
        'blockingFailures' => $failures,
        'warnings' => $browser['warnings'],
        'verifiedAt' => current_time('mysql', true),
    ];
    $logic_proof = [
        'contract' => 'zeroy/site-logic-verification-proof@1',
        'artifactId' => $release['site_logic_artifact_id'],
        'contractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
        'blockingFailures' => [],
    ];
    return [
        'contract' => ZEROY_SITE_RELEASE_PROOF_CONTRACT,
        'releaseCandidateHash' => zeroy_runtime_site_release_candidate_hash($release),
        'themeProof' => $theme_proof,
        'siteLogicProof' => $logic_proof,
        'integrationScenarios' => ['declared' => $declared_scenarios, 'executed' => $runtime['checks']],
        'blockingFailures' => $failures,
        'verifiedAt' => current_time('mysql', true),
    ];
}

function zeroy_runtime_store_site_release_proof(string $release_id, array $proof): string|WP_Error
{
    $proof_id = 'proof-' . wp_generate_uuid4();
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_table('verification_proofs'), ['proof_id' => $proof_id, 'release_id' => $release_id, 'proof_json' => zeroy_runtime_json($proof), 'verified_at' => $proof['verifiedAt']], ['%s', '%s', '%s', '%s']);
    return $written === 1 ? $proof_id : zeroy_runtime_error('zeroy_proof_store_failed', $wpdb->last_error ?: 'Could not store VerificationProof.', 500);
}
