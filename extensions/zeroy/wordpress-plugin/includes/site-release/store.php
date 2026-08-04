<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_RELEASE_CONTRACT = 'zeroy/site-release@3';
const ZEROY_VERIFICATION_PROOF_CONTRACT = 'zeroy/verification-proof@1';
const ZEROY_SITE_RELEASE_PROOF_CONTRACT = 'zeroy/site-release-proof@1';
const ZEROY_SITE_RELEASE_VERIFIER_VERSION = '6';

function zeroy_runtime_site_release_row(string $release_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_releases') . ' WHERE release_id = %s', $release_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

/**
 * A SiteRelease becomes a site-wide fact only after activation. Candidate
 * releases are the compiler output of one immutable SiteCommit.
 */
function zeroy_runtime_site_release_is_public(array $release): bool
{
    return in_array((string) ($release['state'] ?? ''), ['active', 'superseded'], true);
}

/**
 * Keep the release/proof read boundary aligned with the Draft that generated
 * it. A candidate with no owner-bound Draft is an internal runtime object and
 * is deliberately not exposed through the Connector.
 */
function zeroy_runtime_site_release_owned_candidate(array $release, string $owner_id): true|WP_Error
{
    if (zeroy_runtime_site_release_is_public($release)) return true;
    $commit = zeroy_checkout_commit_row((string) ($release['commit_hash'] ?? ''));
    return is_array($commit) && hash_equals((string) $commit['author_principal'], $owner_id)
        ? true
        : zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404);
}

/**
 * Artifact archives are candidate-dependent too: an artifact that is only
 * referenced by a non-public release has not become site history. The hash is
 * an identity, not an authorization capability.
 */
function zeroy_runtime_site_release_artifact_owned_candidate(string $kind, string $artifact_id, string $owner_id): true|WP_Error
{
    global $wpdb;
    $column = $kind === 'theme' ? 'theme_artifact_id' : 'site_logic_artifact_id';
    $release_table = zeroy_runtime_table('site_releases');
    $public = $wpdb->get_var(
        $wpdb->prepare(
            "SELECT COUNT(*) FROM {$release_table} WHERE {$column} = %s AND state IN ('active', 'superseded')",
            $artifact_id,
        ),
    );
    if ((int) $public > 0) return true;
    $commit_hashes = $wpdb->get_col(
        $wpdb->prepare(
            "SELECT commit_hash FROM {$release_table} WHERE {$column} = %s AND state NOT IN ('active', 'superseded') AND commit_hash IS NOT NULL",
            $artifact_id,
        ),
    );
    foreach (is_array($commit_hashes) ? $commit_hashes : [] as $commit_hash) {
        $commit = is_string($commit_hash) ? zeroy_checkout_commit_row($commit_hash) : null;
        if (is_array($commit) && hash_equals((string) $commit['author_principal'], $owner_id)) return true;
    }
    return zeroy_runtime_error('zeroy_artifact_missing', 'Artifact does not exist.', 404);
}

function zeroy_runtime_active_site_release(): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        'SELECT s.active_release_id, s.revision, s.activated_at, r.*, t.manifest_json AS theme_manifest_json, t.schema_json AS theme_schema_json, t.schema_hash AS theme_schema_hash, l.manifest_json AS site_logic_manifest_json, l.contract_json AS site_logic_contract_json
         FROM ' . zeroy_runtime_table('site_release_state') . ' s
         JOIN ' . zeroy_runtime_table('site_releases') . ' r ON r.release_id = s.active_release_id
         JOIN ' . zeroy_runtime_table('theme_artifacts') . ' t ON t.artifact_id = r.theme_artifact_id
         JOIN ' . zeroy_runtime_table('site_logic_artifacts') . ' l ON l.artifact_id = r.site_logic_artifact_id
         WHERE s.singleton = 1',
        ARRAY_A,
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_site_release_receipt(string $release_id): array|WP_Error
{
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404);
    $active = zeroy_runtime_active_site_release();
    $diagnostics = zeroy_runtime_decode_json((string) $release['diagnostics_json']);
    $provenance = zeroy_runtime_decode_json((string) $release['provenance_json']);
    $proof = is_array($diagnostics) && is_array($diagnostics['proof'] ?? null) ? $diagnostics['proof'] : null;
    $theme_proof = is_array($proof['themeProof'] ?? null) ? $proof['themeProof'] : [];
    $integration_scenarios = is_array($proof['integrationScenarios'] ?? null) ? $proof['integrationScenarios'] : [];
    $proof_diagnostics = $proof === null
        ? null
        : [
            'failureCount' => count(is_array($proof['blockingFailures'] ?? null) ? $proof['blockingFailures'] : []),
            'blockingFailures' => array_slice(is_array($proof['blockingFailures'] ?? null) ? $proof['blockingFailures'] : [], 0, 20),
            'warningCount' => count(is_array($theme_proof['warnings'] ?? null) ? $theme_proof['warnings'] : []),
            'warnings' => array_slice(is_array($theme_proof['warnings'] ?? null) ? $theme_proof['warnings'] : [], 0, 20),
            'declaredScenarioCount' => count(is_array($integration_scenarios['declared'] ?? null) ? $integration_scenarios['declared'] : []),
            'executedScenarioCount' => count(is_array($integration_scenarios['executed'] ?? null) ? $integration_scenarios['executed'] : []),
        ];
    $migration = is_array($diagnostics) && is_array($diagnostics['migration'] ?? null) ? $diagnostics['migration'] : null;
    $browser_verification = null;
    if ($release['state'] === 'preview-awaiting-browser') {
        $snapshot = zeroy_runtime_site_release_snapshot($release);
        if (is_wp_error($snapshot)) return $snapshot;
        $browser_verification = zeroy_runtime_browser_verification_challenge($release, zeroy_runtime_snapshot_scenarios($snapshot));
        if (is_wp_error($browser_verification)) return $browser_verification;
    }
    return [
        'contract' => ZEROY_SITE_RELEASE_CONTRACT,
        'releaseId' => $release['release_id'],
        'commit' => $release['commit_hash'] ?: null,
        'buildId' => $release['build_id'] ?: null,
        'previousReleaseId' => $release['previous_release_id'] ?: null,
        'themeArtifactId' => $release['theme_artifact_id'],
        'siteLogicArtifactId' => $release['site_logic_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'zcss' => is_array($theme_proof['zcss'] ?? null) ? $theme_proof['zcss'] : null,
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
        'snapshotHash' => (string) $release['snapshot_hash'],
        'expectedActiveReleaseId' => $release['expected_active_release_id'] ?: null,
        'reviewBriefHash' => $release['review_brief_hash'] ?: null,
        'state' => $release['state'],
        'proofId' => $release['proof_id'] ?: null,
        'activeReleaseId' => $active['active_release_id'] ?? null,
        'provenance' => is_wp_error($provenance) ? null : $provenance,
        // The persisted diagnostics own the full candidate contract and proof.
        // A release receipt is deliberately compact; inspect proof for the
        // complete evidence instead of echoing a ThemeSchema and every check
        // after every successful commit.
        'diagnostics' => is_wp_error($diagnostics)
            ? ['contract' => 'zeroy/site-release-diagnostics@1', 'corrupt' => true]
            : [
                'contract' => 'zeroy/site-release-diagnostics@1',
                'migration' => $migration,
                'proof' => $proof_diagnostics,
            ],
        'browserVerification' => $browser_verification,
        'createdAt' => $release['created_at'],
        'activatedAt' => $release['activated_at'],
        'previewUrl' => in_array($release['state'], ['preview-awaiting-browser', 'preview', 'proof-ready'], true)
            ? zeroy_runtime_admin_preview_url((string) $release['release_id'])
            : null,
    ];
}

function zeroy_runtime_acquire_site_release_lease(): true|WP_Error
{
    return zeroy_runtime_acquire_lease('site-release', 'zeroy_site_release_lease_unavailable', 'SiteRelease');
}

function zeroy_runtime_site_release_proof_row(string $proof_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('verification_proofs') . ' WHERE proof_id = %s', $proof_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_runtime_site_release_proof_valid(array $release, array $proof): bool
{
    $diagnostics = zeroy_runtime_decode_json((string) $release['diagnostics_json']);
    $theme_contract = is_array($diagnostics) ? ($diagnostics['themeContract'] ?? null) : null;
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    $scenarios = is_wp_error($snapshot) ? null : zeroy_runtime_snapshot_scenarios($snapshot);
    $scenario_hash = is_array($scenarios) ? zeroy_runtime_hash($scenarios) : null;
    $challenge = is_array($scenarios) ? zeroy_runtime_browser_verification_challenge($release, $scenarios) : null;
    return ($proof['contract'] ?? null) === ZEROY_SITE_RELEASE_PROOF_CONTRACT
        && (($proof['commit'] ?? null) === ($release['commit_hash'] ?? null))
        && (($proof['buildId'] ?? null) === ($release['build_id'] ?? null))
        && ($proof['releaseCandidateHash'] ?? null) === zeroy_runtime_site_release_candidate_hash($release)
        && (($proof['themeProof']['artifactId'] ?? null) === $release['theme_artifact_id'])
        && (($proof['themeProof']['snapshotHash'] ?? null) === $release['snapshot_hash'])
        && (($proof['themeProof']['themeContractHash'] ?? null) === $release['theme_contract_hash'])
        && (($proof['themeProof']['siteLogicContractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['themeProof']['runtimeVersion'] ?? null) === ZEROY_RUNTIME_VERSION)
        && (($proof['themeProof']['verifierVersion'] ?? null) === ZEROY_SITE_RELEASE_VERIFIER_VERSION)
        && (($proof['themeProof']['scenarioSetHash'] ?? null) === $scenario_hash)
        && (($proof['themeProof']['browserChecks']['kind'] ?? null) === 'browser-executed')
        && is_array($challenge)
        && (($proof['themeProof']['browserChecks']['challengeHash'] ?? null) === ($challenge['challengeHash'] ?? null))
        && (($proof['themeProof']['browserChecks']['failures'] ?? null) === [])
        && (($proof['siteLogicProof']['artifactId'] ?? null) === $release['site_logic_artifact_id'])
        && (($proof['siteLogicProof']['contractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['siteLogicProof']['storageEpoch'] ?? null) === (int) $release['storage_epoch'])
        && (($proof['blockingFailures'] ?? null) === []);
}

function zeroy_runtime_site_release_candidate_hash(array $release): string
{
    return zeroy_runtime_hash([
        'commit' => $release['commit_hash'] ?: null,
        'buildId' => $release['build_id'] ?: null,
        'themeArtifactId' => $release['theme_artifact_id'],
        'siteLogicArtifactId' => $release['site_logic_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
        'snapshotHash' => (string) $release['snapshot_hash'],
    ]);
}

function zeroy_runtime_site_release_snapshot(array $release): array|WP_Error
{
    $snapshot = zeroy_runtime_decode_json((string) ($release['snapshot_json'] ?? ''));
    if (is_wp_error($snapshot) || ($snapshot['contract'] ?? null) !== ZEROY_SITE_SNAPSHOT_CONTRACT || !is_string($snapshot['snapshotHash'] ?? null)) return zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteRelease has no valid commit-derived SiteSnapshot.', 409);
    $claimed = $snapshot['snapshotHash'];
    unset($snapshot['snapshotHash']);
    $actual = zeroy_runtime_hash($snapshot);
    $snapshot['snapshotHash'] = $claimed;
    return hash_equals((string) ($release['snapshot_hash'] ?? ''), $claimed) && hash_equals($claimed, $actual)
        ? $snapshot
        : zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteRelease SiteSnapshot hash does not match its content.', 409);
}
