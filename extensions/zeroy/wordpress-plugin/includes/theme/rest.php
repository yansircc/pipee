<?php

defined('ABSPATH') || exit;

function zeroy_runtime_theme_request_json(WP_REST_Request $request): array|WP_Error
{
    $payload = json_decode((string) $request->get_body(), true);
    return zeroy_runtime_is_keyed_map($payload)
        ? $payload
        : zeroy_runtime_error('zeroy_theme_request_invalid', 'ThemeDeployment request body must be a JSON object.', 400);
}

function zeroy_runtime_theme_state_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_theme_state();
    if ($active === null) {
        return new WP_REST_Response([
            'contract' => 'zeroy/theme-state@1',
            'state' => zeroy_runtime_bootstrap_required() ? 'bootstrap-required' : 'recovery-required',
            'policy' => zeroy_runtime_theme_policy(),
            'activeDeploymentId' => null,
            'activeArtifactId' => null,
            'revision' => null,
            'integrity' => null,
            'storage' => zeroy_runtime_theme_storage_usage(),
        ]);
    }
    $integrity = zeroy_runtime_artifact_integrity((string) $active['artifact_id']);
    return new WP_REST_Response([
        'contract' => 'zeroy/theme-state@1',
        'state' => 'active',
        'activeDeploymentId' => $active['active_deployment_id'],
        'activeArtifactId' => $active['artifact_id'],
        'revision' => (int) $active['revision'],
        'activatedAt' => $active['activated_at'],
        'integrity' => is_wp_error($integrity) ? ['ok' => false, 'code' => $integrity->get_error_code()] : $integrity,
        'policy' => zeroy_runtime_theme_policy(),
        'storage' => zeroy_runtime_theme_storage_usage(),
    ]);
}

function zeroy_runtime_theme_bootstrap_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_theme_request_json($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $artifact_id = $payload['artifactId'] ?? null;
    $provenance = $payload['provenance'] ?? [];
    if (!is_string($artifact_id) || !zeroy_runtime_is_keyed_map($provenance)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_theme_bootstrap_request_invalid', 'ThemeBootstrap requires artifactId and object provenance.', 400));
    }
    $result = zeroy_runtime_bootstrap_theme_deployment_from_artifact($artifact_id, $provenance);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, 201);
}

function zeroy_runtime_theme_policy_endpoint(): WP_REST_Response
{
    return new WP_REST_Response(zeroy_runtime_theme_policy());
}

function zeroy_runtime_theme_integrity_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_theme_state();
    if ($active === null) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_active_theme_missing', 'No active ThemeDeployment is available.', 409));
    }
    $integrity = zeroy_runtime_artifact_integrity((string) $active['artifact_id']);
    return is_wp_error($integrity)
        ? zeroy_runtime_response_error($integrity)
        : new WP_REST_Response(['contract' => 'zeroy/theme-integrity@1', 'activeDeploymentId' => $active['active_deployment_id'], ...$integrity]);
}

function zeroy_runtime_theme_repair_endpoint(): WP_REST_Response
{
    $result = zeroy_runtime_repair_active_theme_artifact();
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => 'zeroy/theme-repair@1', ...$result]);
}

function zeroy_runtime_theme_artifact_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $artifact_id = (string) $request['artifactId'];
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    if ($artifact === null) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_artifact_missing', 'ThemeArtifact does not exist.', 404));
    }
    $manifest = zeroy_runtime_decode_json((string) $artifact['manifest_json']);
    return new WP_REST_Response([
        'contract' => ZEROY_THEME_ARTIFACT_CONTRACT,
        'artifactId' => $artifact['artifact_id'],
        'manifest' => is_wp_error($manifest) ? null : $manifest,
        'schemaHash' => $artifact['schema_hash'] !== '' ? $artifact['schema_hash'] : null,
        'fileCount' => (int) $artifact['file_count'],
        'totalBytes' => (int) $artifact['total_bytes'],
        'createdAt' => $artifact['created_at'],
    ]);
}

function zeroy_runtime_theme_artifact_upload_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_theme_request_json($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $manifest = isset($payload['manifest']) && is_array($payload['manifest']) ? zeroy_runtime_normalize_manifest($payload['manifest']) : zeroy_runtime_error('zeroy_manifest_invalid', 'ThemeArtifact upload requires manifest.', 400);
    if (is_wp_error($manifest)) {
        return zeroy_runtime_response_error($manifest);
    }
    $archive = $payload['archiveBase64'] ?? null;
    if (!is_string($archive)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_artifact_archive_invalid', 'ThemeArtifact upload requires archiveBase64.', 400));
    }
    $result = zeroy_runtime_materialize_artifact_archive($manifest, $archive);
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response(['contract' => ZEROY_THEME_ARTIFACT_CONTRACT, ...$result], 201);
}

function zeroy_runtime_theme_artifact_archive_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $artifact_id = (string) $request['artifactId'];
    $archive = zeroy_runtime_artifact_archive_base64($artifact_id);
    return is_wp_error($archive)
        ? zeroy_runtime_response_error($archive)
        : new WP_REST_Response(['contract' => 'zeroy/theme-artifact-archive@1', 'artifactId' => $artifact_id, 'archiveBase64' => $archive]);
}

function zeroy_runtime_theme_deployment_prepare_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_theme_request_json($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $artifact_id = $payload['artifactId'] ?? null;
    $expected = $payload['expectedActiveArtifactId'] ?? null;
    $provenance = $payload['provenance'] ?? [];
    if (!is_string($artifact_id) || ($expected !== null && !is_string($expected)) || !zeroy_runtime_is_keyed_map($provenance)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_deployment_request_invalid', 'ThemeDeployment prepare requires artifactId, expectedActiveArtifactId, and object provenance.', 400));
    }
    $result = zeroy_runtime_prepare_theme_deployment($artifact_id, $expected, $provenance);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, ($result['state'] ?? null) === 'prepared' ? 201 : 409);
}

function zeroy_runtime_theme_deployment_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_theme_deployment_receipt((string) $request['deploymentId']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_theme_deployments_endpoint(WP_REST_Request $request): WP_REST_Response
{
    global $wpdb;
    $limit = min(50, max(1, (int) $request->get_param('limit') ?: 20));
    $rows = $wpdb->get_col(
        'SELECT deployment_id FROM ' . zeroy_runtime_table('theme_deployments') . ' ORDER BY created_at DESC LIMIT ' . $limit
    );
    $deployments = [];
    foreach (is_array($rows) ? $rows : [] as $deployment_id) {
        $receipt = zeroy_runtime_theme_deployment_receipt((string) $deployment_id);
        if (!is_wp_error($receipt)) {
            $deployments[] = $receipt;
        }
    }
    return new WP_REST_Response(['contract' => 'zeroy/theme-deployment-history@1', 'deployments' => $deployments]);
}

function zeroy_runtime_theme_deployment_activate_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_activate_theme_deployment((string) $request['deploymentId']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_register_theme_deployment_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/theme/state', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_state_endpoint']);
    register_rest_route('zeroy/v1', '/theme/policy', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_policy_endpoint']);
    register_rest_route('zeroy/v1', '/theme/integrity', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_integrity_endpoint']);
    register_rest_route('zeroy/v1', '/theme/repair', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_repair_endpoint']);
    register_rest_route('zeroy/v1', '/theme/artifacts', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_artifact_upload_endpoint']);
    register_rest_route('zeroy/v1', '/theme/bootstrap', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_bootstrap_endpoint']);
    register_rest_route('zeroy/v1', '/theme/artifacts/(?P<artifactId>sha256:[0-9a-f]{64})/archive', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_artifact_archive_endpoint']);
    register_rest_route('zeroy/v1', '/theme/artifacts/(?P<artifactId>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_artifact_endpoint']);
    register_rest_route('zeroy/v1', '/theme/deployments/prepare', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_deployment_prepare_endpoint']);
    register_rest_route('zeroy/v1', '/theme/deployments', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_deployments_endpoint']);
    register_rest_route('zeroy/v1', '/theme/deployments/(?P<deploymentId>[a-f0-9-]{36})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_theme_deployment_endpoint']);
    register_rest_route('zeroy/v1', '/theme/deployments/(?P<deploymentId>[a-f0-9-]{36})/activate', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_theme_deployment_activate_endpoint']);
}
add_action('rest_api_init', 'zeroy_runtime_register_theme_deployment_routes');
