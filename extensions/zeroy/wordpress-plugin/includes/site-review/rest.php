<?php

defined('ABSPATH') || exit;

/**
 * A draft ref is a recovery pointer, not an Agent-owned task list. If a caller
 * has lost its ref name, the most recently advanced ref of this Connector
 * principal is the only defensible single-agent default.
 */
function zeroy_review_latest_ref_for_owner(string $owner_principal): ?array
{
    global $wpdb;
    $refs = zeroy_runtime_table('site_refs');
    $commits = zeroy_runtime_table('site_commits');
    $row = $wpdb->get_row($wpdb->prepare(
        "SELECT r.ref_name, r.commit_hash, r.revision, r.updated_at
         FROM {$refs} r JOIN {$commits} c ON c.commit_hash = r.commit_hash
         WHERE c.author_principal = %s
         ORDER BY r.updated_at DESC, r.ref_name ASC LIMIT 1",
        $owner_principal,
    ), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_review_resolve_commit(WP_REST_Request $request): array|WP_Error
{
    $commit = $request->get_param('commit');
    $draft_ref = $request->get_param('draftRef');
    if ($commit !== null) {
        if (!is_string($commit) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $commit) !== 1) {
            return zeroy_runtime_error('zeroy_site_review_commit_invalid', 'Review commit must be an exact SiteCommit hash.', 400, ['fieldId' => 'commit']);
        }
        $row = zeroy_checkout_commit_row($commit);
        if ($row === null || !hash_equals((string) $row['author_principal'], zeroy_checkout_owner_principal())) {
            return zeroy_runtime_error('zeroy_site_commit_missing', 'SiteCommit does not exist for this Connector principal.', 404, ['commit' => $commit]);
        }
        return ['commit' => $commit, 'draftRef' => null];
    }
    if ($draft_ref !== null) {
        if (!is_string($draft_ref) || !zeroy_checkout_ref_name_valid($draft_ref)) {
            return zeroy_runtime_error('zeroy_site_review_draft_ref_invalid', 'Review draftRef must identify one valid DraftRef.', 400, ['fieldId' => 'draftRef']);
        }
        $ref = zeroy_checkout_ref_row($draft_ref);
    } else {
        $ref = zeroy_review_latest_ref_for_owner(zeroy_checkout_owner_principal());
    }
    if ($ref === null) return ['commit' => null, 'draftRef' => null];
    $commit = zeroy_checkout_commit_row((string) $ref['commit_hash']);
    if ($commit === null || !hash_equals((string) $commit['author_principal'], zeroy_checkout_owner_principal())) {
        return zeroy_runtime_error('zeroy_site_ref_missing', 'DraftRef does not identify a SiteCommit owned by this Connector principal.', 404, ['draftRef' => $ref['ref_name'] ?? null]);
    }
    return ['commit' => (string) $ref['commit_hash'], 'draftRef' => (string) $ref['ref_name']];
}

function zeroy_review_release_summary(?array $release): ?array
{
    if ($release === null) return null;
    return [
        'releaseId' => (string) $release['release_id'],
        'commitId' => $release['commit_hash'] ?: null,
        'buildId' => $release['build_id'] ?: null,
        'state' => (string) $release['state'],
        'proofId' => $release['proof_id'] ?: null,
        'previewUrl' => in_array((string) $release['state'], ['preview-awaiting-browser', 'preview', 'proof-ready'], true)
            ? zeroy_runtime_admin_preview_url((string) $release['release_id'])
            : null,
        'createdAt' => (string) $release['created_at'],
        'activatedAt' => $release['activated_at'] ?: null,
    ];
}

function zeroy_review_current_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $resolved = zeroy_review_resolve_commit($request);
    if (is_wp_error($resolved)) return zeroy_runtime_response_error($resolved);
    $commit_hash = $resolved['commit'];
    $review = null;
    $preview = null;
    if (is_string($commit_hash)) {
        $review = zeroy_review_for_commit($commit_hash, is_string($request->get_param('buildId')) ? $request->get_param('buildId') : null);
        if (is_wp_error($review)) return zeroy_runtime_response_error($review);
        $preview = is_string($review['releaseId'] ?? null) ? zeroy_runtime_site_release_row($review['releaseId']) : null;
    }
    $active = zeroy_runtime_active_site_release();
    return new WP_REST_Response([
        'contract' => 'zeroy/site-review-current@1',
        'brief' => zeroy_review_brief_projection(),
        'draftRef' => $resolved['draftRef'],
        'commitId' => $commit_hash,
        'preview' => zeroy_review_release_summary($preview),
        'active' => zeroy_review_release_summary($active),
        'review' => $review,
    ]);
}

function zeroy_review_actions_projection(array $actions, int $limit, ?string $cursor): array|WP_Error
{
    $offset = zeroy_checkout_page_offset($cursor);
    if (is_wp_error($offset)) return $offset;
    $page = array_slice($actions, $offset, $limit);
    $has_more = count($actions) > $offset + $limit;
    return [
        'items' => $page,
        'nextCursor' => $has_more ? zeroy_checkout_page_cursor($offset + $limit) : null,
        'hasMore' => $has_more,
    ];
}

function zeroy_review_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $resolved = zeroy_review_resolve_commit($request);
    if (is_wp_error($resolved)) return zeroy_runtime_response_error($resolved);
    if (!is_string($resolved['commit'])) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_missing', 'No owned DraftRef exists yet. Checkout and push one site version first.', 404));
    $build_id = is_string($request->get_param('buildId')) ? $request->get_param('buildId') : null;
    $review = zeroy_review_for_commit($resolved['commit'], $build_id);
    if (is_wp_error($review)) return zeroy_runtime_response_error($review);
    $view = is_string($request->get_param('view')) ? $request->get_param('view') : 'summary';
    if (!in_array($view, ['summary', 'actions'], true)) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_view_invalid', 'Review view must be summary or actions.', 400, ['fieldId' => 'view']));
    if ($view === 'summary') return new WP_REST_Response(['contract' => 'zeroy/site-review-projection@1', 'draftRef' => $resolved['draftRef'], 'review' => $review]);
    $actions = zeroy_review_actions_for_commit($resolved['commit'], $build_id);
    if (is_wp_error($actions)) return zeroy_runtime_response_error($actions);
    $page = zeroy_review_actions_projection($actions, min(50, max(1, (int) ($request->get_param('limit') ?: 20))), is_string($request->get_param('cursor')) ? $request->get_param('cursor') : null);
    return is_wp_error($page)
        ? zeroy_runtime_response_error($page)
        : new WP_REST_Response(['contract' => 'zeroy/site-review-actions@1', 'draftRef' => $resolved['draftRef'], 'review' => $review, 'actionCount' => count($actions), ...$page]);
}

function zeroy_review_workspace_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $resolved = zeroy_review_resolve_commit($request);
    if (is_wp_error($resolved)) return zeroy_runtime_response_error($resolved);
    if (!is_string($resolved['commit'])) return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_missing', 'No owned DraftRef exists yet.', 404));
    $build_id = $request->get_param('buildId');
    if (!is_string($build_id) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $build_id) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_build_invalid', 'Review workspace projection requires the exact BuildResult id.', 400, ['fieldId' => 'buildId']));
    }
    $review = zeroy_review_for_commit($resolved['commit'], $build_id);
    if (is_wp_error($review)) return zeroy_runtime_response_error($review);
    return new WP_REST_Response([
        'contract' => 'zeroy/site-review-workspace@1',
        'commitId' => $resolved['commit'],
        'buildId' => $build_id,
        'files' => zeroy_review_workspace_projection($review),
    ]);
}

/**
 * ActiveRelease and the system bootstrap are shared starting points, not
 * private Agent drafts. Their checkout needs Brief and instructions, but they
 * cannot truthfully claim to have an owner-specific ReviewResult yet.
 */
function zeroy_review_baseline_commit(): string|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    if ($active !== null) {
        $commit = (string) ($active['commit_hash'] ?? '');
        if (preg_match('/\Asha256:[a-f0-9]{64}\z/', $commit) === 1) return $commit;
        return zeroy_runtime_error('zeroy_active_site_release_invalid', 'Active SiteRelease does not identify an exact SiteCommit.', 500);
    }
    return zeroy_checkout_seed_bootstrap_commit();
}

function zeroy_review_baseline_workspace_projection(string $commit, string $build_id): array
{
    $review = [
        'contract' => 'zeroy/review-onboarding@1',
        'state' => 'onboarding',
        'commitId' => $commit,
        'buildId' => $build_id,
        'next' => [[
            'severity' => 'blocking',
            'summary' => 'Create the first agent-owned site version.',
            'evidence' => 'This checkout starts from the public or bootstrap baseline, so no private DraftRef or ReviewResult exists yet.',
            'repair' => 'Read the Brief and WorkspaceContract, make one coherent implementation slice, then push the checkout.',
        ]],
    ];
    return [
        '.zeroy/brief.json' => zeroy_review_brief_projection(),
        '.zeroy/review.json' => $review,
        '.zeroy/review.md' => implode("\n", [
            '# zeroY onboarding',
            '',
            'This is an ActiveRelease/bootstrap baseline, not an Agent-owned draft.',
            'Read brief.json and the WorkspaceContract. Make one coherent implementation slice and push it.',
            'After the first push, review.json becomes the exact derived ReviewResult for that owned Commit.',
            '',
        ]),
    ];
}

function zeroy_review_baseline_workspace_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $commit = $request->get_param('commit');
    $build_id = $request->get_param('buildId');
    if (!is_string($commit) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $commit) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_commit_invalid', 'Baseline workspace requires an exact SiteCommit hash.', 400, ['fieldId' => 'commit']));
    }
    if (!is_string($build_id) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $build_id) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_build_invalid', 'Baseline workspace requires the exact BuildResult id.', 400, ['fieldId' => 'buildId']));
    }
    $baseline = zeroy_review_baseline_commit();
    if (is_wp_error($baseline)) return zeroy_runtime_response_error($baseline);
    if (!hash_equals($baseline, $commit)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_baseline_changed', 'Requested Commit is not the current ActiveRelease/bootstrap baseline.', 409, ['commit' => $commit]));
    }
    $build = zeroy_build_row($build_id);
    if ($build === null || !hash_equals((string) $build['commit_hash'], $commit)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_site_review_build_mismatch', 'BuildResult does not belong to the requested baseline Commit.', 409, ['commit' => $commit, 'buildId' => $build_id]));
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/site-review-baseline-workspace@1',
        'commitId' => $commit,
        'buildId' => $build_id,
        'files' => zeroy_review_baseline_workspace_projection($commit, $build_id),
    ]);
}

function zeroy_review_register_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site-review/current', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_review_current_endpoint']);
    register_rest_route('zeroy/v1', '/site-review', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_review_endpoint']);
    register_rest_route('zeroy/v1', '/site-review/workspace', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_review_workspace_endpoint']);
    register_rest_route('zeroy/v1', '/site-review/baseline-workspace', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_review_baseline_workspace_endpoint']);
}
add_action('rest_api_init', 'zeroy_review_register_routes');
