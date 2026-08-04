<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_REVIEW_CONTRACT = 'zeroy/review-result@1';
const ZEROY_SITE_REVIEW_MAX_NEXT = 3;
const ZEROY_SITE_REVIEW_HARD_MAX_NEXT = 5;

function zeroy_review_release_for_build(string $commit_hash, string $build_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare(
        'SELECT * FROM ' . zeroy_runtime_table('site_releases') . " WHERE commit_hash = %s AND build_id = %s AND state IN ('preview-awaiting-browser', 'preview', 'proof-ready') ORDER BY created_at DESC LIMIT 1",
        $commit_hash,
        $build_id,
    ), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_review_proof_for_release(array $release): ?array
{
    $proof_id = is_string($release['proof_id'] ?? null) ? $release['proof_id'] : '';
    if ($proof_id === '') return null;
    $row = zeroy_runtime_site_release_proof_row($proof_id);
    $proof = is_array($row) ? zeroy_runtime_decode_json((string) $row['proof_json']) : null;
    return is_array($proof) ? $proof : null;
}

function zeroy_review_route_lookup(array $release): array
{
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    if (is_wp_error($snapshot)) return [];
    $routes = [];
    foreach (zeroy_runtime_snapshot_scenarios($snapshot) as $scenario) {
        if (is_string($scenario['id'] ?? null)) $routes[$scenario['id']] = $scenario;
    }
    return $routes;
}

function zeroy_review_action(array $failure, array $routes = [], string $severity = 'blocking'): array
{
    $scenario = is_string($failure['scenario'] ?? null) ? $failure['scenario'] : null;
    $route = $scenario !== null && is_array($routes[$scenario] ?? null) ? $routes[$scenario] : null;
    $code = is_string($failure['code'] ?? null) ? $failure['code'] : 'review_failure';
    $subject = is_string($failure['subjectKey'] ?? null) ? $failure['subjectKey'] : null;
    $document = is_string($failure['documentPath'] ?? null) ? $failure['documentPath'] : null;
    $content = is_string($failure['contentPath'] ?? null) ? $failure['contentPath'] : null;
    $fingerprint = zeroy_runtime_hash([
        'code' => $code,
        'subject' => $subject,
        'document' => $document,
        'content' => $content,
        'scenario' => $scenario,
        'route' => is_array($route) ? ($route['path'] ?? null) : null,
        'locale' => is_array($route) ? ($route['locale'] ?? null) : ($failure['locale'] ?? null),
    ]);
    return array_filter([
        'fingerprint' => $fingerprint,
        'severity' => $severity,
        'summary' => $code,
        'evidence' => is_string($failure['evidence'] ?? null) ? $failure['evidence'] : (is_string($failure['message'] ?? null) ? $failure['message'] : 'Review failed.'),
        'repair' => is_string($failure['repair'] ?? null) ? $failure['repair'] : 'Repair the reported authored file and push again.',
        'route' => is_array($route) && is_string($route['path'] ?? null) ? $route['path'] : null,
        'locale' => is_array($route) && is_string($route['locale'] ?? null) ? $route['locale'] : (is_string($failure['locale'] ?? null) ? $failure['locale'] : null),
        'subject' => $subject,
        'documentPath' => $document,
        'contentPath' => $content,
    ], static fn(mixed $value): bool => $value !== null && $value !== '');
}

function zeroy_review_missing_brief_action(): array
{
    return [
        'fingerprint' => zeroy_runtime_hash(['code' => 'site_brief_missing']),
        'severity' => 'blocking',
        'summary' => 'site_brief_missing',
        'evidence' => 'No administrator-owned Site Brief is configured for this site.',
        'repair' => 'An administrator must save the business, page, locale, and design requirements in zeroY → Agent review before final publication.',
    ];
}

function zeroy_review_pending_browser_action(): array
{
    return [
        'fingerprint' => zeroy_runtime_hash(['code' => 'browser_evidence_pending']),
        'severity' => 'blocking',
        'summary' => 'browser_evidence_pending',
        'evidence' => 'The exact PreviewRelease is waiting for browser evidence.',
        'repair' => 'Run the Connector browser verifier for this Push before requesting final publication.',
    ];
}

function zeroy_review_sort_actions(array $actions): array
{
    $unique = [];
    foreach ($actions as $action) {
        if (!is_array($action) || !is_string($action['fingerprint'] ?? null)) continue;
        $unique[$action['fingerprint']] = $action;
    }
    $actions = array_values($unique);
    usort($actions, static function (array $left, array $right): int {
        $rank = static fn(array $action): int => ($action['severity'] ?? 'blocking') === 'blocking' ? 0 : 1;
        return [$rank($left), (string) ($left['summary'] ?? ''), (string) ($left['fingerprint'] ?? '')]
            <=> [$rank($right), (string) ($right['summary'] ?? ''), (string) ($right['fingerprint'] ?? '')];
    });
    return $actions;
}

/**
 * This is the only action generator. The compact ReviewResult and paginated
 * inspect views are two projections of the same Brief + Build + Proof facts;
 * neither stores an Agent-maintained task list.
 */
function zeroy_review_evaluate(
    string $commit_hash,
    array $build,
    array $diagnostics,
    ?array $release = null,
): array {
    $brief_projection = zeroy_review_brief_projection();
    $brief_hash = $brief_projection['briefHash'];
    $build_failures = array_values(array_filter($diagnostics['failures'] ?? [], 'is_array'));
    $routes = is_array($release) ? zeroy_review_route_lookup($release) : [];
    $actions = [];
    $state = 'revise';

    if (($build['state'] ?? null) === 'invalid') {
        foreach ($build_failures as $failure) $actions[] = zeroy_review_action($failure, $routes);
        $state = 'build-failed';
    } elseif ($release === null) {
        foreach ($build_failures as $failure) $actions[] = zeroy_review_action($failure, $routes);
        $actions[] = zeroy_review_pending_browser_action();
    } elseif (($release['state'] ?? null) === 'preview-awaiting-browser') {
        // The foundation proof is deliberately stored before browser evidence
        // arrives. It may have no deterministic failures, but it is not a
        // complete Proof and therefore cannot make a Preview publishable.
        $actions[] = zeroy_review_pending_browser_action();
    } else {
        $proof = zeroy_review_proof_for_release($release);
        if ($proof === null) {
            $actions[] = zeroy_review_pending_browser_action();
        } else {
            foreach (zeroy_runtime_site_release_proof_failures($proof) as $failure) {
                $actions[] = zeroy_review_action($failure, $routes);
            }
            foreach (is_array($proof['warnings'] ?? null) ? $proof['warnings'] : [] as $warning) {
                if (is_array($warning)) $actions[] = zeroy_review_action($warning, $routes, 'quality');
            }
            if (($release['state'] ?? null) === 'proof-ready' && ($proof['blockingFailures'] ?? []) === []) {
                $state = 'proof-ready';
            }
        }
    }

    if ($brief_hash === null) {
        $actions[] = zeroy_review_missing_brief_action();
        $state = 'revise';
    }
    $actions = zeroy_review_sort_actions($actions);
    $blocking_count = count(array_filter($actions, static fn(array $action): bool => ($action['severity'] ?? null) === 'blocking'));
    if ($blocking_count > 0 && $state === 'proof-ready') $state = 'revise';
    $proof = is_array($release) ? zeroy_review_proof_for_release($release) : null;
    return [
        'actions' => $actions,
        'result' => [
        'contract' => ZEROY_SITE_REVIEW_CONTRACT,
        'briefHash' => $brief_hash,
        'commitId' => $commit_hash,
        'buildId' => $build['buildId'] ?? null,
        'releaseId' => is_array($release) ? ($release['release_id'] ?? null) : null,
        'proofId' => is_array($release) ? ($release['proof_id'] ?: null) : null,
        'evaluatorVersion' => ZEROY_SITE_REVIEW_EVALUATOR_VERSION,
        'state' => $state,
        'preview' => is_array($release) ? ['releaseId' => $release['release_id'], 'url' => zeroy_runtime_admin_preview_url((string) $release['release_id'])] : null,
        'remainingCount' => $blocking_count,
        'next' => array_slice($actions, 0, ZEROY_SITE_REVIEW_MAX_NEXT),
        'evidence' => [
            'buildState' => $build['state'] ?? null,
            'proofState' => is_array($proof) && ($proof['blockingFailures'] ?? []) === [] ? 'verified' : (is_array($proof) ? 'blocked' : 'pending'),
            'totalActionCount' => count($actions),
        ],
        ],
    ];
}

function zeroy_review_result(
    string $commit_hash,
    array $build,
    array $diagnostics,
    ?array $release = null,
): array {
    return zeroy_review_evaluate($commit_hash, $build, $diagnostics, $release)['result'];
}

function zeroy_review_record(array $review): array|WP_Error
{
    $brief_hash = is_string($review['briefHash'] ?? null) ? $review['briefHash'] : '';
    $commit_hash = is_string($review['commitId'] ?? null) ? $review['commitId'] : '';
    $build_id = is_string($review['buildId'] ?? null) ? $review['buildId'] : '';
    $release_id = is_string($review['releaseId'] ?? null) ? $review['releaseId'] : '';
    if ($brief_hash === '' || $commit_hash === '' || $build_id === '') return $review;
    $review_id = zeroy_review_id($brief_hash, $commit_hash, $build_id, $release_id === '' ? null : $release_id);
    global $wpdb;
    $written = $wpdb->replace(zeroy_runtime_table('site_reviews'), [
        'review_id' => $review_id,
        'brief_hash' => $brief_hash,
        'commit_hash' => $commit_hash,
        'build_id' => $build_id,
        'release_id' => $release_id === '' ? null : $release_id,
        'evaluator_version' => ZEROY_SITE_REVIEW_EVALUATOR_VERSION,
        'state' => (string) $review['state'],
        'result_json' => zeroy_runtime_json($review),
        'created_at' => current_time('mysql', true),
    ]);
    return $written === false
        ? zeroy_runtime_error('zeroy_site_review_store_failed', $wpdb->last_error ?: 'Could not store Site Review.', 500)
        : $review;
}

function zeroy_review_id(string $brief_hash, string $commit_hash, string $build_id, ?string $release_id): string
{
    return zeroy_runtime_hash([
        'briefHash' => $brief_hash,
        'commitId' => $commit_hash,
        'buildId' => $build_id,
        'releaseId' => $release_id,
        'evaluatorVersion' => ZEROY_SITE_REVIEW_EVALUATOR_VERSION,
    ]);
}

/**
 * Publication reads the Review that was recorded when this exact preview
 * completed. It must not recalculate Review under a later administrator Brief:
 * that would let a changed publication contract borrow an old Proof.
 */
function zeroy_review_stored_for_release(array $release): ?array
{
    $brief_hash = is_string($release['review_brief_hash'] ?? null) ? $release['review_brief_hash'] : '';
    $commit_hash = is_string($release['commit_hash'] ?? null) ? $release['commit_hash'] : '';
    $build_id = is_string($release['build_id'] ?? null) ? $release['build_id'] : '';
    $release_id = is_string($release['release_id'] ?? null) ? $release['release_id'] : '';
    if ($brief_hash === '' || $commit_hash === '' || $build_id === '' || $release_id === '') return null;
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare(
        'SELECT result_json FROM ' . zeroy_runtime_table('site_reviews') . ' WHERE review_id = %s',
        zeroy_review_id($brief_hash, $commit_hash, $build_id, $release_id),
    ), ARRAY_A);
    $review = is_array($row) ? zeroy_runtime_decode_json((string) $row['result_json']) : null;
    return is_array($review) ? $review : null;
}

function zeroy_review_load_build(string $commit_hash, ?string $build_id = null): array|WP_Error
{
    $build = $build_id === null ? zeroy_build_compile($commit_hash) : null;
    if (is_wp_error($build)) return $build;
    if ($build === null) {
        $row = zeroy_build_row($build_id);
        if ($row === null) return zeroy_runtime_error('zeroy_build_missing', 'BuildResult does not exist.', 404, ['buildId' => $build_id]);
        $build = ['result' => zeroy_build_result_projection($row), 'diagnostics' => zeroy_build_diagnostics((string) $row['diagnostics_hash'])];
    }
    $result = is_array($build['result'] ?? null) ? $build['result'] : null;
    if ($result === null || ($result['commit'] ?? null) !== $commit_hash) {
        return zeroy_runtime_error('zeroy_build_commit_mismatch', 'BuildResult does not belong to the requested SiteCommit.', 409, ['commit' => $commit_hash, 'buildId' => $build_id]);
    }
    $diagnostics = is_array($build['diagnostics'] ?? null) ? $build['diagnostics'] : [];
    return ['build' => $result, 'diagnostics' => $diagnostics];
}

function zeroy_review_for_commit(string $commit_hash, ?string $build_id = null): array|WP_Error
{
    $loaded = zeroy_review_load_build($commit_hash, $build_id);
    if (is_wp_error($loaded)) return $loaded;
    $build = $loaded['build'];
    $release = zeroy_review_release_for_build($commit_hash, (string) $build['buildId']);
    $review = zeroy_review_result($commit_hash, $build, $loaded['diagnostics'], $release);
    return zeroy_review_record($review);
}

/**
 * Inspect pages action evidence instead of growing every mutation receipt.
 * The action set is re-derived from immutable Build/Proof facts at read time,
 * so a stale Issue record can never survive a repaired or regressed Commit.
 */
function zeroy_review_actions_for_commit(string $commit_hash, ?string $build_id = null): array|WP_Error
{
    $loaded = zeroy_review_load_build($commit_hash, $build_id);
    if (is_wp_error($loaded)) return $loaded;
    $build = $loaded['build'];
    $release = zeroy_review_release_for_build($commit_hash, (string) $build['buildId']);
    return zeroy_review_evaluate($commit_hash, $build, $loaded['diagnostics'], $release)['actions'];
}

function zeroy_review_proof_ready_for_release(array $release): bool
{
    $brief = zeroy_review_brief();
    if ($brief === null) return false;
    $review = zeroy_review_stored_for_release($release);
    return $review !== null
        && ($release['review_brief_hash'] ?? null) === zeroy_review_brief_hash($brief)
        && ($review['briefHash'] ?? null) === ($release['review_brief_hash'] ?? null)
        && ($review['releaseId'] ?? null) === ($release['release_id'] ?? null)
        && ($review['proofId'] ?? null) === ($release['proof_id'] ?? null)
        && ($review['state'] ?? null) === 'proof-ready';
}

function zeroy_review_workspace_projection(array $review): array
{
    $brief = zeroy_review_brief_projection();
    $next = is_array($review['next'] ?? null) ? $review['next'] : [];
    $lines = [
        '# zeroY review',
        '',
        'State: ' . (string) ($review['state'] ?? 'unknown'),
        'Commit: ' . (string) ($review['commitId'] ?? ''),
        'Remaining blocking actions: ' . (string) ($review['remainingCount'] ?? 0),
        '',
        'Read brief.json and review.json. Edit only authored roots. Push again after one coherent repair slice.',
    ];
    foreach ($next as $index => $action) {
        $lines[] = '';
        $lines[] = ($index + 1) . '. ' . (string) ($action['summary'] ?? 'review action');
        $lines[] = '   Evidence: ' . (string) ($action['evidence'] ?? '');
        $lines[] = '   Repair: ' . (string) ($action['repair'] ?? '');
    }
    return [
        '.zeroy/brief.json' => $brief,
        '.zeroy/review.json' => $review,
        '.zeroy/review.md' => implode("\n", $lines) . "\n",
    ];
}
