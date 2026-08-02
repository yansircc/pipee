<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_RELEASE_CONTRACT = 'zeroy/site-release@1';
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
 * releases are the compiler output of one owner's SiteDraft, not history for
 * other authoring sessions to browse.
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
    $draft_id = (string) ($release['draft_id'] ?? '');
    $draft = $draft_id === '' ? null : zeroy_runtime_site_draft_row($draft_id);
    if ($draft === null) return zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404);
    $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
    return is_wp_error($owned)
        ? zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404)
        : true;
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
    if (!zeroy_runtime_site_draft_owner_valid($owner_id)) return zeroy_runtime_error('zeroy_artifact_missing', 'Artifact does not exist.', 404);
    $draft_ids = $wpdb->get_col(
        $wpdb->prepare(
            "SELECT draft_id FROM {$release_table} WHERE {$column} = %s AND state NOT IN ('active', 'superseded') AND draft_id IS NOT NULL",
            $artifact_id,
        ),
    );
    foreach (is_array($draft_ids) ? $draft_ids : [] as $draft_id) {
        $draft = is_string($draft_id) ? zeroy_runtime_site_draft_row($draft_id) : null;
        if ($draft !== null && !is_wp_error(zeroy_runtime_site_draft_owned_by($draft, $owner_id))) return true;
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
    $draft = !empty($release['draft_id']) ? zeroy_runtime_site_draft_row((string) $release['draft_id']) : null;
    $operations = is_array($draft) ? zeroy_runtime_site_draft_operations($draft) : [];
    $affected = is_array($operations) ? zeroy_runtime_site_draft_affected_projection($operations) : ['affectedSubjects' => [], 'affectedArtifacts' => []];
    $proof = is_array($diagnostics) && is_array($diagnostics['proof'] ?? null) ? $diagnostics['proof'] : null;
    $theme_proof = is_array($proof['themeProof'] ?? null) ? $proof['themeProof'] : [];
    $integration_scenarios = is_array($proof['integrationScenarios'] ?? null) ? $proof['integrationScenarios'] : [];
    $proof_diagnostics = $proof === null
        ? null
        : [
            'blockingFailures' => is_array($proof['blockingFailures'] ?? null) ? $proof['blockingFailures'] : [],
            'warnings' => is_array($theme_proof['warnings'] ?? null) ? $theme_proof['warnings'] : [],
            'declaredScenarioCount' => count(is_array($integration_scenarios['declared'] ?? null) ? $integration_scenarios['declared'] : []),
            'executedScenarioCount' => count(is_array($integration_scenarios['executed'] ?? null) ? $integration_scenarios['executed'] : []),
        ];
    $migration = is_array($diagnostics) && is_array($diagnostics['migration'] ?? null) ? $diagnostics['migration'] : null;
    $browser_verification = null;
    if ($release['state'] === 'awaiting-browser') {
        $snapshot = zeroy_runtime_site_release_snapshot($release);
        if (is_wp_error($snapshot)) return $snapshot;
        $browser_verification = zeroy_runtime_browser_verification_challenge($release, zeroy_runtime_snapshot_scenarios($snapshot));
        if (is_wp_error($browser_verification)) return $browser_verification;
    }
    return [
        'contract' => ZEROY_SITE_RELEASE_CONTRACT,
        'releaseId' => $release['release_id'],
        'draftId' => $release['draft_id'] ?: null,
        'themeArtifactId' => $release['theme_artifact_id'],
        'siteLogicArtifactId' => $release['site_logic_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'zcss' => is_array($theme_proof['zcss'] ?? null) ? $theme_proof['zcss'] : null,
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
        'snapshotHash' => (string) $release['snapshot_hash'],
        'expectedActiveReleaseId' => $release['expected_active_release_id'] ?: null,
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
        'affectedSubjects' => $affected['affectedSubjects'],
        'affectedArtifacts' => $affected['affectedArtifacts'],
        'createdAt' => $release['created_at'],
        'activatedAt' => $release['activated_at'],
        'previewUrl' => in_array($release['state'], ['preparing', 'awaiting-browser', 'prepared'], true)
            ? add_query_arg(['zeroy_candidate_release' => $release['release_id'], 'token' => hash_hmac('sha256', $release['release_id'], zeroy_runtime_connection_key())], home_url('/'))
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
    $scenario_hash = is_wp_error($snapshot) ? null : zeroy_runtime_hash(zeroy_runtime_snapshot_scenarios($snapshot));
    return ($proof['contract'] ?? null) === ZEROY_SITE_RELEASE_PROOF_CONTRACT
        && ($proof['releaseCandidateHash'] ?? null) === zeroy_runtime_site_release_candidate_hash($release)
        && (($proof['themeProof']['artifactId'] ?? null) === $release['theme_artifact_id'])
        && (($proof['themeProof']['snapshotHash'] ?? null) === $release['snapshot_hash'])
        && (($proof['themeProof']['themeContractHash'] ?? null) === $release['theme_contract_hash'])
        && (($proof['themeProof']['siteLogicContractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['themeProof']['runtimeVersion'] ?? null) === ZEROY_RUNTIME_VERSION)
        && (($proof['themeProof']['verifierVersion'] ?? null) === ZEROY_SITE_RELEASE_VERIFIER_VERSION)
        && (($proof['themeProof']['scenarioSetHash'] ?? null) === $scenario_hash)
        && (($proof['themeProof']['browserChecks']['kind'] ?? null) === 'browser-executed')
        && (($proof['themeProof']['browserChecks']['failures'] ?? null) === [])
        && (($proof['siteLogicProof']['artifactId'] ?? null) === $release['site_logic_artifact_id'])
        && (($proof['siteLogicProof']['contractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['siteLogicProof']['storageEpoch'] ?? null) === (int) $release['storage_epoch'])
        && (($proof['blockingFailures'] ?? null) === []);
}

function zeroy_runtime_site_release_candidate_hash(array $release): string
{
    $draft_hash = null;
    if (!empty($release['draft_id'])) {
        $draft = zeroy_runtime_site_draft_row((string) $release['draft_id']);
        if (is_array($draft)) {
            $operations = zeroy_runtime_site_draft_operations($draft);
            $draft_hash = is_wp_error($operations) ? null : zeroy_runtime_hash($operations);
        }
    }
    return zeroy_runtime_hash([
        'draftId' => $release['draft_id'] ?: null,
        'draftOperationsHash' => $draft_hash,
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
    if (is_wp_error($snapshot) || ($snapshot['contract'] ?? null) !== ZEROY_DRAFT_SNAPSHOT_CONTRACT || !is_string($snapshot['snapshotHash'] ?? null)) return zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteRelease has no valid DraftSnapshot.', 409);
    $claimed = $snapshot['snapshotHash'];
    unset($snapshot['snapshotHash']);
    $actual = zeroy_runtime_hash($snapshot);
    $snapshot['snapshotHash'] = $claimed;
    return hash_equals((string) ($release['snapshot_hash'] ?? ''), $claimed) && hash_equals($claimed, $actual)
        ? $snapshot
        : zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteRelease DraftSnapshot hash does not match its content.', 409);
}
