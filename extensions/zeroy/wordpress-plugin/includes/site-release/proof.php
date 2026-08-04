<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_release_proof_failure_key(array $failure): string
{
    return zeroy_runtime_hash([
        'code' => $failure['code'] ?? null,
        'subjectKey' => $failure['subjectKey'] ?? null,
        'locale' => $failure['locale'] ?? null,
        'fieldId' => $failure['fieldId'] ?? null,
        'repair' => $failure['repair'] ?? null,
    ]);
}

function zeroy_runtime_site_release_proof_failures(array $proof): array
{
    $failures = array_values(array_filter(
        is_array($proof['blockingFailures'] ?? null) ? $proof['blockingFailures'] : [],
        static fn(mixed $failure): bool => is_array($failure),
    ));
    usort($failures, static fn(array $left, array $right): int => strcmp(
        zeroy_runtime_site_release_proof_failure_key($left),
        zeroy_runtime_site_release_proof_failure_key($right),
    ));
    return $failures;
}

function zeroy_runtime_site_release_proof_projection(
    string $proof_id,
    string $release_id,
    array $proof,
    string $view,
    int $limit,
    ?string $cursor,
): array|WP_Error {
    if (!in_array($view, ['summary', 'repairGroups', 'failureInstances'], true)) {
        return zeroy_runtime_error('zeroy_proof_view_invalid', 'Proof view is not supported. Use repairGroups for normal repair work; failureInstances is low-level verifier evidence.', 400, ['allowed' => ['summary', 'repairGroups', 'failureInstances']]);
    }
    $failures = zeroy_runtime_site_release_proof_failures($proof);
    $base = [
        'proofId' => $proof_id,
        'releaseId' => $release_id,
        'verifiedAt' => $proof['verifiedAt'] ?? null,
        'failureCount' => count($failures),
    ];
    if ($view === 'summary') {
        return zeroy_checkout_bounded_projection([
            'contract' => 'zeroy/site-release-proof-summary@1',
            ...$base,
            'state' => $failures === [] ? 'verified' : 'blocked',
            'themeArtifactId' => $proof['themeProof']['artifactId'] ?? null,
            'siteLogicArtifactId' => $proof['siteLogicProof']['artifactId'] ?? null,
            'scenarioSetHash' => $proof['themeProof']['scenarioSetHash'] ?? null,
        ]);
    }
    $limit = min(50, max(1, $limit));
    if ($view === 'repairGroups') {
        $groups = [];
        foreach ($failures as $failure) {
            $key = zeroy_runtime_hash(['code' => $failure['code'] ?? null, 'repair' => $failure['repair'] ?? null]);
            if (!isset($groups[$key])) {
                $groups[$key] = [
                    'repairGroupId' => $key,
                    'code' => $failure['code'] ?? 'unknown',
                    'repair' => $failure['repair'] ?? null,
                    'instanceCount' => 0,
                    'examples' => [],
                ];
            }
            $groups[$key]['instanceCount']++;
            if (count($groups[$key]['examples']) < 3) {
                $example = array_filter([
                    'documentPath' => $failure['documentPath'] ?? null,
                    'contentPath' => $failure['contentPath'] ?? null,
                    'subjectKey' => $failure['subjectKey'] ?? null,
                    'locale' => $failure['locale'] ?? null,
                    'evidence' => $failure['evidence'] ?? null,
                ], static fn(mixed $value): bool => $value !== null && $value !== '');
                $example_key = zeroy_runtime_hash($example);
                $existing_keys = array_map(static fn(array $item): string => zeroy_runtime_hash($item), $groups[$key]['examples']);
                if (!in_array($example_key, $existing_keys, true)) $groups[$key]['examples'][] = $example;
            }
        }
        ksort($groups, SORT_STRING);
        $items = array_values($groups);
        $base['repairGroupCount'] = count($items);
        $contract = 'zeroy/site-release-proof-repair-groups@2';
    } else {
        $items = $failures;
        $contract = 'zeroy/site-release-proof-failure-instances@1';
    }
    return zeroy_checkout_page($items, $limit, $cursor, [
        'contract' => $contract,
        ...$base,
    ]);
}

function zeroy_runtime_verify_site_release_foundation(array $release, array $compiled): array
{
    $static = zeroy_runtime_verify_static_boundaries((string) $release['theme_artifact_id'], (string) $release['site_logic_artifact_id']);
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    $declared_scenarios = is_wp_error($snapshot) ? [] : zeroy_runtime_snapshot_scenarios($snapshot);
    $content = ['checks' => [], 'failures' => []];
    $retired_subject_keys = [];
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    $candidate_operations = is_array($snapshot) && is_array($snapshot['materializationPlan'] ?? null) ? $snapshot['materializationPlan'] : [];
    foreach ($candidate_operations as $operation) {
        if (($operation['kind'] ?? null) === 'retireCanonical' && is_int($operation['payload']['objectId'] ?? null)) $retired_subject_keys['post:' . $operation['payload']['objectId']] = true;
    }
    $reconciliation = zeroy_localization_plan_overlay_reconciliation($compiled['schema'], $retired_subject_keys);
    $reconciliation_failures = array_map(
        static fn(array $failure): array => [
            'code' => (string) ($failure['code'] ?? 'candidate_reconciliation_blocked'),
            'invariant' => 'Every active LocaleOverlay head must be representable by the candidate ThemeSchema before activation.',
            'subjectKey' => $failure['subjectKey'] ?? null,
            'locale' => $failure['locale'] ?? null,
            'evidence' => (string) ($failure['message'] ?? 'Candidate reconciliation is blocked.'),
            'repair' => 'Retain the subject definition or explicitly retire the subject in the SiteCheckout, then prepare a new release.',
        ],
        $reconciliation['blockingHeads']
    );
    $commit_checks = ['commit' => $release['commit_hash'] ?? null, 'operationCount' => count($candidate_operations), 'operationsHash' => is_array($snapshot) ? ($snapshot['operationsHash'] ?? null) : null, 'failures' => [], 'checks' => []];
    $commit = zeroy_checkout_commit_row((string) ($release['commit_hash'] ?? ''));
    if ($commit === null) $commit_checks['failures'][] = ['code' => 'site_commit_missing', 'repair' => 'Push the immutable SiteCommit again.'];
    if (is_wp_error($snapshot)) $commit_checks['failures'][] = ['code' => $snapshot->get_error_code(), 'message' => $snapshot->get_error_message()];
    else $commit_checks['checks'][] = ['kind' => 'snapshot', 'state' => 'compiled'];
    if ($static['failures'] === []) {
        $content = is_wp_error($snapshot) ? $content : zeroy_runtime_snapshot_required_content_checks($snapshot, $compiled['schema']);
    }
    return [
        'snapshot' => $snapshot,
        'declaredScenarios' => $declared_scenarios,
        'static' => $static,
        'content' => $content,
        'reconciliation' => $reconciliation,
        'commitChecks' => $commit_checks,
        'failures' => [...$commit_checks['failures'], ...$static['failures'], ...$reconciliation_failures, ...$content['failures']],
    ];
}

function zeroy_runtime_build_site_release_proof(array $release, array $foundation, array $runtime, array $html, array $browser): array
{
    $declared_scenarios = $foundation['declaredScenarios'];
    $failures = [...$foundation['failures'], ...$runtime['failures'], ...$html['failures'], ...$browser['failures']];
    $scenario_hash = zeroy_runtime_hash($declared_scenarios);
    $theme_proof = [
        'contract' => ZEROY_VERIFICATION_PROOF_CONTRACT,
        'artifactId' => $release['theme_artifact_id'],
        'snapshotHash' => $release['snapshot_hash'],
        'themeContractHash' => $release['theme_contract_hash'],
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'runtimeVersion' => ZEROY_RUNTIME_VERSION,
        'verifierVersion' => ZEROY_SITE_RELEASE_VERIFIER_VERSION,
        'scenarioSetHash' => $scenario_hash,
        'zcss' => (static function () use ($release): array {
            $surface = zeroy_zcss_style_surface_from_directory(zeroy_runtime_artifact_directory((string) $release['theme_artifact_id']));
            return is_wp_error($surface)
                ? ['state' => 'invalid', 'code' => $surface->get_error_code()]
                : [
                    'state' => 'verified',
                    'compiler' => $surface['compiler'],
                    'designHash' => $surface['designHash'],
                    'outputHash' => $surface['outputHash'],
                    'stylesheetSetHash' => $surface['stylesheetSetHash'],
                    'summary' => $surface['summary'],
                    'claims' => [
                        'generatedOutputMatches' => true,
                        'cssAstParsed' => true,
                        'reservedNamespaceClosed' => $surface['reservedNamespaceViolations'] === [],
                        'reservedReferencesResolved' => array_values(array_filter($surface['undefinedReferences'], static fn(string $name): bool => str_starts_with($name, '--z-'))) === [],
                    ],
                ];
        })(),
        'staticChecks' => $foundation['static']['checks'],
        'contentChecks' => $foundation['content']['checks'],
        'reconciliationChecks' => $foundation['reconciliation'],
        'runtimeChecks' => ['declaredScenarios' => $declared_scenarios, 'executedScenarios' => $runtime['checks']],
        'htmlChecks' => $html,
        'browserChecks' => $browser,
        'commitChecks' => $foundation['commitChecks'],
        'blockingFailures' => $failures,
        'warnings' => [...$html['warnings'], ...$browser['warnings']],
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
        'commit' => $release['commit_hash'] ?? null,
        'buildId' => $release['build_id'] ?? null,
        'releaseCandidateHash' => zeroy_runtime_site_release_candidate_hash($release),
        'themeProof' => $theme_proof,
        'siteLogicProof' => $logic_proof,
        'integrationScenarios' => ['declared' => $declared_scenarios, 'executed' => $runtime['checks']],
        'blockingFailures' => $failures,
        'verifiedAt' => current_time('mysql', true),
    ];
}

function zeroy_runtime_verify_candidate_site_release(
    array $release,
    array $compiled,
    string $candidate_kind = 'release',
    ?string $candidate_id = null,
): array|WP_Error
{
    $candidate_id ??= (string) $release['release_id'];
    $foundation = zeroy_runtime_verify_site_release_foundation($release, $compiled);
    $runtime = ['checks' => [], 'failures' => []];
    $html = ['kind' => 'not-run', 'scenarios' => [], 'failures' => [], 'warnings' => []];
    $browser = ['kind' => 'preview-awaiting-browser-witness', 'declared' => ['scenarios' => array_column($foundation['declaredScenarios'], 'id'), 'viewports' => array_column(zeroy_runtime_browser_viewports(), 'id')], 'executed' => [], 'failures' => [], 'warnings' => []];
    if ($foundation['static']['failures'] === [] && !is_wp_error($foundation['snapshot'])) {
        $runtime = zeroy_runtime_candidate_runtime_checks($candidate_kind, $candidate_id, $foundation['declaredScenarios']);
        $html = zeroy_runtime_candidate_browser_smoke($runtime['checks'], $candidate_kind, $candidate_id);
    }
    return zeroy_runtime_build_site_release_proof($release, $foundation, $runtime, $html, $browser);
}

function zeroy_runtime_attach_browser_evidence(array $release, array $proof, array $evidence): array|WP_Error
{
    $scenarios = $proof['integrationScenarios']['declared'] ?? [];
    $challenge = zeroy_runtime_browser_verification_challenge($release, is_array($scenarios) ? $scenarios : []);
    if (is_wp_error($challenge)) return $challenge;
    $browser = zeroy_runtime_verify_browser_evidence($challenge, $evidence);
    if (is_wp_error($browser)) return $browser;
    $proof['themeProof']['browserChecks'] = $browser;
    $proof['themeProof']['blockingFailures'] = [...$proof['themeProof']['blockingFailures'], ...$browser['failures']];
    $proof['themeProof']['warnings'] = [...$proof['themeProof']['warnings'], ...$browser['warnings']];
    $proof['blockingFailures'] = [...$proof['blockingFailures'], ...$browser['failures']];
    $proof['verifiedAt'] = current_time('mysql', true);
    $proof['themeProof']['verifiedAt'] = $proof['verifiedAt'];
    return $proof;
}

function zeroy_runtime_store_site_release_proof(string $release_id, array $proof): string|WP_Error
{
    $proof_id = 'proof-' . wp_generate_uuid4();
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_table('verification_proofs'), ['proof_id' => $proof_id, 'release_id' => $release_id, 'commit_hash' => $proof['commit'] ?? null, 'build_id' => $proof['buildId'] ?? null, 'proof_json' => zeroy_runtime_json($proof), 'verified_at' => $proof['verifiedAt']], ['%s', '%s', '%s', '%s', '%s', '%s']);
    return $written === 1 ? $proof_id : zeroy_runtime_error('zeroy_proof_store_failed', $wpdb->last_error ?: 'Could not store VerificationProof.', 500);
}
