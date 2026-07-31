<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_release_request_json(WP_REST_Request $request): array|WP_Error
{
    $payload = json_decode((string) $request->get_body(), true);
    return zeroy_runtime_is_keyed_map($payload) ? $payload : zeroy_runtime_error('zeroy_site_release_request_invalid', 'SiteRelease request body must be a JSON object.', 400);
}

function zeroy_runtime_site_release_state_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    return new WP_REST_Response(['contract' => 'zeroy/site-release-state@1', 'state' => $active === null ? 'bootstrap-required' : 'active', 'activeReleaseId' => $active['active_release_id'] ?? null, 'themeArtifactId' => $active['theme_artifact_id'] ?? null, 'siteLogicArtifactId' => $active['site_logic_artifact_id'] ?? null, 'revision' => isset($active['revision']) ? (int) $active['revision'] : null, 'storageEpoch' => isset($active['storage_epoch']) ? (int) $active['storage_epoch'] : null, 'themePolicy' => zeroy_runtime_theme_policy(), 'siteLogicPolicy' => zeroy_runtime_site_logic_policy()]);
}

function zeroy_runtime_site_release_artifact_upload_endpoint(WP_REST_Request $request, string $kind): WP_REST_Response
{
    $payload = zeroy_runtime_site_release_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $archive = $payload['archiveBase64'] ?? null;
    $manifest = $payload['manifest'] ?? null;
    if (!is_array($manifest) || !is_string($archive)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_artifact_request_invalid', 'Artifact upload requires manifest and archiveBase64.', 400));
    if ($kind === 'theme') {
        $normalized = zeroy_runtime_normalize_manifest($manifest);
        if (is_wp_error($normalized)) return zeroy_runtime_response_error($normalized);
        $result = zeroy_runtime_materialize_artifact_archive($normalized, $archive);
    } else {
        $result = zeroy_runtime_site_logic_materialize_artifact_archive($manifest, $archive);
    }
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => $kind === 'theme' ? ZEROY_THEME_ARTIFACT_CONTRACT : ZEROY_SITE_LOGIC_ARTIFACT_CONTRACT, ...$result], 201);
}

function zeroy_runtime_site_release_prepare_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_site_release_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $theme = $payload['themeArtifactId'] ?? null;
    $logic = $payload['siteLogicArtifactId'] ?? null;
    $expected = $payload['expectedActiveReleaseId'] ?? null;
    $provenance = $payload['provenance'] ?? null;
    if (!is_string($theme) || !is_string($logic) || ($expected !== null && !is_string($expected)) || !zeroy_runtime_is_keyed_map($provenance)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_request_invalid', 'SiteRelease prepare requires two artifact identities, expected active release and provenance.', 400));
    $result = zeroy_runtime_prepare_site_release($theme, $logic, $expected, $provenance);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, ($result['state'] ?? null) === 'prepared' ? 201 : 409);
}

function zeroy_runtime_site_release_activate_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_activate_site_release((string) $request['releaseId']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_site_release_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_site_release_receipt((string) $request['releaseId']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_site_releases_endpoint(WP_REST_Request $request): WP_REST_Response
{
    global $wpdb;
    $limit = min(50, max(1, (int) $request->get_param('limit') ?: 20));
    $ids = $wpdb->get_col('SELECT release_id FROM ' . zeroy_runtime_table('site_releases') . ' ORDER BY created_at DESC LIMIT ' . $limit);
    $releases = [];
    foreach (is_array($ids) ? $ids : [] as $id) {
        $receipt = zeroy_runtime_site_release_receipt((string) $id);
        if (!is_wp_error($receipt)) $releases[] = $receipt;
    }
    return new WP_REST_Response(['contract' => 'zeroy/site-release-history@1', 'releases' => $releases]);
}

function zeroy_runtime_site_release_proof_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $proof = zeroy_runtime_site_release_proof_row((string) $request['proofId']);
    if ($proof === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    $decoded = zeroy_runtime_decode_json((string) $proof['proof_json']);
    return is_wp_error($decoded) ? zeroy_runtime_response_error($decoded) : new WP_REST_Response(['proofId' => $proof['proof_id'], 'releaseId' => $proof['release_id'], 'proof' => $decoded]);
}

function zeroy_runtime_site_logic_migration_history_endpoint(WP_REST_Request $request): WP_REST_Response
{
    return new WP_REST_Response(zeroy_runtime_site_logic_migration_history((int) $request->get_param('limit') ?: 50));
}

function zeroy_runtime_site_release_artifact_endpoint(WP_REST_Request $request, string $kind): WP_REST_Response
{
    $id = (string) $request['artifactId'];
    $row = $kind === 'theme' ? zeroy_runtime_artifact_row($id) : zeroy_runtime_site_logic_artifact_row($id);
    if ($row === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_artifact_missing', 'Artifact does not exist.', 404));
    $manifest = zeroy_runtime_decode_json((string) $row['manifest_json']);
    $artifact_contract = $kind === 'theme'
        ? zeroy_runtime_decode_json((string) ($row['schema_json'] ?? ''))
        : zeroy_runtime_decode_json((string) ($row['contract_json'] ?? ''));
    return new WP_REST_Response(['contract' => $kind === 'theme' ? ZEROY_THEME_ARTIFACT_CONTRACT : ZEROY_SITE_LOGIC_ARTIFACT_CONTRACT, 'artifactId' => $id, 'manifest' => is_wp_error($manifest) ? null : $manifest, 'artifactContract' => is_wp_error($artifact_contract) ? null : $artifact_contract, 'contractHash' => $row['contract_hash'] ?? null, 'storageEpoch' => isset($row['storage_epoch']) ? (int) $row['storage_epoch'] : null]);
}

function zeroy_runtime_site_release_artifact_archive_endpoint(WP_REST_Request $request, string $kind): WP_REST_Response
{
    $id = (string) $request['artifactId'];
    $archive = $kind === 'theme' ? zeroy_runtime_artifact_archive_base64($id) : zeroy_runtime_site_logic_artifact_archive_base64($id);
    return is_wp_error($archive) ? zeroy_runtime_response_error($archive) : new WP_REST_Response(['artifactId' => $id, 'archiveBase64' => $archive]);
}

function zeroy_runtime_register_site_release_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site-release/state', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_state_endpoint']);
    foreach (['theme', 'site-logic'] as $kind) {
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_runtime_site_release_artifact_upload_endpoint($request, $kind)]);
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_runtime_site_release_artifact_endpoint($request, $kind)]);
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})/archive', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_runtime_site_release_artifact_archive_endpoint($request, $kind)]);
    }
    register_rest_route('zeroy/v1', '/site-releases/prepare', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_release_prepare_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_releases_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases/(?P<releaseId>[a-f0-9-]{36})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases/(?P<releaseId>[a-f0-9-]{36})/activate', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_release_activate_endpoint']);
    register_rest_route('zeroy/v1', '/site-release-proofs/(?P<proofId>[a-z0-9-]{1,64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_proof_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/migrations', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_logic_migration_history_endpoint']);
}
add_action('rest_api_init', 'zeroy_runtime_register_site_release_routes');
