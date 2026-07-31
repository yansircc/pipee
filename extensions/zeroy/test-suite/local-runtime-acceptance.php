<?php

/**
 * Destructive proof for a disposable LocalWP site.
 *
 * Run: locwp wp <site-id> -- eval-file /absolute/path/to/local-runtime-acceptance.php
 *
 * This test uses only ThemeArtifact/ThemeDeployment ports. It deliberately
 * retains its immutable Artifact and Deployment evidence for inspection.
 */

defined('ABSPATH') || exit(1);

function zeroy_accept(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function zeroy_accept_error(mixed $value, string $code, string $message): void
{
    zeroy_accept(is_wp_error($value), $message . ' did not fail.');
    zeroy_accept($value->get_error_code() === $code, $message . ' failed with ' . $value->get_error_code() . '.');
}

function zeroy_accept_preview(string $url): array
{
    $response = wp_remote_get($url, ['timeout' => 15, 'redirection' => 0]);
    if (is_wp_error($response)) {
        throw new RuntimeException('Could not request the candidate preview: ' . $response->get_error_message());
    }
    return [
        'status' => (int) wp_remote_retrieve_response_code($response),
        'robots' => (string) wp_remote_retrieve_header($response, 'x-robots-tag'),
    ];
}

function zeroy_accept_archive(array $manifest, string $root): string
{
    $tar = zeroy_runtime_staging_root() . '/acceptance-' . wp_generate_uuid4() . '.tar';
    $gzip = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) {
            $archive->addFile($root . '/' . $entry['path'], $entry['path']);
        }
        $archive->compress(Phar::GZ);
        $bytes = file_get_contents($gzip);
        if (!is_string($bytes)) {
            throw new RuntimeException('Could not read acceptance Artifact archive.');
        }
        return base64_encode($bytes);
    } finally {
        if (is_file($tar)) {
            unlink($tar);
        }
        if (is_file($gzip)) {
            unlink($gzip);
        }
    }
}

function zeroy_accept_candidate(array $active, string $path, string $content): string
{
    $source = zeroy_runtime_artifact_directory((string) $active['artifact_id']);
    $stage = zeroy_runtime_staging_root() . '/acceptance-' . wp_generate_uuid4();
    $manifest = zeroy_runtime_decode_json((string) $active['manifest_json']);
    zeroy_accept(!is_wp_error($manifest), 'Active Artifact manifest is invalid.');
    $copied = zeroy_runtime_copy_manifest_tree($source, $stage, $manifest);
    zeroy_accept(!is_wp_error($copied), 'Could not create candidate Artifact tree.');
    $target = $stage . '/' . $path;
    zeroy_accept(wp_mkdir_p(dirname($target)), 'Could not create candidate Artifact directory.');
    if (is_file($target)) {
        chmod($target, 0644);
    }
    file_put_contents($target, $content, LOCK_EX);
    chmod($target, 0444);
    $candidate_manifest = zeroy_runtime_scan_theme_tree($stage);
    zeroy_accept(!is_wp_error($candidate_manifest), 'Could not scan candidate Artifact tree.');
    $uploaded = zeroy_runtime_materialize_artifact_archive($candidate_manifest, zeroy_accept_archive($candidate_manifest, $stage));
    zeroy_runtime_remove_artifact_staging($stage);
    zeroy_accept(!is_wp_error($uploaded), 'Could not upload candidate ThemeArtifact.');
    return (string) $uploaded['artifactId'];
}

zeroy_runtime_install_schema();
zeroy_runtime_maybe_bootstrap_theme_deployment();
$active = zeroy_runtime_active_theme_state();
zeroy_accept(is_array($active), 'An initial ThemeDeployment must be active.');
$base_artifact = (string) $active['artifact_id'];
$base_integrity = zeroy_runtime_artifact_integrity($base_artifact);
zeroy_accept(!is_wp_error($base_integrity) && ($base_integrity['ok'] ?? false) === true, 'The active ThemeArtifact must match its manifest.');

$token = strtolower(wp_generate_password(10, false, false));
$candidate_artifact = zeroy_accept_candidate($active, 'assets/acceptance-' . $token . '.css', ".zeroy-acceptance-{$token} { display: block; }\n");
zeroy_accept($candidate_artifact !== $base_artifact, 'A byte change must produce a distinct Artifact identity.');
$prepared = zeroy_runtime_prepare_theme_deployment($candidate_artifact, $base_artifact, ['message' => 'Local runtime acceptance']);
zeroy_accept(!is_wp_error($prepared) && ($prepared['state'] ?? null) === 'prepared', 'Candidate ThemeArtifact must prepare without mutating the active pointer.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $base_artifact, 'Prepare must not change active Artifact.');
$preview = zeroy_accept_preview((string) $prepared['previewUrl']);
zeroy_accept($preview['status'] >= 200 && $preview['status'] < 300 && str_contains(strtolower($preview['robots']), 'noindex'), 'Candidate preview must run the prepared Artifact privately before activation.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $base_artifact, 'Candidate preview must not change active Artifact.');
$activated = zeroy_runtime_activate_theme_deployment((string) $prepared['deploymentId']);
zeroy_accept(!is_wp_error($activated) && ($activated['state'] ?? null) === 'active', 'Prepared ThemeDeployment must activate.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'Activation must atomically advance active Artifact.');

$stale_candidate = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'assets/cas-' . $token . '.css', ".zeroy-cas-{$token} {}\n");
$stale = zeroy_runtime_prepare_theme_deployment($stale_candidate, $base_artifact, ['message' => 'CAS acceptance']);
zeroy_accept(!is_wp_error($stale) && ($stale['state'] ?? null) === 'prepared', 'A stale checkout may prepare but not activate.');
zeroy_accept_error(zeroy_runtime_activate_theme_deployment((string) $stale['deploymentId']), 'zeroy_active_theme_changed', 'A stale checkout activation');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'CAS failure must preserve active Artifact.');

$fault_candidate = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'assets/fault-' . $token . '.css', ".zeroy-fault-{$token} {}\n");
$fault_prepared = zeroy_runtime_prepare_theme_deployment($fault_candidate, $candidate_artifact, ['message' => 'activation fault acceptance']);
zeroy_accept(!is_wp_error($fault_prepared) && ($fault_prepared['state'] ?? null) === 'prepared', 'Fault candidate must prepare.');
$fault_hook = static function (mixed $fault, string $phase): mixed {
    return $phase === 'activation.before-active-pointer'
        ? zeroy_runtime_error('zeroy_theme_deployment_fault', 'Injected activation failure.', 500)
        : $fault;
};
add_filter('zeroy_runtime_theme_deployment_fault', $fault_hook, 10, 2);
zeroy_accept_error(zeroy_runtime_activate_theme_deployment((string) $fault_prepared['deploymentId']), 'zeroy_theme_deployment_fault', 'Injected activation failure');
remove_filter('zeroy_runtime_theme_deployment_fault', $fault_hook, 10);
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'Activation fault must preserve the prior active Artifact.');

$expired_artifact = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'assets/gc-' . $token . '.css', ".zeroy-gc-{$token} {}\n");
global $wpdb;
$wpdb->update(
    zeroy_runtime_table('theme_artifacts'),
    ['created_at' => '2000-01-01 00:00:00'],
    ['artifact_id' => $expired_artifact],
    ['%s'],
    ['%s']
);
$gc = zeroy_runtime_collect_theme_artifacts();
zeroy_accept(!is_wp_error($gc), 'ThemeArtifact mark-and-sweep must complete.');
zeroy_accept(zeroy_runtime_artifact_row($expired_artifact) === null, 'GC must remove expired unreferenced Artifact metadata.');
zeroy_accept(!is_dir(zeroy_runtime_artifact_directory($expired_artifact)), 'GC must remove expired unreferenced Artifact storage.');

$artifact_path = zeroy_runtime_artifact_directory($candidate_artifact) . '/assets/acceptance-' . $token . '.css';
chmod($artifact_path, 0644);
file_put_contents($artifact_path, 'drift', LOCK_EX);
$drift = zeroy_runtime_artifact_integrity($candidate_artifact);
zeroy_accept(!is_wp_error($drift) && ($drift['ok'] ?? true) === false && ($drift['code'] ?? null) === 'theme-drift', 'Bypass file changes must be explicit theme drift.');
$repair = zeroy_runtime_repair_active_theme_artifact();
zeroy_accept(!is_wp_error($repair) && ($repair['repaired'] ?? false) === true, 'Repair must restore the active Artifact from its authoritative archive.');
$repaired = zeroy_runtime_artifact_integrity($candidate_artifact);
zeroy_accept(!is_wp_error($repaired) && ($repaired['ok'] ?? false) === true, 'Repair must restore Artifact integrity.');
$repaired_runtime = zeroy_runtime_integrity();
zeroy_accept(($repaired_runtime['ok'] ?? false) === true, 'Repair must preserve the active ThemeSchema snapshot and runtime integrity.');

$invalid_artifact = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'zeroy.schema.json', '{"contract":"invalid"}');
$invalid = zeroy_runtime_prepare_theme_deployment($invalid_artifact, $candidate_artifact, ['message' => 'invalid schema acceptance']);
zeroy_accept(!is_wp_error($invalid) && ($invalid['state'] ?? null) === 'failed', 'Invalid ThemeSchema must produce a failed Deployment.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'A failed deployment must not change active Artifact.');

$runtime_fatal_artifact = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'functions.php', "<?php\nthrow new RuntimeException('candidate runtime fatal');\n");
$runtime_fatal = zeroy_runtime_prepare_theme_deployment($runtime_fatal_artifact, $candidate_artifact, ['message' => 'php runtime acceptance']);
zeroy_accept(!is_wp_error($runtime_fatal) && ($runtime_fatal['state'] ?? null) === 'prepared', 'Syntactically valid candidate PHP must prepare before runtime smoke.');
$runtime_fatal_preview = zeroy_accept_preview((string) $runtime_fatal['previewUrl']);
zeroy_accept($runtime_fatal_preview['status'] >= 500, 'A candidate runtime fatal must fail preview.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'A runtime-fatal candidate preview must not change active Artifact.');

$fatal_artifact = zeroy_accept_candidate(zeroy_runtime_active_theme_state(), 'functions.php', '<?php this is invalid php');
$fatal = zeroy_runtime_prepare_theme_deployment($fatal_artifact, $candidate_artifact, ['message' => 'php lint acceptance']);
zeroy_accept(!is_wp_error($fatal) && ($fatal['state'] ?? null) === 'failed', 'PHP syntax errors must produce a failed Deployment.');
zeroy_accept((zeroy_runtime_active_theme_state()['artifact_id'] ?? null) === $candidate_artifact, 'A failed PHP candidate must not change active Artifact.');

$state = zeroy_runtime_theme_state_endpoint()->get_data();
zeroy_accept(($state['activeArtifactId'] ?? null) === $candidate_artifact, 'Connector REST state must remain available after candidate failures.');
echo wp_json_encode([
    'ok' => true,
    'checks' => ['initial-import', 'artifact-identity', 'prepare-no-visible-change', 'candidate-preview', 'activation', 'cas', 'activation-fault-rollback', 'mark-and-sweep-gc', 'drift-repair', 'schema-failure', 'php-runtime-preview-failure', 'php-lint-failure', 'connector-recovery'],
    'activeArtifactId' => $candidate_artifact,
]) . PHP_EOL;
