<?php

defined('ABSPATH') || exit;

function zeroy_site_release_acceptance_assert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

/**
 * SiteRelease receipts intentionally expose only a compact proof summary.
 * Assertions about individual static/runtime checks must read the immutable
 * proof row by receipt proofId, which is the same read boundary available to
 * a Connector client through zeroy_inspect resource proof.
 */
function zeroy_site_release_acceptance_proof(array $receipt): array
{
    $proof_id = $receipt['proofId'] ?? null;
    zeroy_site_release_acceptance_assert(is_string($proof_id) && $proof_id !== '', 'Candidate receipt did not identify its VerificationProof.');
    $row = zeroy_runtime_site_release_proof_row($proof_id);
    zeroy_site_release_acceptance_assert(is_array($row), 'Candidate VerificationProof was not persisted.');
    $proof = zeroy_runtime_decode_json((string) $row['proof_json']);
    zeroy_site_release_acceptance_assert(is_array($proof), 'Candidate VerificationProof is not readable JSON.');
    return $proof;
}

function zeroy_site_release_acceptance_archive(string $directory, string $contract, array $overrides = []): array
{
    $entries = [];
    $contents = [];
    $root = rtrim(wp_normalize_path($directory), '/');
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
    foreach ($iterator as $file) {
        zeroy_site_release_acceptance_assert($file instanceof SplFileInfo && $file->isFile() && !$file->isLink(), 'Acceptance fixture contains an unsafe source file.');
        $path = ltrim(substr(wp_normalize_path($file->getPathname()), strlen($root)), '/');
        $bytes = $overrides[$path] ?? file_get_contents($file->getPathname());
        zeroy_site_release_acceptance_assert(is_string($bytes), 'Acceptance fixture file is unreadable.');
        $contents[$path] = $bytes;
        $entries[] = ['path' => $path, 'hash' => hash('sha256', $bytes), 'bytes' => strlen($bytes), 'mode' => $file->isExecutable() ? 'executable' : 'file'];
    }
    usort($entries, static fn(array $left, array $right): int => strcmp($left['path'], $right['path']));
    $tar_path = tempnam(sys_get_temp_dir(), 'zeroy-site-release-acceptance-');
    zeroy_site_release_acceptance_assert(is_string($tar_path), 'Could not create acceptance archive staging.');
    unlink($tar_path);
    $tar_path .= '.tar';
    try {
        $archive = new PharData($tar_path);
        foreach ($entries as $entry) $archive->addFromString($entry['path'], $contents[$entry['path']]);
        $archive->compress(Phar::GZ);
        $bytes = file_get_contents($tar_path . '.gz');
        zeroy_site_release_acceptance_assert(is_string($bytes), 'Could not read acceptance archive.');
        return ['manifest' => ['contract' => $contract, 'entries' => $entries], 'archiveBase64' => base64_encode($bytes)];
    } finally {
        if (is_file($tar_path)) unlink($tar_path);
        if (is_file($tar_path . '.gz')) unlink($tar_path . '.gz');
    }
}

$root = dirname(__DIR__);
$fixture_schema = zeroy_runtime_decode_json((string) file_get_contents($root . '/test-suite/fixtures/site-theme/zeroy.schema.json'));
zeroy_site_release_acceptance_assert(is_array($fixture_schema) && is_array($fixture_schema['schemas']['home'] ?? null), 'Acceptance fixture has no front-page schema.');
$fixture_home = null;
$fixture_home_ids = get_posts([
    'post_type' => 'page',
    'post_status' => ['publish', 'draft', 'private'],
    'posts_per_page' => -1,
    'fields' => 'ids',
    'meta_key' => ZEROY_RUNTIME_SCHEMA_META,
    'meta_value' => 'home',
]);
foreach ($fixture_home_ids as $id) {
    $canonical = zeroy_runtime_canonical((int) $id);
    if (!is_wp_error($canonical) && $canonical['route'] === '') {
        $fixture_home = $canonical;
        break;
    }
}
if ($fixture_home === null) {
    $fixture_home = zeroy_runtime_create_canonical('page', 'home', $fixture_schema['schemas']['home'], '/', 'Acceptance home', 'Acceptance front-page content', '', [
        'hero_title' => 'Acceptance home',
        'hero_subtitle' => 'Candidate verification baseline.',
        'cta_title' => 'Contact us',
    ]);
}
zeroy_site_release_acceptance_assert(!is_wp_error($fixture_home), 'Could not create the required acceptance front page.');
$theme = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-theme', ZEROY_THEME_MANIFEST_CONTRACT);
$logic = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT);
$theme_stored = zeroy_runtime_materialize_artifact_archive($theme['manifest'], $theme['archiveBase64']);
$logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($logic['manifest'], $logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($theme_stored) && !is_wp_error($logic_stored), 'Could not materialize SiteRelease acceptance artifacts.');
$active = zeroy_runtime_active_site_release();
$expected_active_release_id = is_array($active) ? (string) $active['active_release_id'] : null;
$bootstrap = zeroy_runtime_prepare_site_release((string) $theme_stored['artifactId'], (string) $logic_stored['artifactId'], $expected_active_release_id, ['source' => 'acceptance-bootstrap']);
zeroy_site_release_acceptance_assert(!is_wp_error($bootstrap) && ($bootstrap['state'] ?? null) === 'prepared', 'Could not prepare the snapshot acceptance baseline: ' . (is_wp_error($bootstrap) ? $bootstrap->get_error_code() . ' ' . $bootstrap->get_error_message() . ' ' . wp_json_encode($bootstrap->get_error_data()) : wp_json_encode($bootstrap['diagnostics']['proof']['blockingFailures'] ?? [])));
$bootstrap_active = zeroy_runtime_activate_site_release((string) $bootstrap['releaseId']);
zeroy_site_release_acceptance_assert(!is_wp_error($bootstrap_active), 'Could not activate the snapshot acceptance baseline.');
$active = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(is_array($active) && ($active['snapshot_hash'] ?? '') !== '', 'Acceptance baseline has no immutable snapshot.');
$baseline_snapshot = zeroy_runtime_site_release_snapshot($active);
zeroy_site_release_acceptance_assert(!is_wp_error($baseline_snapshot), 'Acceptance baseline has no readable DraftSnapshot.');
$baseline_scenarios = zeroy_runtime_snapshot_scenarios($baseline_snapshot);
$external_targets = zeroy_runtime_site_release_external_check_targets_endpoint()->get_data();
zeroy_site_release_acceptance_assert(
    ($external_targets['contract'] ?? null) === 'zeroy/site-release-external-targets@1'
    && ($external_targets['releaseId'] ?? null) === $active['active_release_id']
    && ($external_targets['scenarioSetHash'] ?? null) === zeroy_runtime_hash($baseline_scenarios)
    && count($external_targets['targets'] ?? []) === count($baseline_scenarios)
    && count(array_filter($external_targets['targets'] ?? [], static fn(mixed $target): bool => is_array($target) && ($target['routeKind'] ?? null) === 'search')) > 0
    && count(array_filter($external_targets['targets'] ?? [], static fn(mixed $target): bool => is_array($target) && ($target['routeKind'] ?? null) === 'not-found' && ($target['expectedStatus'] ?? null) === 404)) > 0,
    'External checks do not consume the exact active CandidateProof route scenario set.'
);
$base_release_id = $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];
$site_handshake = zeroy_runtime_site_endpoint()->get_data();
zeroy_site_release_acceptance_assert(
    !array_key_exists('siteLogicAuthoring', $site_handshake)
    && !array_key_exists('siteLogicBootstrap', $site_handshake)
    && !array_key_exists('siteLogic', $site_handshake['themeAuthoring']['artifact'] ?? []),
    'Site inspection exposed connector-owned SiteLogic as Agent authoring surface.',
);
$theme_list_request = new WP_REST_Request('GET', '/zeroy/v1/site-artifacts/theme/files');
$theme_list_request->set_param('artifact', 'theme');
$theme_list = zeroy_runtime_site_artifact_files_endpoint($theme_list_request)->get_data();
zeroy_site_release_acceptance_assert(
    ($theme_list['contract'] ?? null) === 'zeroy/site-artifact-file-list@1'
    && ($theme_list['artifact'] ?? null) === 'theme'
    && is_array($theme_list['files'] ?? null)
    && count(array_filter($theme_list['files'], static fn(mixed $entry): bool => is_array($entry) && ($entry['path'] ?? null) === 'style.css')) === 1,
    'Remote theme file inspection did not return the active artifact manifest.'
);
$theme_read_request = new WP_REST_Request('GET', '/zeroy/v1/site-artifacts/theme/files');
$theme_read_request->set_param('artifact', 'theme');
$theme_read_request->set_param('path', 'style.css');
$theme_read = zeroy_runtime_site_artifact_files_endpoint($theme_read_request)->get_data();
zeroy_site_release_acceptance_assert(
    ($theme_read['contract'] ?? null) === 'zeroy/site-artifact-file@1' && is_string($theme_read['content'] ?? null),
    'Remote theme file inspection did not return requested source bytes.'
);
$draft_owner = 'site-release-acceptance';
$new_draft = static function (string $base_release_id) use ($draft_owner): array {
    $draft = zeroy_runtime_create_site_draft($base_release_id, $draft_owner);
    zeroy_site_release_acceptance_assert(!is_wp_error($draft), 'Could not create SiteDraft for acceptance.');
    return $draft;
};
$empty_draft = static function (string $base_release_id) use ($new_draft): string {
    return (string) $new_draft($base_release_id)['draftId'];
};

// A stale artifact hash must fail while staging. It cannot be deferred to a
// later CandidateProof, because subsequent Draft operations need the receipt's
// returned hash as their sole remote precondition.
$hash_conflict_draft = $new_draft($base_release_id);
$hash_conflict = zeroy_runtime_append_site_draft_operation((string) $hash_conflict_draft['draftId'], [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [['path' => 'style.css', 'content' => '/* invalid stale write */', 'expectedHash' => str_repeat('0', 64)]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    is_wp_error($hash_conflict) && $hash_conflict->get_error_code() === 'zeroy_site_artifact_hash_conflict',
    'SiteDraft accepted an artifact edit whose expected hash did not match the base or prior staged bytes.',
);
$foreign_owner_stage = zeroy_runtime_append_site_draft_operation(
    (string) $hash_conflict_draft['draftId'],
    ['kind' => 'artifact.files', 'payload' => ['artifact' => 'theme', 'files' => [['path' => '__foreign-owner.php', 'content' => "<?php\n", 'expectedHash' => null]]]],
    'different-pi-session',
);
zeroy_site_release_acceptance_assert(
    is_wp_error($foreign_owner_stage)
    && $foreign_owner_stage->get_error_code() === 'zeroy_site_draft_missing'
    && ((zeroy_runtime_site_draft_row((string) $hash_conflict_draft['draftId'])['operations_json'] ?? '') === zeroy_runtime_json([])),
    'A different Pi session could append to an existing remote SiteDraft.',
);
$foreign_candidate_read = new WP_REST_Request('GET', '/zeroy/v1/existing-post');
$foreign_candidate_read->set_param('draftId', (string) $hash_conflict_draft['draftId']);
$foreign_candidate_read->set_param('schemaId', 'home');
$foreign_candidate_read->set_header('x-zeroy-draft-owner', 'different-pi-session');
$foreign_candidate = zeroy_runtime_existing_post_candidate_definition($foreign_candidate_read, 'home');
zeroy_site_release_acceptance_assert(
    is_wp_error($foreign_candidate) && $foreign_candidate->get_error_code() === 'zeroy_site_draft_missing',
    'A different Pi session could inspect an existing post through another Draft candidate contract.',
);

// The remote owner rejects malformed wire operations before they enter a
// Draft. A stage receipt must never acknowledge a compatibility alias that
// will only fail later during candidate compilation.
$invalid_operation = zeroy_runtime_validate_site_draft_operation([
    'kind' => 'createCanonical',
    'payload' => ['ref' => 'invalid', 'postType' => 'page', 'schemaId' => 'showcase', 'unexpectedAlias' => '/invalid'],
]);
zeroy_site_release_acceptance_assert(
    is_wp_error($invalid_operation) && $invalid_operation->get_error_code() === 'zeroy_site_draft_operation_invalid',
    'SiteDraft admitted a malformed or compatibility-alias operation.'
);

// ThemeWorkspace replacement must be algebraically complete: an Agent can
// create and then delete an obsolete file without leaving it in the artifact.
$obsolete_path = '__zeroy-obsolete-probe.php';
$obsolete_content = "<?php\n// obsolete acceptance probe\n";
$deletion_draft = $new_draft($base_release_id);
$replay_probe_path = '__zeroy-replay-probe.php';
$replay_probe_content = "<?php\n// replay acceptance probe\n";
$replay_source = $new_draft($base_release_id);
$replay_source_id = (string) $replay_source['draftId'];
$replay_staged = zeroy_runtime_append_site_draft_operation($replay_source_id, [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [['path' => $replay_probe_path, 'content' => $replay_probe_content, 'expectedHash' => null]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($replay_staged)
    && (($replay_staged['lastArtifactFiles'][0]['hash'] ?? null) === hash('sha256', $replay_probe_content)),
    'Artifact stage receipt did not return the exact next hash for remote incremental editing.'
);
foreach ([
    ['kind' => 'artifact.files', 'payload' => ['artifact' => 'theme', 'files' => [['path' => $obsolete_path, 'content' => $obsolete_content, 'expectedHash' => null]]]],
    ['kind' => 'artifact.files', 'payload' => ['artifact' => 'theme', 'files' => [['path' => $obsolete_path, 'content' => null, 'expectedHash' => hash('sha256', $obsolete_content)]]]],
] as $operation) {
    $appended = zeroy_runtime_append_site_draft_operation((string) $deletion_draft['draftId'], $operation, $draft_owner);
    zeroy_site_release_acceptance_assert(!is_wp_error($appended), 'Could not stage ThemeWorkspace deletion probe.');
}
$deletion_commit = zeroy_runtime_commit_site_draft((string) $deletion_draft['draftId'], $base_release_id, 'exercise ThemeWorkspace deletion', $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($deletion_commit), 'Could not commit ThemeWorkspace deletion probe: ' . (is_wp_error($deletion_commit) ? $deletion_commit->get_error_message() : ''));
$active = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(is_array($active) && !is_file(zeroy_runtime_artifact_directory((string) $active['theme_artifact_id']) . '/' . $obsolete_path), 'Deleted ThemeWorkspace file survived in the active artifact.');
$base_release_id = (string) $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];

// A stale Draft has one recovery path: replay its full immutable log against
// the new base. It must neither rewrite optimistic guards nor move Active
// SiteRelease; conflicts remain explicit instead of becoming last-writer-wins.
$active_before_replay = $base_release_id;
$replayed = zeroy_runtime_replay_site_draft($replay_source_id, $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($replayed)
    && ($replayed['state'] ?? null) === 'open'
    && ($replayed['baseReleaseId'] ?? null) === $base_release_id
    && ($replayed['replayedFromDraftId'] ?? null) === $replay_source_id
    && ($replayed['operationSummaries'] ?? null) === ($replay_staged['operationSummaries'] ?? null),
    'Stale SiteDraft replay did not produce one equivalent open Draft on the current active base.'
);
zeroy_site_release_acceptance_assert(
    !str_contains(wp_json_encode($replay_staged['operationSummaries'] ?? []), $replay_probe_content),
    'SiteDraft receipt leaked staged source bytes instead of returning an operation summary.'
);
$replayed_source = zeroy_runtime_site_draft_row($replay_source_id);
zeroy_site_release_acceptance_assert(
    is_array($replayed_source)
    && ($replayed_source['state'] ?? null) === 'replayed'
    && ((zeroy_runtime_active_site_release()['active_release_id'] ?? null) === $active_before_replay),
    'Replaying a stale SiteDraft did not close only its source Draft or changed the active release.'
);

// Replay is deliberately not a merge. If the current base changed the same
// artifact file, the original expected hash remains authoritative, the source
// stays open, and the diagnostic preserves the exact conflicting fact.
$replay_conflict_style = (string) file_get_contents(zeroy_runtime_artifact_directory($baseline_theme_artifact_id) . '/style.css');
$replay_conflict_hash = hash('sha256', $replay_conflict_style);
$replay_conflict_source = $new_draft($base_release_id);
$replay_conflict_source_id = (string) $replay_conflict_source['draftId'];
$replay_conflict_staged = zeroy_runtime_append_site_draft_operation($replay_conflict_source_id, [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [[
        'path' => 'style.css',
        'content' => $replay_conflict_style . "\n/* stale replay source */\n",
        'expectedHash' => $replay_conflict_hash,
    ]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($replay_conflict_staged), 'Could not stage the stale replay conflict source.');
$replay_conflict_advance = $new_draft($base_release_id);
$replay_conflict_advance_id = (string) $replay_conflict_advance['draftId'];
$replay_conflict_advanced = zeroy_runtime_append_site_draft_operation($replay_conflict_advance_id, [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [[
        'path' => 'style.css',
        'content' => $replay_conflict_style . "\n/* active replacement */\n",
        'expectedHash' => $replay_conflict_hash,
    ]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($replay_conflict_advanced), 'Could not stage the replay conflict base advance.');
$replay_conflict_commit = zeroy_runtime_commit_site_draft($replay_conflict_advance_id, $base_release_id, 'advance a conflicting artifact base', $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($replay_conflict_commit), 'Could not activate the replay conflict base advance.');
$active = zeroy_runtime_active_site_release();
$base_release_id = (string) $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];
$replay_conflict = zeroy_runtime_replay_site_draft($replay_conflict_source_id, $draft_owner);
zeroy_site_release_acceptance_assert(
    is_wp_error($replay_conflict)
    && $replay_conflict->get_error_code() === 'zeroy_site_draft_replay_conflict'
    && (($replay_conflict->get_error_data()['cause']['code'] ?? null) === 'zeroy_site_artifact_hash_conflict')
    && ((zeroy_runtime_site_draft_row($replay_conflict_source_id)['state'] ?? null) === 'open')
    && ((zeroy_runtime_active_site_release()['active_release_id'] ?? null) === $base_release_id),
    'SiteDraft replay silently changed a conflicting artifact precondition or changed the active release.'
);

// SiteLogic is not an implicit base-release dependency. It follows exactly
// the same Draft operation algebra as Theme, then becomes visible only in the
// SiteRelease activated by the shared commit.
$logic_probe_path = '__zeroy-site-logic-probe.php';
$logic_probe_content = "<?php\ndefined('ABSPATH') || exit;\n";
$logic_draft = $new_draft($base_release_id);
$logic_staged = zeroy_runtime_append_site_draft_operation((string) $logic_draft['draftId'], [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'site-logic', 'files' => [['path' => $logic_probe_path, 'content' => $logic_probe_content, 'expectedHash' => null]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($logic_staged), 'Could not stage a SiteLogicArtifact file.');
$logic_commit = zeroy_runtime_commit_site_draft((string) $logic_draft['draftId'], $base_release_id, 'exercise SiteLogic Draft ownership', $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($logic_commit), 'Could not commit staged SiteLogicArtifact file: ' . (is_wp_error($logic_commit) ? $logic_commit->get_error_message() : ''));
$active = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(
    is_array($active)
    && (string) $active['site_logic_artifact_id'] !== $baseline_logic_artifact_id
    && is_file(zeroy_runtime_site_logic_directory((string) $active['site_logic_artifact_id']) . '/' . $logic_probe_path),
    'Committed SiteRelease did not bind the staged SiteLogicArtifact.',
);
$base_release_id = (string) $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];

// Revision is a projection of the appended operation, never a client-side
// guess. A failed prospective operation must leave the immutable log exactly
// as it was, while the returned revision must be accepted by the next stage.
$revision_receipt_draft = $new_draft($base_release_id);
$revision_receipt_draft_id = (string) $revision_receipt_draft['draftId'];
$revision_created = zeroy_runtime_append_site_draft_operation($revision_receipt_draft_id, [
    'kind' => 'createCanonical',
    'payload' => [
        'ref' => 'revision-receipt-probe',
        'postType' => 'page',
        'schemaId' => 'showcase',
        'route' => 'revision-receipt-probe',
        'postTitle' => 'Revision receipt probe',
        'postContent' => 'This staged post verifies revision receipts.',
        'templateContent' => [
            'title' => 'Revision receipt probe',
            'intro' => 'The next revision comes from the Draft receipt.',
        ],
    ],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($revision_created)
    && (($revision_created['lastOperation']['kind'] ?? null) === 'createCanonical')
    && (($revision_created['lastOperation']['nextRevision'] ?? null) === 1),
    'createCanonical did not return the exact next canonical revision.',
);
$revision_stale = zeroy_runtime_append_site_draft_operation($revision_receipt_draft_id, [
    'kind' => 'writeTemplateContent',
    'payload' => [
        'objectRef' => 'revision-receipt-probe',
        'templateContent' => ['title' => 'This stale operation must not persist'],
        'expectedRevision' => 0,
    ],
], $draft_owner);
$revision_after_stale = zeroy_runtime_site_draft_row($revision_receipt_draft_id);
zeroy_site_release_acceptance_assert(
    is_wp_error($revision_stale)
    && $revision_stale->get_error_code() === 'zeroy_canonical_conflict'
    && is_array($revision_after_stale)
    && count(zeroy_runtime_site_draft_operations($revision_after_stale)) === 1,
    'A stale content revision entered the Draft operation log instead of failing at stage.',
);
$revision_template = zeroy_runtime_append_site_draft_operation($revision_receipt_draft_id, [
    'kind' => 'writeTemplateContent',
    'payload' => [
        'objectRef' => 'revision-receipt-probe',
        'templateContent' => ['title' => 'Receipt revision accepted'],
        'expectedRevision' => $revision_created['lastOperation']['nextRevision'],
    ],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($revision_template)
    && (($revision_template['lastOperation']['nextRevision'] ?? null) === 2),
    'The canonical revision returned by the preceding receipt was not accepted by the next stage.',
);
$revision_canonical = zeroy_runtime_append_site_draft_operation($revision_receipt_draft_id, [
    'kind' => 'writeCanonicalContent',
    'payload' => [
        'objectRef' => 'revision-receipt-probe',
        'postContent' => 'The receipt-chain stage was accepted.',
        'expectedRevision' => $revision_template['lastOperation']['nextRevision'],
    ],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($revision_canonical)
    && (($revision_canonical['lastOperation']['nextRevision'] ?? null) === 3),
    'A revision receipt did not chain through multiple canonical mutations.',
);
zeroy_runtime_discard_site_draft($revision_receipt_draft_id, $draft_owner);

// Every LocalizableSubject uses the same Draft operation algebra. SiteCopy and
// taxonomy terms must not fall through the post-only identity path.
$auxiliary_snapshot = zeroy_runtime_site_release_snapshot($active);
zeroy_site_release_acceptance_assert(!is_wp_error($auxiliary_snapshot), 'Could not read the auxiliary-subject baseline snapshot.');
$auxiliary_locale = null;
foreach ($auxiliary_snapshot['siteConfig']['enabledLocales'] as $locale_config) {
    if ($locale_config['locale'] !== $auxiliary_snapshot['siteConfig']['defaultLocale']) {
        $auxiliary_locale = $locale_config['locale'];
        break;
    }
}
$term_entry = array_values($auxiliary_snapshot['terms'])[0] ?? null;
zeroy_site_release_acceptance_assert(is_string($auxiliary_locale) && is_array($term_entry), 'Acceptance needs one non-default locale and one projected taxonomy term.');
$auxiliary_draft = $new_draft($base_release_id);
$site_config = $auxiliary_snapshot['siteConfig'];
$site_config_revision = (int) $site_config['revision'];
unset($site_config['revision']);
$site_config['siteCopy']['acceptance_label'] = 'Acceptance label';
$auxiliary_operations = [
    ['kind' => 'siteConfig', 'payload' => ['siteConfig' => $site_config, 'expectedRevision' => $site_config_revision]],
    ['kind' => 'writeTranslationDraft', 'payload' => ['subject' => ['kind' => 'site-copy', 'id' => 'default'], 'locale' => $auxiliary_locale, 'values' => ['/site-copy/acceptance_label' => '验收标签'], 'expectedRevision' => (int) $auxiliary_snapshot['siteCopy']['locales'][$auxiliary_locale]['revision']]],
    ['kind' => 'publishTranslation', 'payload' => ['subject' => ['kind' => 'site-copy', 'id' => 'default'], 'locale' => $auxiliary_locale, 'expectedRevision' => (int) $auxiliary_snapshot['siteCopy']['locales'][$auxiliary_locale]['revision'] + 1]],
    ['kind' => 'writeTranslationDraft', 'payload' => ['subject' => $term_entry['subject'], 'locale' => $auxiliary_locale, 'values' => ['/term/name' => '验收分类'], 'expectedRevision' => (int) $term_entry['locales'][$auxiliary_locale]['revision']]],
    ['kind' => 'publishTranslation', 'payload' => ['subject' => $term_entry['subject'], 'locale' => $auxiliary_locale, 'expectedRevision' => (int) $term_entry['locales'][$auxiliary_locale]['revision'] + 1]],
];
foreach ($auxiliary_operations as $operation) {
    $appended = zeroy_runtime_append_site_draft_operation((string) $auxiliary_draft['draftId'], $operation, $draft_owner);
    zeroy_site_release_acceptance_assert(!is_wp_error($appended), 'Could not stage an auxiliary LocalizableSubject operation: ' . (is_wp_error($appended) ? $appended->get_error_message() : ''));
}
$auxiliary_commit = zeroy_runtime_commit_site_draft((string) $auxiliary_draft['draftId'], $base_release_id, 'exercise auxiliary LocalizableSubjects', $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($auxiliary_commit), 'Could not commit SiteCopy and term translations: ' . (is_wp_error($auxiliary_commit) ? $auxiliary_commit->get_error_message() . ' ' . wp_json_encode($auxiliary_commit->get_error_data()) : ''));
$active = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(is_array($active), 'Auxiliary LocalizableSubject commit did not activate.');
$auxiliary_snapshot = zeroy_runtime_site_release_snapshot($active);
zeroy_site_release_acceptance_assert(
    !is_wp_error($auxiliary_snapshot)
    && ($auxiliary_snapshot['siteCopy']['locales'][$auxiliary_locale]['view']['siteCopy']['acceptance_label'] ?? null) === '验收标签'
    && (($auxiliary_snapshot['terms'][array_key_first($auxiliary_snapshot['terms'])]['locales'][$auxiliary_locale]['view']['term']['name'] ?? null) === '验收分类'),
    'Committed snapshot did not preserve auxiliary LocalizableSubject translations.'
);
$base_release_id = (string) $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];

$retirement_post = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'Canonical retirement probe',
    'post_content' => 'This WordPress post must survive zeroY retirement.',
], true);
zeroy_site_release_acceptance_assert(!is_wp_error($retirement_post), 'Could not create canonical retirement probe.');
$retirement_projection = zeroy_runtime_existing_unmanaged_post((int) $retirement_post);
zeroy_site_release_acceptance_assert(!is_wp_error($retirement_projection), 'Could not project canonical retirement probe.');
$retirement_draft = $new_draft($base_release_id);
foreach ([
    ['kind' => 'adoptCanonical', 'payload' => ['postId' => (int) $retirement_post, 'schemaId' => 'showcase', 'route' => 'retirement-probe', 'expectedSourceHash' => $retirement_projection['sourceHash']]],
    ['kind' => 'retireCanonical', 'payload' => ['objectId' => (int) $retirement_post, 'expectedRevision' => 1]],
] as $operation) {
    $appended = zeroy_runtime_append_site_draft_operation((string) $retirement_draft['draftId'], $operation, $draft_owner);
    zeroy_site_release_acceptance_assert(!is_wp_error($appended), 'Could not stage canonical retirement probe.');
}
$retirement_commit = zeroy_runtime_commit_site_draft((string) $retirement_draft['draftId'], $base_release_id, 'exercise canonical retirement', $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($retirement_commit), 'Could not commit canonical retirement probe: ' . (is_wp_error($retirement_commit) ? $retirement_commit->get_error_message() : ''));
zeroy_site_release_acceptance_assert(get_post((int) $retirement_post) instanceof WP_Post && is_wp_error(zeroy_runtime_canonical((int) $retirement_post)), 'Canonical retirement deleted the WordPress post or retained zeroY identity.');
wp_delete_post((int) $retirement_post, true);
$active = zeroy_runtime_active_site_release();
$base_release_id = (string) $active['active_release_id'];
$baseline_theme_artifact_id = (string) $active['theme_artifact_id'];
$baseline_logic_artifact_id = (string) $active['site_logic_artifact_id'];

$route_conflict_draft = $new_draft($base_release_id);
$route_conflict_operation = zeroy_runtime_append_site_draft_operation((string) $route_conflict_draft['draftId'], [
    'kind' => 'createCanonical',
    'payload' => [
        'ref' => 'route-conflict',
        'postType' => 'page',
        'schemaId' => 'showcase',
        'route' => 'search',
        'postTitle' => 'Route conflict',
        'postContent' => 'Route conflict content',
        'templateContent' => ['title' => 'Route conflict', 'intro' => 'Route conflict content'],
    ],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    is_wp_error($route_conflict_operation)
    && $route_conflict_operation->get_error_code() === 'zeroy_draft_snapshot_route_conflict'
    && ((zeroy_runtime_site_draft_receipt(zeroy_runtime_site_draft_row((string) $route_conflict_draft['draftId']))['operationCount'] ?? null) === 0),
    'A canonical route collision was not rejected before it entered the Draft operation log.'
);
zeroy_runtime_discard_site_draft((string) $route_conflict_draft['draftId'], $draft_owner);

$required_content_probe = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'Required content probe',
], true);
zeroy_site_release_acceptance_assert(!is_wp_error($required_content_probe), 'Could not create required-content probe.');
$required_projection = zeroy_runtime_existing_unmanaged_post((int) $required_content_probe);
zeroy_site_release_acceptance_assert(!is_wp_error($required_projection), 'Could not project required-content probe.');
$required_field_request = new WP_REST_Request('GET', '/zeroy/v1/existing-post');
$required_field_request->set_param('postId', (int) $required_content_probe);
$required_field_request->set_param('schemaId', 'showcase');
$required_field_response = zeroy_runtime_existing_post_endpoint($required_field_request);
$required_field_projection = $required_field_response->get_data()['existingPost'] ?? null;
zeroy_site_release_acceptance_assert(
    $required_field_response->get_status() === 200
    && is_array($required_field_projection)
    && (($required_field_projection['fieldProjection']['contract'] ?? null) === 'zeroy/field-projection@1')
    && count(array_filter(
        $required_field_projection['fieldProjection']['fields'] ?? [],
        static fn(mixed $field): bool => is_array($field)
            && ($field['fieldId'] ?? null) === '/template-content/title'
            && (($field['policy']['required'] ?? false) === true),
    )) === 1,
    'Prospective field projection did not expose the exact required ThemeSchema field.'
);
$required_draft = $new_draft($base_release_id);
$required_operation = zeroy_runtime_append_site_draft_operation((string) $required_draft['draftId'], [
    'kind' => 'adoptCanonical',
    // The baseline already owns the only front-page route.  Exercise required
    // content proof through a distinct, valid candidate route so a route-owner
    // collision cannot hide the content invariant that this probe asserts.
    'payload' => ['postId' => (int) $required_content_probe, 'schemaId' => 'showcase', 'route' => 'required-content-probe', 'expectedSourceHash' => $required_projection['sourceHash']],
], $draft_owner);
zeroy_site_release_acceptance_assert(!is_wp_error($required_operation), 'Could not stage required-content adoption.');
$required_content_release = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, $baseline_logic_artifact_id, $base_release_id, ['source' => 'site-draft', 'draftId' => $required_draft['draftId'], 'message' => 'required-content candidate'], (string) $required_draft['draftId']);
zeroy_site_release_acceptance_assert(
    !is_wp_error($required_content_release)
    && $required_content_release['state'] === 'failed'
    && ($required_content_release['affectedSubjects'][0]['kind'] ?? null) === 'post',
    'Candidate with empty required content was accepted or its failed receipt lost the operation-derived affected subject projection.',
);
$required_failures = $required_content_release['diagnostics']['proof']['blockingFailures'] ?? [];
zeroy_site_release_acceptance_assert(
    is_array($required_failures) && count(array_filter($required_failures, static fn(mixed $failure): bool => is_array($failure) && ($failure['code'] ?? null) === 'candidate_required_source_missing' && (($failure['subject']['id'] ?? null) === (int) $required_content_probe))) > 0,
    'Candidate proof did not identify the empty required content field.'
);
// A failed CandidateProof is still this Draft's compiler output. It must not
// become globally enumerable just because SiteRelease storage persists it.
$candidate_release_id = (string) $required_content_release['releaseId'];
$candidate_proof_id = (string) $required_content_release['proofId'];
$foreign_candidate_release_request = new WP_REST_Request('GET', '/zeroy/v1/site-releases/' . $candidate_release_id);
$foreign_candidate_release_request->set_param('releaseId', $candidate_release_id);
$foreign_candidate_release_request->set_header('x-zeroy-draft-owner', 'different-pi-session');
$foreign_candidate_release = zeroy_runtime_site_release_endpoint($foreign_candidate_release_request);
$foreign_candidate_proof_request = new WP_REST_Request('GET', '/zeroy/v1/site-release-proofs/' . $candidate_proof_id);
$foreign_candidate_proof_request->set_param('proofId', $candidate_proof_id);
$foreign_candidate_proof_request->set_header('x-zeroy-draft-owner', 'different-pi-session');
$foreign_candidate_proof = zeroy_runtime_site_release_proof_endpoint($foreign_candidate_proof_request);
$owner_candidate_proof_request = new WP_REST_Request('GET', '/zeroy/v1/site-release-proofs/' . $candidate_proof_id);
$owner_candidate_proof_request->set_param('proofId', $candidate_proof_id);
$owner_candidate_proof_request->set_header('x-zeroy-draft-owner', $draft_owner);
$owner_candidate_proof = zeroy_runtime_site_release_proof_endpoint($owner_candidate_proof_request);
$public_release_history = zeroy_runtime_site_releases_endpoint(new WP_REST_Request('GET', '/zeroy/v1/site-releases'))->get_data();
zeroy_site_release_acceptance_assert(
    $foreign_candidate_release->get_status() === 404
    && $foreign_candidate_proof->get_status() === 404
    && $owner_candidate_proof->get_status() === 200
    && count(array_filter($public_release_history['releases'] ?? [], static fn(mixed $release): bool => is_array($release) && ($release['releaseId'] ?? null) === $candidate_release_id)) === 0,
    'A SiteDraft candidate or its CandidateProof escaped its owner through the Release read surface.'
);
$required_commit = zeroy_runtime_commit_site_draft((string) $required_draft['draftId'], $base_release_id, 'required-content commit must fail', $draft_owner);
$required_commit_data = is_wp_error($required_commit) ? $required_commit->get_error_data() : null;
zeroy_site_release_acceptance_assert(
    is_wp_error($required_commit)
    && $required_commit->get_error_code() === 'zeroy_site_commit_proof_failed'
    && is_array($required_commit_data)
    && (($required_commit_data['draftId'] ?? null) === (string) $required_draft['draftId'])
    && is_string($required_commit_data['proofId'] ?? null)
    && ($required_commit_data['proofId'] ?? '') !== ''
    && count(array_filter(
        $required_commit_data['diagnostics']['proof']['blockingFailures'] ?? [],
        static fn(mixed $failure): bool => is_array($failure) && ($failure['code'] ?? null) === 'candidate_required_source_missing',
    )) > 0
    && (($required_commit_data['affectedSubjects'][0]['kind'] ?? null) === 'post'),
    'SiteDraft commit did not fail closed with CandidateProof diagnostics and an operation-derived affected subject projection.',
);
zeroy_runtime_discard_site_draft((string) $required_draft['draftId'], $draft_owner);
wp_delete_post((int) $required_content_probe, true);
$empty_image_filter = static fn(mixed $preempt, array $args, string $url): mixed => [
    'headers' => [],
    'body' => '<!doctype html><html><head><title>Probe</title></head><body><img src="" alt=""></body></html>',
    'response' => ['code' => 200, 'message' => 'OK'],
    'cookies' => [],
    'filename' => null,
];
add_filter('pre_http_request', $empty_image_filter, 10, 3);
$empty_image_smoke = zeroy_runtime_candidate_browser_smoke([['scenario' => 'empty-image-probe', 'path' => '/', 'query' => [], 'status' => 200]], 'candidate-probe');
remove_filter('pre_http_request', $empty_image_filter, 10);
zeroy_site_release_acceptance_assert(
    count(array_filter($empty_image_smoke['failures'] ?? [], static fn(mixed $failure): bool => is_array($failure) && ($failure['code'] ?? null) === 'candidate_empty_image_source')) > 0,
    'Candidate smoke check accepted an empty image source.'
);
$unsafe_theme = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-theme', ZEROY_THEME_MANIFEST_CONTRACT, ['functions.php' => "<?php\nupdate_option('zeroy_site_release_boundary_probe', 'leak');\n"]);
$unsafe_theme_stored = zeroy_runtime_materialize_artifact_archive($unsafe_theme['manifest'], $unsafe_theme['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_theme_stored), 'Could not materialize Theme boundary fixture.');
delete_option('zeroy_site_release_boundary_probe');
$unsafe_draft = $empty_draft($base_release_id);
$unsafe_theme_release = zeroy_runtime_prepare_site_release((string) $unsafe_theme_stored['artifactId'], $baseline_logic_artifact_id, $base_release_id, ['source' => 'site-draft', 'draftId' => $unsafe_draft, 'message' => 'theme-boundary candidate'], $unsafe_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_theme_release) && $unsafe_theme_release['state'] === 'failed', 'Theme persistence boundary was not rejected before runtime execution.');
zeroy_site_release_acceptance_assert(get_option('zeroy_site_release_boundary_probe', false) === false, 'Rejected ThemeArtifact executed during verification.');
$candidate_theme_id = (string) $unsafe_theme_stored['artifactId'];
$foreign_candidate_theme_request = new WP_REST_Request('GET', '/zeroy/v1/site-release/theme-artifacts/' . $candidate_theme_id);
$foreign_candidate_theme_request->set_param('artifactId', $candidate_theme_id);
$foreign_candidate_theme_request->set_header('x-zeroy-draft-owner', 'different-pi-session');
$foreign_candidate_theme = zeroy_runtime_site_release_artifact_endpoint($foreign_candidate_theme_request, 'theme');
$owner_candidate_theme_request = new WP_REST_Request('GET', '/zeroy/v1/site-release/theme-artifacts/' . $candidate_theme_id);
$owner_candidate_theme_request->set_param('artifactId', $candidate_theme_id);
$owner_candidate_theme_request->set_header('x-zeroy-draft-owner', $draft_owner);
$owner_candidate_theme = zeroy_runtime_site_release_artifact_endpoint($owner_candidate_theme_request, 'theme');
zeroy_site_release_acceptance_assert(
    $foreign_candidate_theme->get_status() === 404 && $owner_candidate_theme->get_status() === 200,
    'A ThemeArtifact referenced only by a SiteDraft candidate escaped through the artifact read surface.'
);
$logic_boundary_option = 'zeroy_site_logic_bootstrap_boundary_probe';
$unsafe_logic = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, [
    'bootstrap.php' => "<?php\ndefined('ABSPATH') || exit;\nupdate_option('{$logic_boundary_option}', 'leak');\n",
]);
$unsafe_logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($unsafe_logic['manifest'], $unsafe_logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_logic_stored), 'Could not materialize SiteLogic bootstrap boundary fixture.');
delete_option($logic_boundary_option);
$unsafe_logic_draft = $empty_draft($base_release_id);
$unsafe_logic_release = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, (string) $unsafe_logic_stored['artifactId'], $base_release_id, ['source' => 'site-draft', 'draftId' => $unsafe_logic_draft, 'message' => 'SiteLogic bootstrap boundary candidate'], $unsafe_logic_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_logic_release) && $unsafe_logic_release['state'] === 'failed', 'Top-level SiteLogic persistence was not rejected before CandidateProof runtime execution.');
$unsafe_logic_proof = zeroy_site_release_acceptance_proof($unsafe_logic_release);
zeroy_site_release_acceptance_assert(
    count(array_filter($unsafe_logic_proof['blockingFailures'] ?? [], static fn(mixed $failure): bool => is_array($failure) && ($failure['code'] ?? null) === 'site_logic_bootstrap_effect_forbidden')) === 1,
    'CandidateProof did not identify the forbidden top-level SiteLogic effect.',
);
zeroy_site_release_acceptance_assert(
    ($unsafe_logic_proof['themeProof']['runtimeChecks']['executedScenarios'] ?? null) === [],
    'Candidate runtime loaded a SiteLogic bootstrap that static verification had rejected.',
);
$unsafe_logic_draft_row = zeroy_runtime_site_draft_row($unsafe_logic_draft);
$unsafe_logic_draft_receipt = is_array($unsafe_logic_draft_row)
    ? zeroy_runtime_site_draft_receipt($unsafe_logic_draft_row)
    : zeroy_runtime_error('zeroy_site_draft_missing', 'Unsafe SiteLogic Draft disappeared.', 500);
zeroy_site_release_acceptance_assert(
    !is_wp_error($unsafe_logic_draft_receipt)
    && $unsafe_logic_draft_receipt['proofId'] === $unsafe_logic_release['proofId']
    && (($unsafe_logic_draft_receipt['diagnostics']['latestCandidate']['releaseId'] ?? null) === $unsafe_logic_release['releaseId'])
    && (($unsafe_logic_draft_receipt['diagnostics']['latestCandidate']['state'] ?? null) === 'failed'),
    'Failed CandidateProof was not recoverable from its SiteDraft inspection projection.',
);
$invalidated_proof = zeroy_runtime_append_site_draft_operation($unsafe_logic_draft, [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [['path' => '__zeroy-proof-invalidation.css', 'content' => '/* invalidate stale proof */', 'expectedHash' => null]]],
], $draft_owner);
zeroy_site_release_acceptance_assert(
    !is_wp_error($invalidated_proof)
    && $invalidated_proof['proofId'] === null
    && (($invalidated_proof['diagnostics']['latestCandidate']['state'] ?? null) === 'invalidated'),
    'Appending a SiteDraft operation did not invalidate its prior CandidateProof pointer.',
);
zeroy_site_release_acceptance_assert(get_option($logic_boundary_option, false) === false, 'Rejected SiteLogic bootstrap executed during CandidateProof.');
zeroy_site_release_acceptance_assert((zeroy_runtime_site_release_state_endpoint()->get_data()['activeReleaseId'] ?? null) === $base_release_id, 'Rejected SiteLogic bootstrap changed the active SiteRelease pointer.');
$unsafe_lifecycle_logic = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, [
    'bootstrap.php' => "<?php\ndefined('ABSPATH') || exit;\nfunction zeroy_acceptance_forbidden_release_transition(): mixed { return zeroy_runtime_commit_site_draft('forbidden', null, '', 'forbidden'); }\n",
]);
$unsafe_lifecycle_stored = zeroy_runtime_site_logic_materialize_artifact_archive($unsafe_lifecycle_logic['manifest'], $unsafe_lifecycle_logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_lifecycle_stored), 'Could not materialize SiteLogic lifecycle-boundary fixture.');
$unsafe_lifecycle_draft = $empty_draft($base_release_id);
$unsafe_lifecycle_release = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, (string) $unsafe_lifecycle_stored['artifactId'], $base_release_id, ['source' => 'site-draft', 'draftId' => $unsafe_lifecycle_draft, 'message' => 'SiteLogic lifecycle boundary candidate'], $unsafe_lifecycle_draft);
$unsafe_lifecycle_proof = !is_wp_error($unsafe_lifecycle_release) ? zeroy_site_release_acceptance_proof($unsafe_lifecycle_release) : [];
zeroy_site_release_acceptance_assert(
    !is_wp_error($unsafe_lifecycle_release)
    && $unsafe_lifecycle_release['state'] === 'failed'
    && count(array_filter($unsafe_lifecycle_proof['blockingFailures'] ?? [], static fn(mixed $failure): bool => is_array($failure) && ($failure['code'] ?? null) === 'site_logic_connector_lifecycle_forbidden')) === 1,
    'SiteLogic could call Connector release lifecycle functions outside zeroy_site_commit.',
);
$fatal_logic = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, ['bootstrap.php' => "<?php\ndefined('ABSPATH') || exit;\nthrow new RuntimeException('candidate SiteLogic fatal');\n"]);
$fatal_logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($fatal_logic['manifest'], $fatal_logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($fatal_logic_stored), 'Could not materialize SiteLogic fatal fixture.');
$fatal_draft = $empty_draft($base_release_id);
$fatal_logic_release = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, (string) $fatal_logic_stored['artifactId'], $base_release_id, ['source' => 'site-draft', 'draftId' => $fatal_draft, 'message' => 'SiteLogic-fatal candidate'], $fatal_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($fatal_logic_release) && $fatal_logic_release['state'] === 'failed', 'Candidate SiteLogic fatal was not rejected.');
zeroy_site_release_acceptance_assert((zeroy_runtime_site_release_state_endpoint()->get_data()['activeReleaseId'] ?? null) === $base_release_id, 'Candidate failure moved the active SiteRelease pointer.');
$prepare = static function (string $message) use ($empty_draft, $baseline_theme_artifact_id, $baseline_logic_artifact_id, $base_release_id): array|WP_Error {
    $draft = $empty_draft($base_release_id);
    return zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, $baseline_logic_artifact_id, $base_release_id, ['source' => 'site-draft', 'draftId' => $draft, 'message' => $message], $draft);
};
$first = $prepare('first concurrent candidate');
$second = $prepare('second concurrent candidate');
zeroy_site_release_acceptance_assert(!is_wp_error($first) && $first['state'] === 'prepared', 'First candidate did not produce a prepared proof.');
zeroy_site_release_acceptance_assert(!is_wp_error($second) && $second['state'] === 'prepared', 'Second candidate did not produce a prepared proof.');
$activated = zeroy_runtime_activate_site_release($first['releaseId']);
zeroy_site_release_acceptance_assert(!is_wp_error($activated) && $activated['state'] === 'active', 'Prepared candidate did not activate.');
$active_release = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(is_array($active_release), 'Activated SiteRelease could not be reloaded.');
$GLOBALS['zeroy_runtime_request_release'] = ['releaseId' => $first['releaseId'], 'siteLogicArtifactId' => $active_release['site_logic_artifact_id']];
require zeroy_runtime_site_logic_directory((string) $active_release['site_logic_artifact_id']) . '/bootstrap.php';
$selection = zeroy_site_logic_call('product-selection.evaluate', ['throughputKgPerHour' => 1750, 'material' => 'feed']);
$rfq = zeroy_site_logic_call('rfq.submit', ['name' => 'Acceptance Buyer', 'email' => 'buyer@example.test', 'message' => 'Need a production line.']);
zeroy_site_release_acceptance_assert(!is_wp_error($selection) && $selection['tier'] === 'production', 'SiteLogic query capability did not execute through the pinned release.');
zeroy_site_release_acceptance_assert(!is_wp_error($rfq) && $rfq['status'] === 'received' && $rfq['rfqId'] > 0, 'SiteLogic action capability did not persist its owned fact.');
unset($GLOBALS['zeroy_runtime_request_release'], $GLOBALS['zeroy_runtime_site_logic_capabilities']);
$conflict = zeroy_runtime_activate_site_release($second['releaseId']);
zeroy_site_release_acceptance_assert(is_wp_error($conflict) && $conflict->get_error_code() === 'zeroy_active_site_release_changed', 'Concurrent activation was not rejected by the SiteRelease CAS.');
$stale_draft = $empty_draft((string) $first['releaseId']);
$stale = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, $baseline_logic_artifact_id, $first['releaseId'], ['source' => 'site-draft', 'draftId' => $stale_draft, 'message' => 'stale-proof candidate'], $stale_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($stale) && $stale['state'] === 'prepared', 'Stale-proof fixture did not prepare.');
$proof_row = zeroy_runtime_site_release_proof_row($stale['proofId']);
zeroy_site_release_acceptance_assert(is_array($proof_row), 'Stale-proof fixture has no stored proof.');
$proof = zeroy_runtime_decode_json($proof_row['proof_json']);
zeroy_site_release_acceptance_assert(is_array($proof), 'Stale-proof fixture proof is corrupt.');
$proof['themeProof']['artifactId'] = 'sha256:' . str_repeat('0', 64);
global $wpdb;
$wpdb->update(zeroy_runtime_table('verification_proofs'), ['proof_json' => zeroy_runtime_json($proof)], ['proof_id' => $stale['proofId']]);
$stale_activation = zeroy_runtime_activate_site_release($stale['releaseId']);
zeroy_site_release_acceptance_assert(is_wp_error($stale_activation) && $stale_activation->get_error_code() === 'zeroy_site_release_proof_stale', 'Stale proof was accepted for activation.');
$state = zeroy_runtime_site_release_state_endpoint()->get_data();
zeroy_site_release_acceptance_assert(($state['activeReleaseId'] ?? null) === $first['releaseId'], 'Safe Connector state no longer reflects the active release after candidate failures.');

// Candidate proof is read-only. An additive SiteLogic migration must not leak
// from a rejected candidate; the same proven contract applies it only in the
// serialized activation corridor before the pointer CAS.
$migration_key = 'acceptance.migration.' . substr(hash('sha256', wp_generate_uuid4()), 0, 16);
$migration_contract = zeroy_runtime_decode_json((string) file_get_contents($root . '/test-suite/fixtures/site-logic/sitelogic.json'));
zeroy_site_release_acceptance_assert(is_array($migration_contract), 'Migration fixture SiteLogic contract is invalid.');
$migration_base = zeroy_runtime_active_site_release();
$migration_from_epoch = is_array($migration_base) ? (int) $migration_base['storage_epoch'] : 0;
$migration_contract['storageEpoch'] = $migration_from_epoch + 1;
$migration_contract['migrations'] = [[
    'fromEpoch' => $migration_from_epoch,
    'toEpoch' => $migration_from_epoch + 1,
    'idempotencyKey' => $migration_key,
    'effects' => 'schema-additive',
    'verify' => 'acceptance deferred migration table exists',
    'operations' => [[
        'kind' => 'create-table',
        'table' => 'acceptance_deferred_' . substr(hash('sha256', $migration_key), 0, 12),
        'columns' => [['name' => 'value', 'type' => 'varchar', 'nullable' => false]],
    ]],
]];
$migration_logic = zeroy_site_release_acceptance_archive($root . '/test-suite/fixtures/site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, ['sitelogic.json' => zeroy_runtime_json($migration_contract)]);
$migration_logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($migration_logic['manifest'], $migration_logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($migration_logic_stored), 'Could not materialize the SiteLogic migration fixture.');
$migration_failure_draft = $empty_draft((string) $first['releaseId']);
$migration_failure = zeroy_runtime_prepare_site_release((string) $unsafe_theme_stored['artifactId'], (string) $migration_logic_stored['artifactId'], (string) $first['releaseId'], ['source' => 'site-draft', 'draftId' => $migration_failure_draft, 'message' => 'migration must wait for proof'], $migration_failure_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($migration_failure) && $migration_failure['state'] === 'failed', 'Invalid candidate did not fail before migration application.');
global $wpdb;
$migration_ledger_count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_logic_migration_ledger') . ' WHERE idempotency_key = %s', $migration_key));
zeroy_site_release_acceptance_assert($migration_ledger_count === 0, 'Rejected CandidateProof applied a SiteLogic migration.');
$migration_draft = $empty_draft((string) $first['releaseId']);
$migration_release = zeroy_runtime_prepare_site_release($baseline_theme_artifact_id, (string) $migration_logic_stored['artifactId'], (string) $first['releaseId'], ['source' => 'site-draft', 'draftId' => $migration_draft, 'message' => 'verified migration activation'], $migration_draft);
zeroy_site_release_acceptance_assert(!is_wp_error($migration_release) && $migration_release['state'] === 'prepared', 'Valid candidate with SiteLogic migration was not prepared.');
$migration_active = zeroy_runtime_activate_site_release((string) $migration_release['releaseId']);
zeroy_site_release_acceptance_assert(!is_wp_error($migration_active) && $migration_active['state'] === 'active', 'Verified SiteLogic migration candidate did not activate.');
$migration_ledger_count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_logic_migration_ledger') . ' WHERE idempotency_key = %s', $migration_key));
zeroy_site_release_acceptance_assert($migration_ledger_count === 1, 'Verified SiteLogic migration was not applied during activation.');
$migration_proof_row = zeroy_runtime_site_release_proof_row((string) $migration_release['proofId']);
$migration_proof = is_array($migration_proof_row) ? zeroy_runtime_decode_json((string) $migration_proof_row['proof_json']) : null;
zeroy_site_release_acceptance_assert(is_array($migration_proof), 'Verified SiteRelease did not retain its complete CandidateProof.');
zeroy_site_release_acceptance_assert(
    ($migration_release['diagnostics']['proof']['declaredScenarioCount'] ?? null) === count($migration_proof['integrationScenarios']['declared'] ?? [])
    && ($migration_release['diagnostics']['proof']['executedScenarioCount'] ?? null) === count($migration_proof['integrationScenarios']['executed'] ?? [])
    && !array_key_exists('themeSchema', $migration_release['diagnostics']),
    'Compact SiteRelease receipt did not preserve proof summary or leaked the full candidate contract.'
);
WP_CLI::log(wp_json_encode(['ok' => true, 'activeReleaseId' => $migration_release['releaseId'], 'candidateScenarios' => count($migration_proof['integrationScenarios']['executed'] ?? [])]));
