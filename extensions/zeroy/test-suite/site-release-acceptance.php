<?php

defined('ABSPATH') || exit;

function zeroy_site_release_acceptance_assert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
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
$theme = zeroy_site_release_acceptance_archive($root . '/mvp-theme', ZEROY_THEME_MANIFEST_CONTRACT);
$logic = zeroy_site_release_acceptance_archive($root . '/wordpress-plugin/bootstrap-site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT);
$theme_stored = zeroy_runtime_materialize_artifact_archive($theme['manifest'], $theme['archiveBase64']);
$logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($logic['manifest'], $logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($theme_stored) && !is_wp_error($logic_stored), 'Could not materialize SiteRelease acceptance artifacts.');
$active = zeroy_runtime_active_site_release();
zeroy_site_release_acceptance_assert(is_array($active), 'Acceptance site needs an active SiteRelease.');
$base_release_id = $active['active_release_id'];
$unsafe_theme = zeroy_site_release_acceptance_archive($root . '/mvp-theme', ZEROY_THEME_MANIFEST_CONTRACT, ['functions.php' => "<?php\nupdate_option('zeroy_site_release_boundary_probe', 'leak');\n"]);
$unsafe_theme_stored = zeroy_runtime_materialize_artifact_archive($unsafe_theme['manifest'], $unsafe_theme['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_theme_stored), 'Could not materialize Theme boundary fixture.');
delete_option('zeroy_site_release_boundary_probe');
$unsafe_theme_release = zeroy_runtime_prepare_site_release((string) $unsafe_theme_stored['artifactId'], (string) $logic_stored['artifactId'], $base_release_id, ['checkoutId' => 'site-release-acceptance', 'sourceCommit' => 'acceptance-fixture', 'message' => 'theme-boundary candidate']);
zeroy_site_release_acceptance_assert(!is_wp_error($unsafe_theme_release) && $unsafe_theme_release['state'] === 'failed', 'Theme persistence boundary was not rejected before runtime execution.');
zeroy_site_release_acceptance_assert(get_option('zeroy_site_release_boundary_probe', false) === false, 'Rejected ThemeArtifact executed during verification.');
$fatal_logic = zeroy_site_release_acceptance_archive($root . '/wordpress-plugin/bootstrap-site-logic', ZEROY_SITE_LOGIC_MANIFEST_CONTRACT, ['bootstrap.php' => "<?php\ndefined('ABSPATH') || exit;\nthrow new RuntimeException('candidate SiteLogic fatal');\n"]);
$fatal_logic_stored = zeroy_runtime_site_logic_materialize_artifact_archive($fatal_logic['manifest'], $fatal_logic['archiveBase64']);
zeroy_site_release_acceptance_assert(!is_wp_error($fatal_logic_stored), 'Could not materialize SiteLogic fatal fixture.');
$fatal_logic_release = zeroy_runtime_prepare_site_release((string) $theme_stored['artifactId'], (string) $fatal_logic_stored['artifactId'], $base_release_id, ['checkoutId' => 'site-release-acceptance', 'sourceCommit' => 'acceptance-fixture', 'message' => 'SiteLogic-fatal candidate']);
zeroy_site_release_acceptance_assert(!is_wp_error($fatal_logic_release) && $fatal_logic_release['state'] === 'failed', 'Candidate SiteLogic fatal was not rejected.');
zeroy_site_release_acceptance_assert((zeroy_runtime_site_release_state_endpoint()->get_data()['activeReleaseId'] ?? null) === $base_release_id, 'Candidate failure moved the active SiteRelease pointer.');
$prepare = static fn(string $message): array|WP_Error => zeroy_runtime_prepare_site_release((string) $theme_stored['artifactId'], (string) $logic_stored['artifactId'], $base_release_id, ['checkoutId' => 'site-release-acceptance', 'sourceCommit' => 'acceptance-fixture', 'message' => $message]);
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
$stale = zeroy_runtime_prepare_site_release((string) $theme_stored['artifactId'], (string) $logic_stored['artifactId'], $first['releaseId'], ['checkoutId' => 'site-release-acceptance', 'sourceCommit' => 'acceptance-fixture', 'message' => 'stale-proof candidate']);
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
WP_CLI::log(wp_json_encode(['ok' => true, 'activeReleaseId' => $first['releaseId'], 'candidateScenarios' => count($first['diagnostics']['proof']['integrationScenarios']['executed'] ?? [])]));
