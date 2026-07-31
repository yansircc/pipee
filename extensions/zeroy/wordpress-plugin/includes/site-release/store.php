<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_RELEASE_CONTRACT = 'zeroy/site-release@1';
const ZEROY_VERIFICATION_PROOF_CONTRACT = 'zeroy/verification-proof@1';
const ZEROY_SITE_RELEASE_PROOF_CONTRACT = 'zeroy/site-release-proof@1';
const ZEROY_SITE_RELEASE_VERIFIER_VERSION = '3';

function zeroy_runtime_site_release_row(string $release_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_releases') . ' WHERE release_id = %s', $release_id), ARRAY_A);
    return is_array($row) ? $row : null;
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
    return [
        'contract' => ZEROY_SITE_RELEASE_CONTRACT,
        'releaseId' => $release['release_id'],
        'themeArtifactId' => $release['theme_artifact_id'],
        'siteLogicArtifactId' => $release['site_logic_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
        'expectedActiveReleaseId' => $release['expected_active_release_id'] ?: null,
        'state' => $release['state'],
        'proofId' => $release['proof_id'] ?: null,
        'activeReleaseId' => $active['active_release_id'] ?? null,
        'provenance' => is_wp_error($provenance) ? null : $provenance,
        'diagnostics' => is_wp_error($diagnostics) ? ['corrupt' => true] : $diagnostics,
        'createdAt' => $release['created_at'],
        'activatedAt' => $release['activated_at'],
        'previewUrl' => in_array($release['state'], ['preparing', 'prepared'], true)
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
    $scenario_hash = is_array($theme_contract)
        ? zeroy_runtime_hash(zeroy_runtime_site_release_scenario_set($theme_contract))
        : null;
    return ($proof['contract'] ?? null) === ZEROY_SITE_RELEASE_PROOF_CONTRACT
        && ($proof['releaseCandidateHash'] ?? null) === zeroy_runtime_site_release_candidate_hash($release)
        && (($proof['themeProof']['artifactId'] ?? null) === $release['theme_artifact_id'])
        && (($proof['themeProof']['themeContractHash'] ?? null) === $release['theme_contract_hash'])
        && (($proof['themeProof']['siteLogicContractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['themeProof']['runtimeVersion'] ?? null) === ZEROY_RUNTIME_VERSION)
        && (($proof['themeProof']['verifierVersion'] ?? null) === ZEROY_SITE_RELEASE_VERIFIER_VERSION)
        && (($proof['themeProof']['scenarioSetHash'] ?? null) === $scenario_hash)
        && (($proof['siteLogicProof']['artifactId'] ?? null) === $release['site_logic_artifact_id'])
        && (($proof['siteLogicProof']['contractHash'] ?? null) === $release['site_logic_contract_hash'])
        && (($proof['siteLogicProof']['storageEpoch'] ?? null) === (int) $release['storage_epoch'])
        && (($proof['blockingFailures'] ?? null) === []);
}

function zeroy_runtime_site_release_candidate_hash(array $release): string
{
    return zeroy_runtime_hash([
        'themeArtifactId' => $release['theme_artifact_id'],
        'siteLogicArtifactId' => $release['site_logic_artifact_id'],
        'themeContractHash' => $release['theme_contract_hash'],
        'siteLogicContractHash' => $release['site_logic_contract_hash'],
        'storageEpoch' => (int) $release['storage_epoch'],
    ]);
}
