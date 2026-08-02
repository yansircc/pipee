<?php

defined('ABSPATH') || exit;

function zeroy_runtime_verify_candidate_site_release(array $release, array $compiled): array|WP_Error
{
    $static = zeroy_runtime_verify_static_boundaries((string) $release['theme_artifact_id'], (string) $release['site_logic_artifact_id']);
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    $declared_scenarios = is_wp_error($snapshot) ? [] : zeroy_runtime_snapshot_scenarios($snapshot);
    $runtime = ['checks' => [], 'failures' => []];
    $content = ['checks' => [], 'failures' => []];
    $retired_subject_keys = [];
    if (!empty($release['draft_id'])) {
        $candidate_draft = zeroy_runtime_site_draft_row((string) $release['draft_id']);
        $candidate_operations = is_array($candidate_draft) ? zeroy_runtime_site_draft_operations($candidate_draft) : [];
        if (is_array($candidate_operations)) {
            foreach ($candidate_operations as $operation) {
                if (($operation['kind'] ?? null) === 'retireCanonical' && is_int($operation['payload']['objectId'] ?? null)) {
                    $retired_subject_keys['post:' . $operation['payload']['objectId']] = true;
                }
            }
        }
    }
    $reconciliation = zeroy_localization_plan_overlay_reconciliation($compiled['schema'], $retired_subject_keys);
    $reconciliation_failures = array_map(
        static fn(array $failure): array => [
            'code' => (string) ($failure['code'] ?? 'candidate_reconciliation_blocked'),
            'invariant' => 'Every active LocaleOverlay head must be representable by the candidate ThemeSchema before activation.',
            'subjectKey' => $failure['subjectKey'] ?? null,
            'locale' => $failure['locale'] ?? null,
            'evidence' => (string) ($failure['message'] ?? 'Candidate reconciliation is blocked.'),
            'repair' => 'Retain the subject definition or explicitly retire the subject in the SiteDraft, then prepare a new release.',
        ],
        $reconciliation['blockingHeads']
    );
    $html = ['kind' => 'not-run', 'scenarios' => [], 'failures' => [], 'warnings' => []];
    $browser = ['kind' => 'awaiting-browser-witness', 'declared' => ['scenarios' => [], 'viewports' => array_column(zeroy_runtime_browser_viewports(), 'id')], 'executed' => [], 'failures' => [], 'warnings' => []];
    $draft_checks = ['draftId' => $release['draft_id'] ?? null, 'operationCount' => 0, 'operationsHash' => null, 'failures' => [], 'checks' => []];
    if (!empty($release['draft_id'])) {
        $draft = zeroy_runtime_site_draft_row((string) $release['draft_id']);
        if ($draft === null) {
            $draft_checks['failures'][] = ['code' => 'draft_missing', 'repair' => 'Inspect and recreate the SiteDraft.'];
        } else {
            $operations = zeroy_runtime_site_draft_operations($draft);
            if (is_wp_error($operations)) {
                $draft_checks['failures'][] = ['code' => 'draft_operations_invalid', 'repair' => 'Discard the corrupt draft and stage again.'];
            } else {
                $draft_checks['operationCount'] = count($operations);
                $draft_checks['operationsHash'] = zeroy_runtime_hash($operations);
                foreach ($operations as $operation) {
                    $valid = zeroy_runtime_validate_site_draft_operation($operation);
                    if (is_wp_error($valid)) $draft_checks['failures'][] = ['code' => $valid->get_error_code(), 'message' => $valid->get_error_message()];
                }
                $draft_checks['checks'][] = ['kind' => 'snapshot', 'state' => is_wp_error($snapshot) ? 'invalid' : 'compiled'];
            }
        }
    }
    if (is_wp_error($snapshot)) $draft_checks['failures'][] = ['code' => $snapshot->get_error_code(), 'message' => $snapshot->get_error_message()];
    if ($static['failures'] === []) {
        $content = is_wp_error($snapshot) ? $content : zeroy_runtime_snapshot_required_content_checks($snapshot, $compiled['schema']);
        $runtime = is_wp_error($snapshot) ? $runtime : zeroy_runtime_candidate_runtime_checks((string) $release['release_id'], $declared_scenarios);
        $html = zeroy_runtime_candidate_browser_smoke($runtime['checks'], (string) $release['release_id']);
        $browser['declared']['scenarios'] = array_column($declared_scenarios, 'id');
    }
    $failures = [...$draft_checks['failures'], ...$static['failures'], ...$reconciliation_failures, ...$content['failures'], ...$runtime['failures'], ...$html['failures']];
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
        'staticChecks' => $static['checks'],
        'contentChecks' => $content['checks'],
        'reconciliationChecks' => $reconciliation,
        'runtimeChecks' => ['declaredScenarios' => $declared_scenarios, 'executedScenarios' => $runtime['checks']],
        'htmlChecks' => $html,
        'browserChecks' => $browser,
        'draftChecks' => $draft_checks,
        'blockingFailures' => $failures,
        'warnings' => $html['warnings'],
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

function zeroy_runtime_verify_candidate_site_release_with_browser(array $release, array $compiled, array $evidence): array|WP_Error
{
    $proof = zeroy_runtime_verify_candidate_site_release($release, $compiled);
    if (is_wp_error($proof)) return $proof;
    if (($proof['blockingFailures'] ?? []) !== []) return $proof;
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
    $written = $wpdb->insert(zeroy_runtime_table('verification_proofs'), ['proof_id' => $proof_id, 'release_id' => $release_id, 'proof_json' => zeroy_runtime_json($proof), 'verified_at' => $proof['verifiedAt']], ['%s', '%s', '%s', '%s']);
    return $written === 1 ? $proof_id : zeroy_runtime_error('zeroy_proof_store_failed', $wpdb->last_error ?: 'Could not store VerificationProof.', 500);
}
