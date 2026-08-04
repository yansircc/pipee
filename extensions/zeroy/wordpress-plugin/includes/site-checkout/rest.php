<?php

defined('ABSPATH') || exit;

function zeroy_checkout_request_json(WP_REST_Request $request): array|WP_Error
{
    $payload = json_decode((string) $request->get_body(), true);
    return zeroy_runtime_is_keyed_map($payload) ? $payload : zeroy_runtime_error('zeroy_checkout_request_invalid', 'Checkout request body must be a JSON object.', 400);
}

function zeroy_checkout_source_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $source = (string) ($request->get_param('source') ?: 'active-release');
    $ref_name = is_string($request->get_param('draftRef')) ? $request->get_param('draftRef') : null;
    $requested_commit = is_string($request->get_param('commit')) ? $request->get_param('commit') : null;
    if ($source === 'active-release') {
        $active = zeroy_runtime_active_site_release();
        if ($active === null) {
            $commit_hash = zeroy_checkout_seed_bootstrap_commit();
            if (is_wp_error($commit_hash)) return zeroy_runtime_response_error($commit_hash);
            $commit = zeroy_checkout_commit_row($commit_hash);
            $base_release_id = null;
            $draft_ref = null;
        } else {
            $commit_hash = (string) ($active['commit_hash'] ?? '');
            $commit = zeroy_checkout_commit_row($commit_hash);
            $base_release_id = (string) $active['release_id'];
            $draft_ref = null;
        }
    } elseif ($source === 'draft-ref' && is_string($ref_name) && zeroy_checkout_ref_name_valid($ref_name)) {
        $ref = zeroy_checkout_ref_row($ref_name);
        if ($ref === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_ref_missing', 'DraftRef does not exist.', 404, ['draftRef' => $ref_name]));
        $commit_hash = (string) $ref['commit_hash'];
        $commit = zeroy_checkout_commit_row($commit_hash);
        $base_release_id = $commit['base_release_id'] ?? null;
        $draft_ref = $ref_name;
    } elseif ($source === 'commit' && is_string($requested_commit) && preg_match('/\Asha256:[a-f0-9]{64}\z/', $requested_commit) === 1) {
        $commit_hash = $requested_commit;
        $commit = zeroy_checkout_commit_row($commit_hash);
        $base_release_id = is_array($commit) ? ($commit['base_release_id'] ?? null) : null;
        $draft_ref = null;
    } else {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_checkout_source_invalid', 'Checkout source must be active-release, an exact commit, or a valid draft-ref.', 400));
    }
    if (!is_array($commit)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_commit_missing', 'Checkout source commit does not exist.', 409, ['commit' => $commit_hash]));
    $files = zeroy_checkout_flatten_tree((string) $commit['tree_hash']);
    if (is_wp_error($files)) return zeroy_runtime_response_error($files);
    $build = zeroy_build_compile($commit_hash);
    if (is_wp_error($build)) return zeroy_runtime_response_error($build);
    return new WP_REST_Response([
        'contract' => 'zeroy/checkout-source@1',
        'source' => $source,
        'commit' => $commit_hash,
        'tree' => $commit['tree_hash'],
        'baseReleaseId' => $base_release_id ?: null,
        'draftRef' => $draft_ref,
        'build' => [
            'buildId' => $build['result']['buildId'],
            'state' => $build['result']['state'],
            'failureCount' => $build['result']['failureCount'],
            'diagnosticCount' => $build['result']['diagnosticCount'],
        ],
        'files' => array_map(static fn(string $path, array $file): array => ['path' => $path, ...$file], array_keys($files), array_values($files)),
    ]);
}

function zeroy_checkout_object_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $hash = (string) $request['objectHash'];
    $row = zeroy_checkout_object_row($hash);
    if ($row === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_object_missing', 'SiteObject does not exist.', 404, ['objectHash' => $hash]));
    return new WP_REST_Response(['contract' => 'zeroy/site-object@1', 'objectHash' => $hash, 'objectType' => $row['object_type'], 'byteCount' => (int) $row['byte_count'], 'bytesBase64' => base64_encode((string) $row['object_bytes'])]);
}

function zeroy_checkout_have_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_checkout_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $hashes = $payload['hashes'] ?? null;
    if (!is_array($hashes) || !array_is_list($hashes) || count($hashes) > 5000) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_object_have_invalid', 'Have/want requires a bounded hashes list.', 400));
    $missing = zeroy_checkout_missing_objects($hashes);
    return is_wp_error($missing) ? zeroy_runtime_response_error($missing) : new WP_REST_Response(['contract' => 'zeroy/site-object-want@1', 'missing' => $missing]);
}

function zeroy_checkout_upload_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_checkout_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $objects = $payload['objects'] ?? null;
    if (!is_array($objects) || !array_is_list($objects) || count($objects) > 100) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_object_upload_invalid', 'Object upload requires a bounded objects list.', 400));
    $results = [];
    foreach ($objects as $object) {
        $bytes = is_array($object) && is_string($object['bytesBase64'] ?? null) ? base64_decode($object['bytesBase64'], true) : false;
        if (!is_string($bytes) || strlen($bytes) > 16 * 1024 * 1024) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_object_upload_invalid', 'Object bytes are invalid or exceed the per-object limit.', 400));
        $stored = zeroy_checkout_store_object((string) ($object['objectType'] ?? ''), (string) ($object['objectHash'] ?? ''), $bytes);
        if (is_wp_error($stored)) return zeroy_runtime_response_error($stored);
        $results[] = $stored;
    }
    return new WP_REST_Response(['contract' => 'zeroy/site-object-upload@1', 'objects' => $results], 201);
}

function zeroy_checkout_commit_upload_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_checkout_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $commit = $payload['commit'] ?? null;
    $hash = $payload['commitHash'] ?? null;
    if (!is_array($commit) || !is_string($hash)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_commit_upload_invalid', 'Commit upload requires commitHash and commit.', 400));
    $stored = zeroy_checkout_store_commit($commit, $hash);
    return is_wp_error($stored) ? zeroy_runtime_response_error($stored) : new WP_REST_Response(['contract' => 'zeroy/site-commit-upload@1', ...$stored], 201);
}

function zeroy_checkout_commit_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $hash = (string) $request['commitHash'];
    $row = zeroy_checkout_commit_row($hash);
    if ($row === null) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit does not exist.', 404));
    $commit = zeroy_runtime_decode_json((string) $row['commit_json']);
    return is_wp_error($commit) ? zeroy_runtime_response_error($commit) : new WP_REST_Response(['contract' => 'zeroy/site-commit-read@1', 'commitHash' => $hash, 'commit' => $commit]);
}

function zeroy_checkout_commit_history_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $commit = is_string($request->get_param('commit')) ? $request->get_param('commit') : null;
    $limit = min(50, max(1, (int) ($request->get_param('limit') ?: 20)));
    $cursor = is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null;
    $projection = zeroy_checkout_commit_history($commit, $limit, $cursor);
    return is_wp_error($projection) ? zeroy_runtime_response_error($projection) : new WP_REST_Response($projection);
}

function zeroy_checkout_commit_diff_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $base = (string) $request->get_param('base');
    $commit = (string) $request->get_param('commit');
    $limit = min(50, max(1, (int) ($request->get_param('limit') ?: 20)));
    $cursor = is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null;
    if (preg_match('/\Asha256:[a-f0-9]{64}\z/', $base) !== 1 || preg_match('/\Asha256:[a-f0-9]{64}\z/', $commit) !== 1) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_commit_diff_invalid', 'Commit diff requires base and commit hashes.', 400));
    $projection = zeroy_checkout_commit_diff($base, $commit, $limit, $cursor);
    return is_wp_error($projection) ? zeroy_runtime_response_error($projection) : new WP_REST_Response($projection);
}

function zeroy_checkout_refs_endpoint(WP_REST_Request $request): WP_REST_Response
{
    global $wpdb;
    $limit = min(50, max(1, (int) ($request->get_param('limit') ?: 20)));
    $cursor = is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null;
    $offset = zeroy_checkout_page_offset($cursor);
    if (is_wp_error($offset)) return zeroy_runtime_response_error($offset);
    $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_refs') . ' ORDER BY ref_name ASC LIMIT %d OFFSET %d', $limit + 1, $offset), ARRAY_A);
    if (!is_array($rows)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_ref_query_failed', $wpdb->last_error ?: 'Could not list DraftRefs.', 500));
    $has_more = count($rows) > $limit;
    $rows = array_slice($rows, 0, $limit);
    $projection = zeroy_checkout_bounded_projection(['contract' => 'zeroy/site-ref-list@1', 'items' => array_map(static fn(array $row): array => ['refName' => $row['ref_name'], 'commit' => $row['commit_hash'], 'revision' => (int) $row['revision'], 'updatedAt' => $row['updated_at']], $rows), 'nextCursor' => $has_more ? zeroy_checkout_page_cursor($offset + $limit) : null, 'hasMore' => $has_more]);
    return is_wp_error($projection) ? zeroy_runtime_response_error($projection) : new WP_REST_Response($projection);
}

function zeroy_checkout_accept_push(array $payload): array|WP_Error
{
    $ref = zeroy_checkout_update_ref_locked($payload['refName'], is_string($payload['expectedCommit'] ?? null) ? $payload['expectedCommit'] : null, $payload['commitHash']);
    if (is_wp_error($ref)) return $ref;
    $result = [
        'contract' => 'zeroy/push-receipt@3',
        'checkoutId' => (string) ($payload['checkoutId'] ?? ''),
        'commit' => $payload['commitHash'],
        'draftRef' => $payload['refName'],
    ];
    $recorded = zeroy_checkout_record_push_receipt($payload['commandId'], $payload['requestHash'], $result);
    return is_wp_error($recorded) ? $recorded : $result;
}

function zeroy_checkout_complete_push(string $command_id, string $request_hash, array $accepted, string $message): array|WP_Error
{
    if (is_array($accepted['review'] ?? null)) return $accepted;
    $result = $accepted;
    if (!is_array($result['build'] ?? null)) {
        $build = zeroy_build_compile((string) $accepted['commit']);
        if (is_wp_error($build)) return $build;
        $result += ['build' => [
            'buildId' => $build['result']['buildId'],
            'state' => $build['result']['state'],
            'failureCount' => $build['result']['failureCount'],
            'diagnosticCount' => $build['result']['diagnosticCount'],
        ]];
    }
    $build_id = (string) ($result['build']['buildId'] ?? '');
    if ($build_id === '') return zeroy_runtime_error('zeroy_build_result_missing', 'Push did not identify a BuildResult.', 500);
    if (in_array($result['build']['state'] ?? null, ['renderable', 'ready'], true)) {
        $preview = zeroy_checkout_prepare_preview((string) $accepted['commit'], $build_id, (string) $accepted['draftRef'], $message, zeroy_checkout_owner_principal());
        if (is_wp_error($preview)) {
            $result['preflight'] = ['state' => 'blocked', 'code' => $preview->get_error_code(), 'message' => $preview->get_error_message()];
        } else {
            $result += $preview;
        }
    }
    $review = zeroy_review_for_commit((string) $accepted['commit'], $build_id);
    if (is_wp_error($review)) return $review;
    $result['review'] = $review;
    $updated = zeroy_checkout_replace_push_receipt($command_id, $request_hash, $result);
    return is_wp_error($updated) ? $updated : $result;
}

function zeroy_checkout_push_change_summary(mixed $value): array|WP_Error
{
    if (!is_array($value) || array_is_list($value)) return zeroy_runtime_error('zeroy_push_request_invalid', 'Push changeSummary must be an object.', 400, ['fieldId' => 'changeSummary']);
    $keys = array_keys($value);
    $expected = ['changedPathCount', 'changedSubjectCount', 'uploadedObjectCount', 'uploadedBytes'];
    sort($keys, SORT_STRING);
    sort($expected, SORT_STRING);
    if ($keys !== $expected) return zeroy_runtime_error('zeroy_push_request_invalid', 'Push changeSummary has unexpected fields.', 400, ['fieldId' => 'changeSummary']);
    foreach ($expected as $field) if (!is_int($value[$field]) || $value[$field] < 0) return zeroy_runtime_error('zeroy_push_request_invalid', 'Push changeSummary counts must be non-negative integers.', 400, ['fieldId' => 'changeSummary.' . $field]);
    return $value;
}

function zeroy_checkout_push_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_checkout_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    foreach (['commandId', 'requestHash', 'refName', 'commitHash'] as $field) if (!is_string($payload[$field] ?? null)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_request_invalid', 'Push request is missing a transport field.', 400, ['fieldId' => $field]));
    foreach (['checkoutId', 'expectedCommit', 'message', 'changeSummary'] as $field) if (!array_key_exists($field, $payload)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_request_invalid', 'Push request is missing a transport field.', 400, ['fieldId' => $field]));
    if (preg_match('/\A[a-f0-9-]{36}\z/', $payload['commandId']) !== 1 || preg_match('/\A[a-f0-9]{64}\z/', $payload['requestHash']) !== 1) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_request_invalid', 'Push transport fields are invalid.', 400));
    if (!is_string($payload['checkoutId'] ?? null) || $payload['checkoutId'] === '' || strlen($payload['checkoutId']) > 128 || !is_string($payload['message'] ?? null) || strlen($payload['message']) > 500 || !zeroy_checkout_ref_name_valid($payload['refName']) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $payload['commitHash']) !== 1 || (!is_null($payload['expectedCommit'] ?? null) && (!is_string($payload['expectedCommit']) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $payload['expectedCommit']) !== 1))) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_request_invalid', 'Push request identity or bounds are invalid.', 400));
    $change_summary = zeroy_checkout_push_change_summary($payload['changeSummary'] ?? null);
    if (is_wp_error($change_summary)) return zeroy_runtime_response_error($change_summary);
    $payload['changeSummary'] = $change_summary;
    $request_fingerprint = [
        'checkoutId' => (string) ($payload['checkoutId'] ?? ''),
        'refName' => $payload['refName'],
        'expectedCommit' => is_string($payload['expectedCommit'] ?? null) ? $payload['expectedCommit'] : null,
        'commitHash' => $payload['commitHash'],
        'message' => (string) ($payload['message'] ?? ''),
        'changeSummary' => $payload['changeSummary'],
    ];
    $actual_request_hash = zeroy_checkout_push_request_hash($request_fingerprint);
    $existing = zeroy_checkout_push_receipt($payload['commandId']);
    if ($existing !== null) {
        if (!hash_equals($existing['requestHash'], $payload['requestHash']) || !hash_equals($actual_request_hash, $payload['requestHash'])) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_command_reused', 'commandId was already used for a different push request.', 409));
        $resumed = zeroy_checkout_complete_push($payload['commandId'], $payload['requestHash'], $existing['result'], (string) ($payload['message'] ?? ''));
        return is_wp_error($resumed) ? zeroy_runtime_response_error($resumed) : new WP_REST_Response($resumed);
    }
    if (!hash_equals($actual_request_hash, $payload['requestHash'])) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_request_hash_mismatch', 'requestHash does not bind the canonical push request.', 409, ['actualRequestHash' => $actual_request_hash]));
    global $wpdb;
    $accepted = static fn(): array|WP_Error => zeroy_runtime_transaction(static fn(): array|WP_Error => zeroy_checkout_accept_push($payload));
    $accepted = zeroy_runtime_uses_sqlite()
        ? zeroy_runtime_with_process_file_lock('site-ref', 'zeroy_site_ref_lock_unavailable', 'SiteCheckout ref mutation', $accepted)
        : $accepted();
    if (is_wp_error($accepted)) return zeroy_runtime_response_error($accepted);
    $result = zeroy_checkout_complete_push($payload['commandId'], $payload['requestHash'], $accepted, (string) ($payload['message'] ?? ''));
    if (is_wp_error($result)) return zeroy_runtime_response_error($result);
    return new WP_REST_Response($result, 201);
}

function zeroy_checkout_push_finalize_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_checkout_request_json($request);
    if (is_wp_error($payload)) return zeroy_runtime_response_error($payload);
    $command_id = $payload['commandId'] ?? null;
    $request_hash = $payload['requestHash'] ?? null;
    $release_id = $payload['releaseId'] ?? null;
    if (!is_string($command_id) || !is_string($request_hash) || !is_string($release_id) || !array_key_exists('browserEvidence', $payload)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_finalize_invalid', 'Push finalization requires commandId, requestHash, releaseId, and browserEvidence.', 400));
    $stored = zeroy_checkout_push_receipt($command_id);
    if ($stored === null || !hash_equals($stored['requestHash'], $request_hash)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_push_receipt_missing', 'Matching pending push receipt does not exist.', 409));
    $preview = is_array($stored['result']['preview'] ?? null) ? $stored['result']['preview'] : null;
    if (!is_array($preview) || ($preview['releaseId'] ?? null) !== $release_id) return new WP_REST_Response($stored['result']);
    $final = zeroy_checkout_finalize_preview($release_id, $payload['browserEvidence'], zeroy_checkout_owner_principal());
    if (is_wp_error($final)) return zeroy_runtime_response_error($final);
    $result = $stored['result'];
    $result['proof'] = $final['proof'];
    if (isset($final['preview'])) {
        $result['preview'] = $final['preview'];
    } else {
        unset($result['preview']['browserVerification']);
    }
    $build_id = (string) ($result['build']['buildId'] ?? '');
    if ($build_id === '') return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_build_result_missing', 'Push receipt did not identify its BuildResult.', 500));
    $review = zeroy_review_for_commit((string) $result['commit'], $build_id);
    if (is_wp_error($review)) return zeroy_runtime_response_error($review);
    $result['review'] = $review;
    $updated = zeroy_checkout_replace_push_receipt($command_id, $request_hash, $result);
    return is_wp_error($updated) ? zeroy_runtime_response_error($updated) : new WP_REST_Response($result);
}

function zeroy_checkout_workspace_projection_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $build_id = (string) $request['buildId'];
    $projection = zeroy_build_workspace_projection($build_id);
    return is_wp_error($projection)
        ? zeroy_runtime_response_error($projection)
        : new WP_REST_Response(['contract' => 'zeroy/workspace-projection@2', 'buildId' => $build_id, ...$projection]);
}

function zeroy_checkout_register_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site-checkout', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_source_endpoint']);
    register_rest_route('zeroy/v1', '/site-objects/have', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_checkout_have_endpoint']);
    register_rest_route('zeroy/v1', '/site-objects', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_checkout_upload_endpoint']);
    register_rest_route('zeroy/v1', '/site-objects/(?P<objectHash>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_object_endpoint']);
    register_rest_route('zeroy/v1', '/site-commits', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_checkout_commit_upload_endpoint']);
    register_rest_route('zeroy/v1', '/site-commits', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_commit_history_endpoint']);
    register_rest_route('zeroy/v1', '/site-commit-diff', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_commit_diff_endpoint']);
    register_rest_route('zeroy/v1', '/site-commits/(?P<commitHash>sha256:[0-9a-f]{64})', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_commit_endpoint']);
    register_rest_route('zeroy/v1', '/site-refs', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_refs_endpoint']);
    register_rest_route('zeroy/v1', '/site-push', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_checkout_push_endpoint']);
    register_rest_route('zeroy/v1', '/site-push/finalize', $permission + ['methods' => WP_REST_Server::CREATABLE, 'callback' => 'zeroy_checkout_push_finalize_endpoint']);
    register_rest_route('zeroy/v1', '/site-builds/(?P<buildId>sha256:[0-9a-f]{64})/workspace', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_checkout_workspace_projection_endpoint']);
}
add_action('rest_api_init', 'zeroy_checkout_register_routes');
