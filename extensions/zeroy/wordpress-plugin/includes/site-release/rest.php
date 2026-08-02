<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_release_request_json(WP_REST_Request $request): array|WP_Error
{
    $payload = json_decode((string) $request->get_body(), true);
    return zeroy_runtime_is_keyed_map($payload) ? $payload : zeroy_runtime_error('zeroy_site_release_request_invalid', 'SiteRelease request body must be a JSON object.', 400);
}

function zeroy_runtime_site_draft_id_param(WP_REST_Request $request): string|WP_Error
{
    $draft_id = (string) $request['draftId'];
    if (!preg_match('/^[a-f0-9-]{36}$/', $draft_id)) {
        return zeroy_runtime_error('zeroy_site_draft_id_invalid', 'draftId must be a UUID.', 400, ['fieldId' => 'draftId']);
    }
    return $draft_id;
}

/**
 * Draft ownership is transport metadata derived by Pi from its session, never
 * an Agent-authored tool argument. It makes concurrent remote sessions
 * separate Draft principals while keeping SiteDraft itself in WordPress.
 */
function zeroy_runtime_site_draft_request_owner(WP_REST_Request $request): string|WP_Error
{
    $owner_id = trim((string) $request->get_header('x-zeroy-draft-owner'));
    return zeroy_runtime_site_draft_owner_valid($owner_id)
        ? $owner_id
        : zeroy_runtime_error('zeroy_site_draft_owner_required', 'A stable Pi session owner is required for SiteDraft access.', 400, ['fieldId' => 'x-zeroy-draft-owner']);
}

function zeroy_runtime_site_draft_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $draft_id = zeroy_runtime_site_draft_id_param($request);
    if (is_wp_error($draft_id)) return zeroy_runtime_response_error($draft_id);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $draft = zeroy_runtime_site_draft_row($draft_id);
    if ($draft === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404));
    $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
    if (is_wp_error($owned)) return zeroy_runtime_response_error($owned);
    $inspection = zeroy_runtime_site_draft_inspection($draft);
    return is_wp_error($inspection) ? zeroy_runtime_response_error($inspection) : new WP_REST_Response($inspection);
}

function zeroy_runtime_site_draft_stage_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_site_release_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $draft_id = $payload['draftId'] ?? null;
    if ($draft_id !== null && (!is_string($draft_id) || !preg_match('/^[a-f0-9-]{36}$/', $draft_id))) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_draft_id_invalid', 'draftId must be a UUID when supplied.', 400, ['fieldId' => 'draftId']));
    }
    unset($payload['draftId']);
    $kind = $payload['kind'] ?? null;
    if (!is_string($kind) || !in_array($kind, zeroy_runtime_site_draft_operation_kinds(), true)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Operation kind is not part of the SiteDraft contract.', 400, ['fieldId' => 'kind', 'allowed' => zeroy_runtime_site_draft_operation_kinds()]));
    unset($payload['kind']);
    $operation = ['kind' => $kind, 'payload' => $payload];
    $result = zeroy_runtime_stage_site_draft_operation($draft_id, $operation, $owner_id);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, 201);
}

function zeroy_runtime_site_draft_discard_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $draft_id = zeroy_runtime_site_draft_id_param($request);
    if (is_wp_error($draft_id)) return zeroy_runtime_response_error($draft_id);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $result = zeroy_runtime_discard_site_draft($draft_id, $owner_id);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_site_draft_replay_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $draft_id = zeroy_runtime_site_draft_id_param($request);
    if (is_wp_error($draft_id)) return zeroy_runtime_response_error($draft_id);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $result = zeroy_runtime_replay_site_draft($draft_id, $owner_id);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, 201);
}

function zeroy_runtime_site_draft_commit_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $draft_id = zeroy_runtime_site_draft_id_param($request);
    if (is_wp_error($draft_id)) return zeroy_runtime_response_error($draft_id);
    $payload = zeroy_runtime_site_release_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $expected = $payload['expectedBaseReleaseId'] ?? null;
    $message = $payload['message'] ?? '';
    if (($expected !== null && (!is_string($expected) || $expected === '')) || !is_string($message)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_commit_request_invalid', 'Commit requires expectedBaseReleaseId (a release ID or null for bootstrap) and optional message.', 400));
    $result = zeroy_runtime_prepare_site_draft_commit($draft_id, $expected, $message, $owner_id);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result, 202);
}

function zeroy_runtime_site_release_browser_finalize_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $release_id = sanitize_text_field((string) $request->get_param('releaseId'));
    if (preg_match('/^[a-f0-9-]{36}$/', $release_id) !== 1) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_id_invalid', 'SiteRelease ID is invalid.', 400));
    $payload = zeroy_runtime_site_release_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    if (!zeroy_runtime_browser_evidence_exact_keys($payload, ['browserEvidence'])) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_browser_evidence_invalid', 'Finalize requires exactly browserEvidence.', 400));
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
    $release = zeroy_runtime_site_release_row($release_id);
    if ($release === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404));
    $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_id);
    if (is_wp_error($owned)) return zeroy_runtime_response_error($owned);
    $result = zeroy_runtime_finalize_site_draft_commit($release_id, $payload['browserEvidence'], $owner_id);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_site_release_state_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    return new WP_REST_Response(['contract' => 'zeroy/site-release-state@1', 'state' => $active === null ? 'bootstrap-required' : 'active', 'activeReleaseId' => $active['active_release_id'] ?? null, 'themeArtifactId' => $active['theme_artifact_id'] ?? null, 'siteLogicArtifactId' => $active['site_logic_artifact_id'] ?? null, 'revision' => isset($active['revision']) ? (int) $active['revision'] : null, 'storageEpoch' => isset($active['storage_epoch']) ? (int) $active['storage_epoch'] : null, 'themePolicy' => zeroy_runtime_theme_policy(), 'siteLogicPolicy' => zeroy_runtime_site_logic_policy()]);
}

/**
 * External inspection has one route truth: the immutable SiteRelease
 * scenarios whose hash CandidateProof binds. Inventory is not valid here
 * because it cannot represent archive, taxonomy, search, or not-found routes.
 */
function zeroy_runtime_site_release_external_check_targets_endpoint(): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    if ($active === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_active_site_release_missing', 'No active SiteRelease is available for external checks.', 409));
    $snapshot = zeroy_runtime_site_release_snapshot($active);
    if (is_wp_error($snapshot)) return zeroy_runtime_response_error($snapshot);
    $scenarios = zeroy_runtime_snapshot_scenarios($snapshot);
    $scenario_hash = zeroy_runtime_hash($scenarios);
    $proof = !empty($active['proof_id']) ? zeroy_runtime_site_release_proof_row((string) $active['proof_id']) : null;
    $proof_payload = is_array($proof) ? zeroy_runtime_decode_json((string) $proof['proof_json']) : null;
    if (!is_array($proof_payload) || (($proof_payload['themeProof']['scenarioSetHash'] ?? null) !== $scenario_hash)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_active_site_release_proof_invalid', 'Active SiteRelease does not bind its external-check scenario set.', 409, ['releaseId' => $active['active_release_id'] ?? null]));
    }
    $targets = [];
    foreach ($scenarios as $scenario) {
        $targets[] = [
            'scenarioId' => $scenario['id'],
            'routeKind' => $scenario['kind'],
            'objectId' => null,
            'locale' => $scenario['locale'],
            'url' => add_query_arg($scenario['query'] ?? [], home_url($scenario['path'])),
            'expectedStatus' => $scenario['expectedStatus'],
        ];
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/site-release-external-targets@1',
        'releaseId' => $active['active_release_id'],
        'scenarioSetHash' => $scenario_hash,
        'targets' => $targets,
    ]);
}

function zeroy_runtime_site_release_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $release = zeroy_runtime_site_release_row((string) $request['releaseId']);
    if ($release === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_missing', 'SiteRelease does not exist.', 404));
    if (!zeroy_runtime_site_release_is_public($release)) {
        $owner_id = zeroy_runtime_site_draft_request_owner($request);
        if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
        $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_id);
        if (is_wp_error($owned)) return zeroy_runtime_response_error($owned);
    }
    $result = zeroy_runtime_site_release_receipt((string) $release['release_id']);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}

function zeroy_runtime_site_releases_endpoint(WP_REST_Request $request): WP_REST_Response
{
    global $wpdb;
    $limit = min(50, max(1, (int) $request->get_param('limit') ?: 20));
    // Failed and prepared candidates remain discoverable from their owning
    // SiteDraft and proof ID. Release history deliberately contains only
    // globally observable releases, never another session's candidate.
    $ids = $wpdb->get_col(
        'SELECT release_id FROM ' . zeroy_runtime_table('site_releases') . " WHERE state IN ('active', 'superseded') ORDER BY created_at DESC LIMIT " . $limit,
    );
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
    $release = zeroy_runtime_site_release_row((string) $proof['release_id']);
    if ($release === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    if (!zeroy_runtime_site_release_is_public($release)) {
        $owner_id = zeroy_runtime_site_draft_request_owner($request);
        if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
        $owned = zeroy_runtime_site_release_owned_candidate($release, $owner_id);
        if (is_wp_error($owned)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_proof_missing', 'VerificationProof does not exist.', 404));
    }
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
    $owner_id = trim((string) $request->get_header('x-zeroy-draft-owner'));
    $accessible = zeroy_runtime_site_release_artifact_owned_candidate($kind, $id, $owner_id);
    if (is_wp_error($accessible)) return zeroy_runtime_response_error($accessible);
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
    $owner_id = trim((string) $request->get_header('x-zeroy-draft-owner'));
    $accessible = zeroy_runtime_site_release_artifact_owned_candidate($kind, $id, $owner_id);
    if (is_wp_error($accessible)) return zeroy_runtime_response_error($accessible);
    $archive = $kind === 'theme' ? zeroy_runtime_artifact_archive_base64($id) : zeroy_runtime_site_logic_artifact_archive_base64($id);
    return is_wp_error($archive) ? zeroy_runtime_response_error($archive) : new WP_REST_Response(['artifactId' => $id, 'archiveBase64' => $archive]);
}

function zeroy_runtime_site_artifact_files_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $active = zeroy_runtime_active_site_release();
    $artifact = (string) $request['artifact'];
    $path = (string) ($request->get_param('path') ?? '');
    if (!in_array($artifact, ['theme', 'site-logic'], true)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_invalid', 'Site artifact must be theme or site-logic.', 400, ['fieldId' => 'artifact']));
    $artifact_id = is_array($active)
        ? (string) ($artifact === 'theme' ? ($active['theme_artifact_id'] ?? '') : ($active['site_logic_artifact_id'] ?? ''))
        : '';
    $directory = $artifact_id === ''
        ? ($artifact === 'site-logic' ? dirname(__DIR__, 2) . '/default-site-logic' : null)
        : ($artifact === 'theme' ? zeroy_runtime_artifact_directory($artifact_id) : zeroy_runtime_site_logic_directory($artifact_id));
    if ($directory === null) {
        if ($path !== '') return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_file_missing', 'No ThemeArtifact exists before the first SiteRelease.', 404, ['artifact' => $artifact, 'path' => $path]));
        return new WP_REST_Response([
            'contract' => 'zeroy/site-artifact-file-list@1',
            'artifact' => $artifact,
            'artifactId' => null,
            'state' => 'bootstrap-required',
            'files' => [],
        ]);
    }
    if ($path === '') {
        $manifest = $artifact_id === ''
            ? ($artifact === 'site-logic' ? zeroy_runtime_scan_site_logic_tree($directory) : null)
            : ($artifact === 'theme'
                ? zeroy_runtime_decode_json((string) (zeroy_runtime_artifact_row($artifact_id)['manifest_json'] ?? ''))
                : zeroy_runtime_decode_json((string) (zeroy_runtime_site_logic_artifact_row($artifact_id)['manifest_json'] ?? '')));
        $entries = is_array($manifest) && is_array($manifest['entries'] ?? null) ? $manifest['entries'] : null;
        if ($entries === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_files_unavailable', 'Selected SiteArtifact has no readable manifest.', 409, ['artifact' => $artifact]));
        return new WP_REST_Response([
            'contract' => 'zeroy/site-artifact-file-list@1',
            'artifact' => $artifact,
            'artifactId' => $artifact_id === '' ? null : $artifact_id,
            'state' => $artifact_id === '' ? 'bootstrap-default' : 'active',
            'files' => array_values(array_map(static fn(array $entry): array => [
                'path' => $entry['path'] ?? null,
                'hash' => $entry['hash'] ?? null,
                'bytes' => $entry['bytes'] ?? null,
            ], $entries)),
        ]);
    }
    if (!zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_path_invalid', 'Site artifact file path is invalid or forbidden.', 400, ['fieldId' => 'path', 'artifact' => $artifact]));
    $file = $directory . '/' . $path;
    if (!is_file($file) || is_link($file)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_file_missing', 'File does not exist in the selected SiteArtifact.', 404, ['artifact' => $artifact, 'path' => $path]));
    $content = file_get_contents($file);
    if (!is_string($content)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_artifact_file_unreadable', 'SiteArtifact file could not be read.', 500, ['artifact' => $artifact, 'path' => $path]));
    return new WP_REST_Response(['contract' => 'zeroy/site-artifact-file@1', 'artifact' => $artifact, 'artifactId' => $artifact_id === '' ? null : $artifact_id, 'path' => $path, 'hash' => hash('sha256', $content), 'bytes' => strlen($content), 'content' => $content]);
}

function zeroy_runtime_zcss_style_surface_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $draft_id = $request->get_param('draftId');
    if (is_string($draft_id) && $draft_id !== '') {
        $owner_id = zeroy_runtime_site_draft_request_owner($request);
        if (is_wp_error($owner_id)) return zeroy_runtime_response_error($owner_id);
        $draft = zeroy_runtime_site_draft_row($draft_id);
        if ($draft === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404));
        $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
        if (is_wp_error($owned)) return zeroy_runtime_response_error($owned);
        $active = zeroy_runtime_site_draft_active_base($draft);
        if (is_wp_error($active)) return zeroy_runtime_response_error($active);
        $surface = zeroy_runtime_with_site_draft_artifact_directory(
            $draft,
            $active === [] ? null : $active,
            'theme',
            static fn(string $directory): array|WP_Error => zeroy_zcss_style_surface_from_directory($directory),
        );
        if (is_wp_error($surface)) return zeroy_runtime_response_error($surface);
        return new WP_REST_Response([...$surface, 'draftId' => $draft_id, 'releaseId' => null, 'themeArtifactId' => null]);
    }
    $active = zeroy_runtime_active_site_release();
    if (!is_array($active)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_release_missing', 'No active SiteRelease is available.', 404));
    $artifact_id = (string) $active['theme_artifact_id'];
    $surface = zeroy_zcss_style_surface_from_directory(zeroy_runtime_artifact_directory($artifact_id));
    return is_wp_error($surface)
        ? zeroy_runtime_response_error($surface)
        : new WP_REST_Response([...$surface, 'draftId' => null, 'releaseId' => (string) $active['release_id'], 'themeArtifactId' => $artifact_id]);
}

function zeroy_runtime_register_site_release_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site-drafts/(?P<draftId>[a-f0-9-]{36})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_draft_endpoint']);
    register_rest_route('zeroy/v1', '/site-draft-stages', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_draft_stage_endpoint']);
    register_rest_route('zeroy/v1', '/site-drafts/(?P<draftId>[a-f0-9-]{36})/replay', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_draft_replay_endpoint']);
    register_rest_route('zeroy/v1', '/site-drafts/(?P<draftId>[a-f0-9-]{36})/discard', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_draft_discard_endpoint']);
    register_rest_route('zeroy/v1', '/site-drafts/(?P<draftId>[a-f0-9-]{36})/commit', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_draft_commit_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases/(?P<releaseId>[a-f0-9-]{36})/browser-evidence', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_runtime_site_release_browser_finalize_endpoint']);
    register_rest_route('zeroy/v1', '/site-artifacts/(?P<artifact>theme|site-logic)/files', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_artifact_files_endpoint']);
    register_rest_route('zeroy/v1', '/zcss-style-surface', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_zcss_style_surface_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/state', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_state_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/external-check-targets', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_external_check_targets_endpoint']);
    foreach (['theme', 'site-logic'] as $kind) {
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_runtime_site_release_artifact_endpoint($request, $kind)]);
        register_rest_route('zeroy/v1', '/site-release/' . $kind . '-artifacts/(?P<artifactId>sha256:[0-9a-f]{64})/archive', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => static fn(WP_REST_Request $request): WP_REST_Response => zeroy_runtime_site_release_artifact_archive_endpoint($request, $kind)]);
    }
    register_rest_route('zeroy/v1', '/site-releases', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_releases_endpoint']);
    register_rest_route('zeroy/v1', '/site-releases/(?P<releaseId>[a-f0-9-]{36})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_endpoint']);
    register_rest_route('zeroy/v1', '/site-release-proofs/(?P<proofId>[a-z0-9-]{1,64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_release_proof_endpoint']);
    register_rest_route('zeroy/v1', '/site-release/migrations', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_logic_migration_history_endpoint']);
}
add_action('rest_api_init', 'zeroy_runtime_register_site_release_routes');
