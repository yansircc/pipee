<?php

defined('ABSPATH') || exit;

function zeroy_checkout_release_state_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    return new WP_REST_Response(['contract' => 'zeroy/site-release-state@1', 'state' => $active === null ? 'bootstrap-required' : 'active', 'activeReleaseId' => $active['active_release_id'] ?? null, 'themeArtifactId' => $active['theme_artifact_id'] ?? null, 'siteLogicArtifactId' => $active['site_logic_artifact_id'] ?? null, 'revision' => isset($active['revision']) ? (int) $active['revision'] : null, 'storageEpoch' => isset($active['storage_epoch']) ? (int) $active['storage_epoch'] : null, 'themePolicy' => zeroy_runtime_theme_policy(), 'siteLogicPolicy' => zeroy_runtime_site_logic_policy()]);
}

function zeroy_checkout_external_check_targets_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    if ($active === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_active_site_release_missing', 'No active SiteRelease is available for external checks.', 409));
    $snapshot = zeroy_runtime_site_release_snapshot($active);
    if (is_wp_error($snapshot)) return zeroy_runtime_response_error($snapshot);
    $scenarios = zeroy_runtime_snapshot_scenarios($snapshot);
    $scenario_hash = zeroy_runtime_hash($scenarios);
    $proof = !empty($active['proof_id']) ? zeroy_runtime_site_release_proof_row((string) $active['proof_id']) : null;
    $proof_payload = is_array($proof) ? zeroy_runtime_decode_json((string) $proof['proof_json']) : null;
    if (!is_array($proof_payload) || (($proof_payload['themeProof']['scenarioSetHash'] ?? null) !== $scenario_hash)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_active_site_release_proof_invalid', 'Active SiteRelease does not bind its external-check scenario set.', 409, ['releaseId' => $active['active_release_id'] ?? null]));
    $targets = array_map(static fn(array $scenario): array => [
        'scenarioId' => $scenario['id'],
        'routeKind' => $scenario['kind'],
        'objectId' => null,
        'locale' => $scenario['locale'],
        'url' => add_query_arg($scenario['query'] ?? [], home_url($scenario['path'])),
        'expectedStatus' => $scenario['expectedStatus'],
    ], $scenarios);
    return new WP_REST_Response(['contract' => 'zeroy/site-release-external-targets@1', 'releaseId' => $active['active_release_id'], 'scenarioSetHash' => $scenario_hash, 'targets' => $targets]);
}

function zeroy_checkout_release_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $release = zeroy_runtime_site_release_row((string) $request['releaseId']);
    if ($release === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404));
    if (!zeroy_runtime_site_release_is_public($release)) {
        $owned = zeroy_runtime_site_release_owned_candidate($release, zeroy_checkout_owner_principal());
        if (is_wp_error($owned)) return zeroy_runtime_response_error($owned);
    }
    $result = zeroy_runtime_site_release_receipt((string) $release['release_id']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_checkout_releases_endpoint(WP_REST_Request $request): WP_REST_Response
{
    global $wpdb;
    $limit = min(50, max(1, (int) ($request->get_param('limit') ?: 20)));
    $cursor = is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null;
    $offset = zeroy_checkout_page_offset($cursor);
    if (is_wp_error($offset)) return zeroy_runtime_response_error($offset);
    $ids = $wpdb->get_col($wpdb->prepare('SELECT release_id FROM ' . zeroy_runtime_table('site_releases') . " WHERE state IN ('active', 'superseded') ORDER BY created_at DESC LIMIT %d OFFSET %d", $limit + 1, $offset));
    if (!is_array($ids)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_query_failed', $wpdb->last_error ?: 'Could not query SiteRelease history.', 500));
    $has_more = count($ids) > $limit;
    $items = [];
    foreach (array_slice($ids, 0, $limit) as $id) {
        $receipt = zeroy_runtime_site_release_receipt((string) $id);
        if (!is_wp_error($receipt)) $items[] = $receipt;
    }
    $projection = zeroy_checkout_bounded_projection(['contract' => 'zeroy/site-release-history@1', 'items' => $items, 'nextCursor' => $has_more ? zeroy_checkout_page_cursor($offset + $limit) : null, 'hasMore' => $has_more]);
    return is_wp_error($projection) ? zeroy_runtime_response_error($projection) : new WP_REST_Response($projection);
}

function zeroy_checkout_proof_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $proof = zeroy_runtime_site_release_proof_row((string) $request['proofId']);
    if ($proof === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    $release = zeroy_runtime_site_release_row((string) $proof['release_id']);
    if ($release === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    if (!zeroy_runtime_site_release_is_public($release)) {
        $owned = zeroy_runtime_site_release_owned_candidate($release, zeroy_checkout_owner_principal());
        if (is_wp_error($owned)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    }
    $decoded = zeroy_runtime_decode_json((string) $proof['proof_json']);
    if (is_wp_error($decoded)) return zeroy_runtime_response_error($decoded);
    $view = is_string($request->get_param('view')) ? $request->get_param('view') : 'summary';
    $projection = zeroy_runtime_site_release_proof_projection((string) $proof['proof_id'], (string) $proof['release_id'], $decoded, $view, (int) ($request->get_param('limit') ?: 20), is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null);
    return is_wp_error($projection) ? zeroy_runtime_response_error($projection) : new WP_REST_Response($projection);
}

function zeroy_checkout_migration_history_endpoint(WP_REST_Request $request): WP_REST_Response
{
    return new WP_REST_Response(zeroy_runtime_site_logic_migration_history((int) $request->get_param('limit') ?: 50));
}

function zeroy_checkout_artifact_endpoint(WP_REST_Request $request, string $kind): WP_REST_Response
{
    $id = (string) $request['artifactId'];
    $accessible = zeroy_runtime_site_release_artifact_owned_candidate($kind, $id, zeroy_checkout_owner_principal());
    if (is_wp_error($accessible)) return zeroy_runtime_response_error($accessible);
    $row = $kind === 'theme' ? zeroy_runtime_artifact_row($id) : zeroy_runtime_site_logic_artifact_row($id);
    if ($row === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_artifact_missing', 'Artifact does not exist.', 404));
    $manifest = zeroy_runtime_decode_json((string) $row['manifest_json']);
    $artifact_contract = $kind === 'theme' ? zeroy_runtime_decode_json((string) ($row['schema_json'] ?? '')) : zeroy_runtime_decode_json((string) ($row['contract_json'] ?? ''));
    return new WP_REST_Response(['contract' => $kind === 'theme' ? ZEROY_THEME_ARTIFACT_CONTRACT : ZEROY_SITE_LOGIC_ARTIFACT_CONTRACT, 'artifactId' => $id, 'manifest' => is_wp_error($manifest) ? null : $manifest, 'artifactContract' => is_wp_error($artifact_contract) ? null : $artifact_contract, 'contractHash' => $row['contract_hash'] ?? null, 'storageEpoch' => isset($row['storage_epoch']) ? (int) $row['storage_epoch'] : null]);
}

function zeroy_checkout_artifact_archive_endpoint(WP_REST_Request $request, string $kind): WP_REST_Response
{
    $id = (string) $request['artifactId'];
    $accessible = zeroy_runtime_site_release_artifact_owned_candidate($kind, $id, zeroy_checkout_owner_principal());
    if (is_wp_error($accessible)) return zeroy_runtime_response_error($accessible);
    $archive = $kind === 'theme' ? zeroy_runtime_artifact_archive_base64($id) : zeroy_runtime_site_logic_artifact_archive_base64($id);
    return is_wp_error($archive) ? zeroy_runtime_response_error($archive) : new WP_REST_Response(['artifactId' => $id, 'archiveBase64' => $archive]);
}

function zeroy_checkout_register_read_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site-release/state', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_release_state_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/external-check-targets', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_external_check_targets_endpoint']);
    foreach (['theme', 'site-logic'] as $kind) {
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_checkout_artifact_endpoint($request, $kind)]);
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})/archive', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_checkout_artifact_archive_endpoint($request, $kind)]);
    }
    register_rest_route('zeroy/v1', '/site-releases', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_releases_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases/(?P<releaseId>[a-f0-9-]{36})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_release_endpoint']);
    register_rest_route('zeroy/v1', '/site-release-proofs/(?P<proofId>[a-z0-9-]{1,64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_proof_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/migrations', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_migration_history_endpoint']);
}
add_action('rest_api_init', 'zeroy_checkout_register_read_routes');
