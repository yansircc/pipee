<?php

defined('ABSPATH') || exit;

require_once __DIR__ . '/browser-evidence-fixture.php';

function zeroy_bootstrap_acceptance_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

global $wpdb;

$root = dirname(__DIR__) . '/test-suite/fixtures/site-theme';
$draft_owner = 'bootstrap-site-release-acceptance';
zeroy_bootstrap_acceptance_assert(zeroy_runtime_active_site_release() === null, 'Bootstrap acceptance requires a WordPress site without an active SiteRelease.');

$bootstrap_site = zeroy_runtime_site_endpoint()->get_data();
$bootstrap_capabilities = $bootstrap_site['themeAuthoring']['artifact']['theme']['manifest']['requiresCapabilities']['bootstrapValue'] ?? null;
zeroy_bootstrap_acceptance_assert(
    ($bootstrap_site['themeSchema']['valid'] ?? null) === false
    && ($bootstrap_site['themeAuthoring']['contract'] ?? null) === 'zeroy/theme-authoring@1'
    && ($bootstrap_site['themeAuthoring']['artifact']['theme']['requiredFiles'] ?? null) === ['functions.php', 'zeroy.schema.json', 'zeroy.theme.json', 'zcss.design.json', 'assets/css/site.css']
    && ($bootstrap_site['themeAuthoring']['themeSchema']['schemas']['routeKinds'] ?? null) === ['front-page', 'document', 'singular']
    && ($bootstrap_site['themeAuthoring']['themeSchema']['routes']['required'] ?? null) === ['search', 'notFound']
    && $bootstrap_capabilities instanceof stdClass
    && get_object_vars($bootstrap_capabilities) === []
    && ($bootstrap_site['themeAuthoring']['artifact']['theme']['manifest']['requiresCapabilities']['valuePattern'] ?? null) === '^\^[1-9][0-9]*$'
    && ($bootstrap_site['themeAuthoring']['renderContext']['required'] ?? null) === ['routeKind', 'locale', 'preview', 'subject', 'resolvedContent', 'searchQuery', 'archiveItems', 'seo'],
    'A bootstrap site did not expose the generic ThemeSchema, RouteSpec, and ThemeRenderContext authoring contract.',
);
zeroy_bootstrap_acceptance_assert(
    !array_key_exists('siteLogicAuthoring', $bootstrap_site)
    && !array_key_exists('siteLogicBootstrap', $bootstrap_site)
    && !array_key_exists('siteLogic', $bootstrap_site['themeAuthoring']['artifact'] ?? []),
    'A bootstrap site exposed connector-owned SiteLogic as Agent authoring surface.',
);

$initial_theme_request = new WP_REST_Request('GET', '/zeroy/v1/site-artifacts/theme/files');
$initial_theme_request->set_param('artifact', 'theme');
$initial_theme_files = zeroy_runtime_site_artifact_files_endpoint($initial_theme_request)->get_data();
zeroy_bootstrap_acceptance_assert(
    ($initial_theme_files['contract'] ?? null) === 'zeroy/site-artifact-file-list@1'
    && ($initial_theme_files['artifact'] ?? null) === 'theme'
    && ($initial_theme_files['state'] ?? null) === 'bootstrap-required'
    && array_key_exists('artifactId', $initial_theme_files) && $initial_theme_files['artifactId'] === null
    && ($initial_theme_files['files'] ?? null) === [],
    'A bootstrap site did not expose the empty remote ThemeWorkspace projection.',
);

$files = [];
$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
foreach ($iterator as $file) {
    zeroy_bootstrap_acceptance_assert($file instanceof SplFileInfo && $file->isFile() && !$file->isLink(), 'Bootstrap fixture contains an unsafe source file.');
    $path = ltrim(substr(wp_normalize_path($file->getPathname()), strlen(rtrim(wp_normalize_path($root), '/'))), '/');
    $content = file_get_contents($file->getPathname());
    zeroy_bootstrap_acceptance_assert(is_string($content), 'Bootstrap fixture source is unreadable.');
    $files[] = ['path' => $path, 'content' => $content, 'expectedHash' => null];
}

$draft_count_before_invalid_stage = (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_drafts'));
$invalid_design = zeroy_zcss_minimal_design_document();
$invalid_design['spacing']['scaleRatio'] = 1;
$invalid_design_stage = zeroy_runtime_stage_site_draft_operation(null, [
    'kind' => 'artifact.files',
    'payload' => ['artifact' => 'theme', 'files' => [['path' => 'zcss.design.json', 'content' => wp_json_encode($invalid_design), 'expectedHash' => null]]],
], $draft_owner);
zeroy_bootstrap_acceptance_assert(
    is_wp_error($invalid_design_stage)
    && $invalid_design_stage->get_error_code() === 'zeroy_zcss_compile_failed'
    && (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_drafts')) === $draft_count_before_invalid_stage,
    'Invalid ZCSS first stage persisted a Draft or failed without an actionable compiler error.',
);
$invalid_first_stage = zeroy_runtime_stage_site_draft_operation(null, [
    'kind' => 'createCanonical',
    'payload' => ['ref' => 'invalid', 'postType' => 'page', 'schemaId' => 'home'],
], $draft_owner);
zeroy_bootstrap_acceptance_assert(
    is_wp_error($invalid_first_stage)
    && (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_drafts')) === $draft_count_before_invalid_stage,
    'An invalid first stage left an empty SiteDraft behind.',
);
$staged_theme = zeroy_runtime_stage_site_draft_operation(null, ['kind' => 'artifact.files', 'payload' => ['artifact' => 'theme', 'files' => $files]], $draft_owner);
zeroy_bootstrap_acceptance_assert(!is_wp_error($staged_theme), 'Could not stage a complete bootstrap ThemeArtifact.');
$draft = $staged_theme;
zeroy_bootstrap_acceptance_assert(
    is_array($staged_theme)
    && array_key_exists('baseReleaseId', $staged_theme) && $staged_theme['baseReleaseId'] === null
    && ($staged_theme['operationCount'] ?? null) === 1
    && ($staged_theme['affectedArtifacts'][0]['kind'] ?? null) === 'theme'
    && in_array('zeroy.schema.json', $staged_theme['affectedArtifacts'][0]['paths'] ?? [], true)
    && ($staged_theme['zcss']['contract'] ?? null) === ZEROY_ZCSS_COMPILED_CONTRACT
    && ($staged_theme['zcss']['primitiveCount'] ?? null) === 10,
    'A Draft receipt did not project affected ThemeArtifact paths from the operation log.',
);
zeroy_bootstrap_acceptance_assert(
    is_array($staged_theme)
    && is_string($staged_theme['lastArtifactFiles'][0]['hash'] ?? null)
    && ($staged_theme['lastArtifactFiles'][0]['state'] ?? null) === 'written',
    'A Theme stage receipt did not return the next expected hash for its written files.',
);
$artifact_count_before_inspection = (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('theme_artifacts'));
$candidate_inspection = zeroy_runtime_site_draft_inspection(zeroy_runtime_site_draft_row((string) $draft['draftId']));
zeroy_bootstrap_acceptance_assert(
    !is_wp_error($candidate_inspection)
    && ($candidate_inspection['candidate']['state'] ?? null) === 'ready'
    && ($candidate_inspection['candidate']['themeContract']['contract'] ?? null) === 'zeroy/theme-contract@1'
    && isset($candidate_inspection['candidate']['themeSchema']['schemas']['home'])
    && ($candidate_inspection['candidate']['acfProjection']['available'] ?? null) !== null
    && (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('theme_artifacts')) === $artifact_count_before_inspection,
    'Draft inspection did not expose the candidate ThemeContract without materializing a ThemeArtifact.',
);
$surface_request = new WP_REST_Request('GET', '/zeroy/v1/zcss-style-surface');
$surface_request->set_param('draftId', (string) $draft['draftId']);
$surface_request->set_header('x-zeroy-draft-owner', $draft_owner);
$surface = zeroy_runtime_zcss_style_surface_endpoint($surface_request)->get_data();
zeroy_bootstrap_acceptance_assert(
    ($surface['contract'] ?? null) === ZEROY_ZCSS_STYLE_SURFACE_CONTRACT
    && ($surface['draftId'] ?? null) === $draft['draftId']
    && array_key_exists('releaseId', $surface)
    && $surface['releaseId'] === null
    && ($surface['reservedNamespaceViolations'] ?? null) === []
    && ($surface['undefinedReferences'] ?? null) === [],
    'Owner-scoped Draft StyleSurface did not project the exact compiled candidate.',
);
$foreign_surface_request = new WP_REST_Request('GET', '/zeroy/v1/zcss-style-surface');
$foreign_surface_request->set_param('draftId', (string) $draft['draftId']);
$foreign_surface_request->set_header('x-zeroy-draft-owner', 'foreign-owner');
$foreign_surface = zeroy_runtime_zcss_style_surface_endpoint($foreign_surface_request);
zeroy_bootstrap_acceptance_assert($foreign_surface->get_status() === 404, 'A foreign Draft owner could inspect the candidate StyleSurface.');
$staged_home = zeroy_runtime_append_site_draft_operation((string) $draft['draftId'], [
    'kind' => 'createCanonical',
    'payload' => [
        'ref' => 'bootstrap-home',
        'postType' => 'page',
        'schemaId' => 'home',
        'route' => '/',
        'postTitle' => 'Bootstrap Home',
        'postContent' => 'Initial zeroY SiteRelease built from an empty remote site.',
        'templateContent' => [
            'hero_title' => 'Bootstrap Home',
            'hero_subtitle' => 'A verified first SiteRelease.',
            'cta_title' => 'Start a project',
        ],
    ],
], $draft_owner);
zeroy_bootstrap_acceptance_assert(!is_wp_error($staged_home), 'Could not stage the bootstrap front-page canonical.');
zeroy_bootstrap_acceptance_assert(
    is_array($staged_home)
    && ($staged_home['affectedSubjects'][0]['kind'] ?? null) === 'post'
    && ($staged_home['affectedSubjects'][0]['ref'] ?? null) === 'bootstrap-home',
    'A Draft receipt did not project affected staged canonical refs from the operation log.',
);

$browser_acceptance_prepare = getenv('ZEROY_BROWSER_ACCEPTANCE_PREPARE') === '1';
if ($browser_acceptance_prepare) {
    $prepared = zeroy_runtime_prepare_site_draft_commit((string) $draft['draftId'], null, 'browser acceptance', $draft_owner);
    zeroy_bootstrap_acceptance_assert(!is_wp_error($prepared) && ($prepared['state'] ?? null) === 'awaiting-browser' && is_array($prepared['browserVerification'] ?? null), 'Could not prepare the browser acceptance SiteRelease.');
    WP_CLI::log(wp_json_encode(['ok' => true, 'ownerId' => $draft_owner, 'prepared' => $prepared]));
    return;
}
$committed = zeroy_acceptance_commit_site_draft((string) $draft['draftId'], null, 'bootstrap acceptance', $draft_owner);
zeroy_bootstrap_acceptance_assert(!is_wp_error($committed) && ($committed['state'] ?? null) === 'active', 'Could not commit the first SiteRelease.');
$active = zeroy_runtime_active_site_release();
$logic = is_array($active) ? zeroy_runtime_site_logic_artifact_row((string) $active['site_logic_artifact_id']) : null;
$contract = is_array($logic) ? zeroy_runtime_decode_json((string) $logic['contract_json']) : null;
zeroy_bootstrap_acceptance_assert(is_array($contract) && ($contract['provides'] ?? null) === [], 'Bootstrap SiteLogic must be connector-owned and capability-free.');
zeroy_bootstrap_acceptance_assert(
    is_array($committed)
    && ($committed['affectedArtifacts'][0]['kind'] ?? null) === 'theme'
    && ($committed['affectedSubjects'][0]['ref'] ?? null) === 'bootstrap-home'
    && ($committed['zcss']['state'] ?? null) === 'verified'
    && is_string($committed['zcss']['stylesheetSetHash'] ?? null),
    'An active SiteRelease receipt did not retain the operation-derived affected projection.',
);

$home = wp_remote_get(home_url('/'), ['timeout' => 20, 'redirection' => 0]);
$home_body = wp_remote_retrieve_body($home);
$generated_position = strpos($home_body, ZEROY_ZCSS_GENERATED_CSS_PATH);
$site_position = strpos($home_body, 'assets/css/site.css');
zeroy_bootstrap_acceptance_assert(
    !is_wp_error($home)
    && wp_remote_retrieve_response_code($home) === 200
    && wp_remote_retrieve_header($home, 'x-zeroy-route-kind') === 'front-page'
    && wp_remote_retrieve_header($home, 'x-zeroy-stylesheet-identity') === $committed['zcss']['stylesheetSetHash']
    && $generated_position !== false
    && $site_position !== false
    && $generated_position < $site_position,
    'The first active SiteRelease did not render its default front page.',
);

WP_CLI::log(wp_json_encode([
    'ok' => true,
    'draftId' => $draft['draftId'],
    'releaseId' => $committed['releaseId'],
    'baseReleaseId' => $draft['baseReleaseId'],
    'siteLogicProvides' => $contract['provides'],
]));
