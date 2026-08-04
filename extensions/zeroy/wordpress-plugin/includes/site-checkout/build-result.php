<?php

defined('ABSPATH') || exit;

function zeroy_build_compiler_set_hash(): string
{
    $sources = [];
    foreach ([
        __FILE__,
        __DIR__ . '/compiler.php',
        __DIR__ . '/document-algebra.php',
        __DIR__ . '/adoption-projection.php',
        __DIR__ . '/workspace-contract.php',
        __DIR__ . '/materialization.php',
        dirname(__DIR__) . '/theme/contract-compiler.php',
        dirname(__DIR__) . '/localization/policy-compiler.php',
        dirname(__DIR__) . '/zcss/compiler.php',
        dirname(__DIR__) . '/theme-units/compiler.php',
        dirname(__DIR__) . '/site-release/scenario-compiler.php',
        dirname(__DIR__) . '/site-release/snapshot-compiler.php',
        dirname(__DIR__) . '/site-release/static-verifier.php',
    ] as $path) $sources[basename(dirname($path)) . '/' . basename($path)] = hash_file('sha256', $path);
    ksort($sources, SORT_STRING);
    return zeroy_runtime_hash([
        'runtime' => ZEROY_RUNTIME_VERSION,
        'siteTree' => ZEROY_SITE_TREE_CONTRACT,
        'themeSchema' => ZEROY_THEME_SCHEMA_CONTRACT,
        'localization' => zeroy_localization_policy_contract(),
        'zcss' => ZEROY_ZCSS_DESIGN_CONTRACT,
        'themeUnits' => ZEROY_THEME_UNIT_CONTRACT,
        'snapshot' => ZEROY_SITE_SNAPSHOT_CONTRACT,
        'verifier' => 'site-release-foundation@2',
        'sources' => $sources,
    ]);
}

function zeroy_build_external_fact_taxonomies(array $files): array
{
    $entry = $files['artifacts/theme/zeroy.schema.json'] ?? null;
    $schema = is_array($entry) && is_string($entry['bytes'] ?? null) ? zeroy_runtime_decode_json($entry['bytes']) : null;
    $taxonomies = [];
    foreach (is_array($schema['collections'] ?? null) ? $schema['collections'] : [] as $collection) {
        if (($collection['kind'] ?? null) === 'taxonomy' && is_string($collection['taxonomy'] ?? null)) $taxonomies[$collection['taxonomy']] = true;
    }
    return array_keys($taxonomies);
}

function zeroy_build_external_facts(?array $site = null, array $files = []): array
{
    $active = zeroy_runtime_active_site_release();
    $posts = [];
    $terms = [];
    if (is_array($active)) {
        $snapshot = zeroy_runtime_site_release_snapshot($active);
        if (!is_wp_error($snapshot)) {
            foreach (is_array($snapshot['entities'] ?? null) ? $snapshot['entities'] : [] as $entity) {
                $object_id = is_array($entity) && is_int($entity['objectId'] ?? null) ? $entity['objectId'] : null;
                if ($object_id === null) continue;
                $canonical = zeroy_localization_post_subject($object_id);
                if (!is_wp_error($canonical)) $posts[(string) $object_id] = $canonical['canonicalRevision'];
            }
            foreach (is_array($snapshot['terms'] ?? null) ? $snapshot['terms'] : [] as $term) {
                $subject = is_array($term) ? ($term['subject'] ?? null) : null;
                if (!is_array($subject) || !is_int($subject['id'] ?? null) || !is_string($term['taxonomy'] ?? null)) continue;
                $current = zeroy_localization_term_subject($term['taxonomy'], $subject['id']);
                if (!is_wp_error($current)) $terms[$term['taxonomy'] . ':' . $subject['id']] = $current['canonicalRevision'];
            }
        }
    }
    ksort($posts, SORT_STRING);
    ksort($terms, SORT_STRING);
    $post_types = array_values(array_map(
        static fn(array $collection): string => (string) ($collection['postType'] ?? ''),
        is_array($site['collections'] ?? null) ? $site['collections'] : [],
    ));
    return [
        'activeReleaseId' => is_array($active) ? (string) $active['release_id'] : null,
        'activeReleaseRevision' => is_array($active) ? (string) ($active['activated_at'] ?? '') : null,
        'acf' => zeroy_runtime_acf_projection(),
        'adoptedPosts' => $posts,
        'unmanagedPosts' => zeroy_adoption_external_facts($post_types),
        'unmanagedTerms' => zeroy_adoption_term_external_facts(zeroy_build_external_fact_taxonomies($files)),
        'unmanagedMedia' => zeroy_adoption_media_external_facts($post_types),
        'terms' => $terms,
        'storageEpoch' => is_array($active) ? (int) $active['storage_epoch'] : 0,
    ];
}

function zeroy_build_identity(string $commit_hash, string $compiler_set_hash, string $external_facts_hash): string
{
    return 'sha256:' . hash('sha256', zeroy_checkout_canonical_json(['commit' => $commit_hash, 'compilerSetHash' => $compiler_set_hash, 'externalFactsHash' => $external_facts_hash]));
}

function zeroy_build_external_facts_hash_for_commit(string $commit_hash): string|WP_Error
{
    $commit = zeroy_checkout_commit_row($commit_hash);
    if ($commit === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'BuildResult references a missing SiteCommit.', 404);
    $files = zeroy_checkout_read_tree_files((string) $commit['tree_hash']);
    if (is_wp_error($files)) return $files;
    $failures = [];
    $site = zeroy_document_decode_site($files, $failures);
    return zeroy_runtime_hash(zeroy_build_external_facts(is_array($site) ? $site : null, $files));
}

function zeroy_build_row(string $build_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('site_builds') . ' WHERE build_id = %s', $build_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_build_diagnostics(string $diagnostics_hash): ?array
{
    global $wpdb;
    $encoded = $wpdb->get_var($wpdb->prepare('SELECT diagnostics_json FROM ' . zeroy_runtime_table('site_build_diagnostics') . ' WHERE diagnostics_hash = %s', $diagnostics_hash));
    $decoded = is_string($encoded) ? zeroy_runtime_decode_json($encoded) : null;
    return is_array($decoded) ? $decoded : null;
}

function zeroy_build_result_projection(array $row): array
{
    $decoded = zeroy_runtime_decode_json((string) $row['result_json']);
    return is_array($decoded) ? $decoded : [];
}

function zeroy_build_verification_candidate(string $build_id): ?array
{
    global $wpdb;
    $encoded = $wpdb->get_var($wpdb->prepare(
        'SELECT candidate_json FROM ' . zeroy_runtime_table('site_build_candidates') . ' WHERE build_id = %s',
        $build_id,
    ));
    $candidate = is_string($encoded) ? zeroy_runtime_decode_json($encoded) : null;
    return is_array($candidate) ? $candidate : null;
}

function zeroy_build_store_verification_candidate(string $build_id, array $candidate): true|WP_Error
{
    global $wpdb;
    $written = $wpdb->replace(zeroy_runtime_table('site_build_candidates'), [
        'build_id' => $build_id,
        'candidate_json' => zeroy_checkout_canonical_json($candidate),
        'created_at' => current_time('mysql', true),
    ], ['%s', '%s', '%s']);
    return $written === false
        ? zeroy_runtime_error('zeroy_build_candidate_store_failed', $wpdb->last_error ?: 'Could not expose the immutable build candidate to the verifier.', 500)
        : true;
}

function zeroy_build_delete_verification_candidate(string $build_id): void
{
    global $wpdb;
    $wpdb->delete(zeroy_runtime_table('site_build_candidates'), ['build_id' => $build_id], ['%s']);
}

function zeroy_build_candidate_release_projection(string $build_id, array $candidate): array
{
    $compiled = $candidate['compiled'];
    $snapshot = $candidate['snapshot'];
    return [
        'release_id' => null,
        'commit_hash' => $candidate['commit']['commit_hash'],
        'build_id' => $build_id,
        'theme_artifact_id' => $candidate['artifacts']['theme']['artifactId'],
        'site_logic_artifact_id' => $candidate['artifacts']['siteLogic']['artifactId'],
        'theme_contract_hash' => $compiled['hash'],
        'site_logic_contract_hash' => $compiled['siteLogicContractHash'],
        'storage_epoch' => $compiled['siteLogicContract']['storageEpoch'],
        'snapshot_hash' => $snapshot['snapshotHash'],
        'snapshot_json' => zeroy_runtime_json($snapshot),
        'state' => 'building',
    ];
}

/**
 * Failure rendering must remain available even when compilation did not
 * produce a Candidate. Candidate facts make the location more precise; they
 * are not a precondition for returning a bounded, actionable BuildResult.
 */
function zeroy_build_front_page_document_path(array $site, ?array $candidate): string
{
    $schema = is_array($candidate) ? ($candidate['compiled']['schema']['schemas'] ?? null) : null;
    if (!is_array($schema)) return 'artifacts/theme/zeroy.schema.json';
    $front_page_schemas = [];
    foreach ($schema as $schema_id => $definition) {
        if (is_array($definition) && ($definition['routeKind'] ?? null) === 'front-page') $front_page_schemas[(string) $schema_id] = true;
    }
    if ($front_page_schemas === []) return 'artifacts/theme/zeroy.schema.json';
    $collections = [];
    foreach ($site['collections'] ?? [] as $collection_id => $collection) {
        if (is_array($collection) && isset($front_page_schemas[(string) ($collection['schemaId'] ?? '')])) $collections[] = (string) $collection_id;
    }
    return count($collections) === 1
        ? 'content/posts/' . $collections[0] . '/front-page.json'
        : 'site.json';
}

function zeroy_build_verification_failure(array $failure, array $site, ?array $candidate): array
{
    $file = is_string($failure['file'] ?? null) ? $failure['file'] : null;
    $site_logic = str_starts_with((string) ($failure['code'] ?? ''), 'site_logic_');
    $document_path = $file === null
        ? ((string) ($failure['code'] ?? '') === 'candidate_default_front_page_missing'
            ? zeroy_build_front_page_document_path($site, $candidate)
            : 'site.json')
        : ($site_logic ? 'artifacts/site-logic/' : 'artifacts/theme/') . ltrim($file, '/');
    return zeroy_build_public_failure([
        ...$failure,
        'documentPath' => $document_path,
        'contractPath' => zeroy_workspace_contract_for_document($document_path, $site),
        'templatePath' => zeroy_workspace_template_for_document($document_path, $site),
        'contentPath' => $file !== null && is_int($failure['line'] ?? null) ? 'line.' . $failure['line'] : '',
        'evidence' => $failure['evidence'] ?? $failure['message'] ?? 'Candidate verification failed.',
    ]);
}

function zeroy_build_verify_candidate(string $build_id, array $candidate, array $site): array|WP_Error
{
    $release = zeroy_build_candidate_release_projection($build_id, $candidate);
    $stored = zeroy_build_store_verification_candidate($build_id, $release);
    if (is_wp_error($stored)) return $stored;
    $proof = zeroy_runtime_verify_candidate_site_release($release, $candidate['compiled'], 'build', $build_id);
    if (is_wp_error($proof)) return $proof;
    return [
        'proof' => $proof,
        'failures' => array_map(
            static fn(array $failure): array => zeroy_build_verification_failure($failure, $site, $candidate),
            $proof['blockingFailures'],
        ),
    ];
}

function zeroy_build_failures_from_error(WP_Error $error): array
{
    $data = $error->get_error_data();
    $path = is_array($data) && is_string($data['path'] ?? null) ? rtrim($data['path'], '/') : null;
    if ($path === 'artifacts/theme') {
        return array_map(static fn(string $file): array => zeroy_document_failure(
            $error->get_error_code(),
            'artifacts/theme/' . $file,
            '',
            $error->get_error_message(),
            'Create the complete ThemeArtifact from the linked minimal templates.',
        ), zeroy_runtime_theme_required_files());
    }
    if ($path === 'artifacts/site-logic') {
        return array_map(static fn(string $file): array => zeroy_document_failure(
            $error->get_error_code(),
            'artifacts/site-logic/' . $file,
            '',
            $error->get_error_message(),
            'Create the complete SiteLogicArtifact from the linked minimal templates.',
        ), ['sitelogic.json', 'bootstrap.php']);
    }
    $nested = is_array($data) && is_array($data['failures'] ?? null) ? $data['failures'] : null;
    if ($nested !== null) return array_map('zeroy_build_public_failure', array_values($nested));
    $violations = is_array($data) && is_array($data['violations'] ?? null) ? $data['violations'] : [];
    if ($violations !== []) return array_map(static fn(array $violation): array => zeroy_document_failure(
        (string) ($violation['code'] ?? $error->get_error_code()),
        is_string($violation['path'] ?? null) ? $violation['path'] : 'artifacts/theme/zeroy.schema.json',
        is_string($violation['field'] ?? null) ? $violation['field'] : '',
        is_string($violation['message'] ?? null) ? $violation['message'] : $error->get_error_message(),
        is_string($violation['repair'] ?? null) ? $violation['repair'] : 'Repair the linked artifact or document and push another coherent repair slice.',
    ), $violations);
    return [zeroy_document_failure($error->get_error_code(), is_array($data) && is_string($data['path'] ?? null) ? $data['path'] : 'site.json', is_array($data) && is_string($data['fieldId'] ?? null) ? $data['fieldId'] : '', $error->get_error_message(), is_array($data) && is_string($data['repair'] ?? null) ? $data['repair'] : 'Repair the linked file and push another coherent repair slice.')];
}

function zeroy_build_public_failure(array $failure): array
{
    $content_path = is_string($failure['contentPath'] ?? null)
        ? $failure['contentPath']
        : (is_string($failure['fieldId'] ?? null) ? trim(str_replace('/', '.', $failure['fieldId']), '.') : '');
    return array_filter([
        'code' => is_string($failure['code'] ?? null) ? $failure['code'] : 'build_failure',
        'phase' => is_string($failure['phase'] ?? null) ? $failure['phase'] : null,
        'blockedBy' => is_array($failure['blockedBy'] ?? null) ? array_values(array_filter($failure['blockedBy'], 'is_string')) : [],
        'documentPath' => is_string($failure['documentPath'] ?? null) ? $failure['documentPath'] : (is_string($failure['path'] ?? null) ? $failure['path'] : 'site.json'),
        'contentPath' => $content_path,
        'contractPath' => is_string($failure['contractPath'] ?? null) ? $failure['contractPath'] : null,
        'templatePath' => is_string($failure['templatePath'] ?? null) ? $failure['templatePath'] : null,
        'subjectRef' => is_string($failure['subjectRef'] ?? null) ? $failure['subjectRef'] : null,
        'locale' => is_string($failure['locale'] ?? null) ? $failure['locale'] : null,
        'evidence' => is_string($failure['evidence'] ?? null) ? $failure['evidence'] : (is_string($failure['message'] ?? null) ? $failure['message'] : 'Build phase failed.'),
        'repair' => is_string($failure['repair'] ?? null) ? $failure['repair'] : 'Repair the linked authored file and push another coherent repair slice.',
    ], static fn(mixed $value): bool => $value !== null);
}

function zeroy_build_tag_failures(array $failures, string $phase, array $blocked_by = []): array
{
    return array_map(static fn(array $failure): array => ['phase' => $phase, 'blockedBy' => $blocked_by, ...$failure], $failures);
}

function zeroy_build_blocked_failure(string $phase, array $blocked_by): array
{
    return [
        'phase' => $phase,
        'blockedBy' => $blocked_by,
        ...zeroy_document_failure(
            'build_phase_blocked',
            'site.json',
            '',
            "Build phase {$phase} could not run because an upstream phase failed.",
            'Repair the linked upstream phase; the Connector will run this phase on the next coherent repair slice.',
        ),
    ];
}

function zeroy_build_unique_failures(array $failures): array
{
    $unique = [];
    foreach ($failures as $failure) $unique[zeroy_checkout_canonical_json($failure)] = $failure;
    return array_values($unique);
}

function zeroy_build_phase_projection(array $failures): array
{
    $phases = [];
    foreach ($failures as $failure) {
        $phase = is_string($failure['phase'] ?? null) ? $failure['phase'] : 'workspace-content';
        if (!isset($phases[$phase])) $phases[$phase] = ['phase' => $phase, 'failureCount' => 0, 'blockedBy' => []];
        $phases[$phase]['failureCount']++;
        foreach (is_array($failure['blockedBy'] ?? null) ? $failure['blockedBy'] : [] as $dependency) if (is_string($dependency)) $phases[$phase]['blockedBy'][$dependency] = true;
    }
    foreach ($phases as &$phase) $phase['blockedBy'] = array_keys($phase['blockedBy']);
    unset($phase);
    ksort($phases, SORT_STRING);
    return array_values($phases);
}

/**
 * A renderable build may still be incomplete: content, locale, accessibility,
 * and browser findings belong to Review, not to the Preview availability gate.
 * Only failures that prove the request cannot safely render suppress Preview.
 */
function zeroy_build_candidate_is_renderable(?array $candidate, ?array $verification): bool
{
    if (!is_array($candidate) || !is_array($verification)) return false;
    foreach (zeroy_runtime_site_release_proof_failures($verification) as $failure) {
        if (in_array($failure['code'] ?? null, ['candidate_runtime_unavailable', 'candidate_runtime_failed', 'candidate_php_error_output', 'candidate_cache_boundary_missing'], true)) return false;
    }
    return true;
}

function zeroy_build_compile(string $commit_hash): array|WP_Error
{
    $compiler_set_hash = zeroy_build_compiler_set_hash();
    $commit = zeroy_checkout_commit_row($commit_hash);
    if ($commit === null) return zeroy_runtime_error('zeroy_site_commit_missing', 'BuildResult references a missing SiteCommit.', 404);
    $files = zeroy_checkout_read_tree_files((string) $commit['tree_hash']);
    if (is_wp_error($files)) return $files;
    $external_facts_hash = zeroy_build_external_facts_hash_for_commit($commit_hash);
    if (is_wp_error($external_facts_hash)) return $external_facts_hash;
    $build_id = zeroy_build_identity($commit_hash, $compiler_set_hash, $external_facts_hash);
    $existing = zeroy_build_row($build_id);
    if ($existing !== null) {
        $stored_diagnostics = zeroy_build_diagnostics((string) $existing['diagnostics_hash']);
        return ['result' => zeroy_build_result_projection($existing), 'diagnostics' => $stored_diagnostics, 'candidate' => is_array($stored_diagnostics['candidate'] ?? null) ? $stored_diagnostics['candidate'] : null];
    }
    $failures = [];
    $workspace_failures = [];
    $site = zeroy_document_decode_site($files, $workspace_failures);
    if (is_array($site)) zeroy_document_decode_all($files, $site, $workspace_failures);
    $failures = [...$failures, ...zeroy_build_tag_failures($workspace_failures, 'workspace-contracts')];
    $artifacts = zeroy_checkout_compile_artifacts($files);
    $compiled = null;
    if (is_wp_error($artifacts)) $failures = [...$failures, ...zeroy_build_tag_failures(zeroy_build_failures_from_error($artifacts), 'theme-files')];
    else {
        $compiled = zeroy_runtime_compile_theme_contract((string) $artifacts['theme']['artifactId'], (string) $artifacts['siteLogic']['artifactId']);
        if (is_wp_error($compiled)) {
            $failures = [...$failures, ...zeroy_build_tag_failures(zeroy_build_failures_from_error($compiled), 'theme-contract')];
            $compiled = null;
        }
    }
    $adoption = zeroy_adoption_projection($files, $compiled);
    $failures = [...$failures, ...zeroy_build_tag_failures($adoption['failures'], 'workspace-content')];
    $candidate = is_array($compiled) ? zeroy_checkout_compile_commit($commit_hash) : null;
    if (is_wp_error($candidate)) {
        $failures = [...$failures, ...zeroy_build_tag_failures(zeroy_build_failures_from_error($candidate), 'site-snapshot')];
        $candidate = null;
    } elseif ($compiled === null) {
        $blocked_by = is_wp_error($artifacts) ? ['theme-files'] : ['theme-contract'];
        $failures[] = zeroy_build_blocked_failure('site-snapshot', $blocked_by);
    }
    $verification = null;
    if (is_array($candidate) && $failures === []) {
        $verified = zeroy_build_verify_candidate($build_id, $candidate, $site);
        if (is_wp_error($verified)) {
            $failures = [...$failures, ...zeroy_build_tag_failures(zeroy_build_failures_from_error($verified), 'candidate-verification')];
        } else {
            $verification = $verified['proof'];
            $failures = [...$failures, ...zeroy_build_tag_failures($verified['failures'], 'candidate-verification')];
        }
    } elseif (is_array($candidate)) {
        $failures[] = zeroy_build_blocked_failure('candidate-verification', ['workspace-contracts', 'theme-files', 'theme-contract', 'site-snapshot']);
    }
    $failures = zeroy_build_unique_failures($failures);
    $state = $failures === []
        ? 'ready'
        : (zeroy_build_candidate_is_renderable($candidate, $verification) ? 'renderable' : 'invalid');
    if (is_array($candidate) && is_array($candidate['compiled'] ?? null)) $compiled = $candidate['compiled'];
    $snapshot_hash = is_array($candidate) && is_string($candidate['snapshot']['snapshotHash'] ?? null) ? $candidate['snapshot']['snapshotHash'] : null;
    $projection = zeroy_workspace_contract_projection($files, $compiled, $failures, $build_id, $state, $adoption['files']);
    $budget_failures = zeroy_workspace_projection_budget_failures($projection);
    if ($budget_failures !== []) {
        $failures = [...$failures, ...zeroy_build_tag_failures($budget_failures, 'workspace-projection')];
        $state = 'invalid';
        $candidate = null;
        $snapshot_hash = null;
        $projection = zeroy_workspace_contract_projection($files, $compiled, $failures, $build_id, $state, $adoption['files']);
    }
    $projection['.zeroy/status.json'] = [
        'analyzedCommit' => $commit_hash,
        'analyzedTree' => (string) $commit['tree_hash'],
        'buildId' => $build_id,
        'state' => $state,
    ];
    $projection_files = zeroy_workspace_projection_file_bytes($projection);
    $diagnostics = ['contract' => 'zeroy/build-diagnostics@1', 'buildId' => $build_id, 'phases' => zeroy_build_phase_projection($failures), 'failures' => $failures, 'workspaceProjection' => $projection_files, 'authoredSeeds' => $adoption['files'], 'candidate' => is_array($candidate) ? [...$candidate, 'verificationProof' => $verification] : null];
    $diagnostics_hash = zeroy_runtime_hash($diagnostics);
    $result = [
        'contract' => 'zeroy/build-result@1',
        'buildId' => $build_id,
        'commit' => $commit_hash,
        'compilerSetHash' => $compiler_set_hash,
        'externalFactsHash' => $external_facts_hash,
        'state' => $state,
        'failureCount' => count($failures),
        'diagnosticCount' => count($failures),
        'snapshotHash' => $snapshot_hash,
        'derivedArtifactSetHash' => is_array($candidate) ? zeroy_runtime_hash($candidate['artifacts']) : null,
        'createdAt' => current_time('mysql', true),
    ];
    global $wpdb;
    $stored_diagnostics = $wpdb->insert(zeroy_runtime_table('site_build_diagnostics'), ['diagnostics_hash' => $diagnostics_hash, 'diagnostics_json' => zeroy_checkout_canonical_json($diagnostics)], ['%s', '%s']);
    if ($stored_diagnostics === false && zeroy_build_diagnostics($diagnostics_hash) === null) return zeroy_runtime_error('zeroy_build_store_failed', $wpdb->last_error ?: 'Could not store BuildResult diagnostics.', 500);
    $stored = $wpdb->insert(zeroy_runtime_table('site_builds'), [
        'build_id' => $build_id,
        'commit_hash' => $commit_hash,
        'compiler_set_hash' => $compiler_set_hash,
        'external_facts_hash' => $external_facts_hash,
        'state' => $state,
        'snapshot_hash' => $snapshot_hash,
        'result_json' => zeroy_checkout_canonical_json($result),
        'diagnostics_hash' => $diagnostics_hash,
        'created_at' => current_time('mysql', true),
    ]);
    if ($stored !== 1) {
        $concurrent = zeroy_build_row($build_id);
        if ($concurrent !== null) {
            $concurrent_result = zeroy_build_result_projection($concurrent);
            $concurrent_diagnostics = zeroy_build_diagnostics((string) $concurrent['diagnostics_hash']);
            return ['result' => $concurrent_result, 'diagnostics' => $concurrent_diagnostics, 'candidate' => is_array($concurrent_diagnostics['candidate'] ?? null) ? $concurrent_diagnostics['candidate'] : null];
        }
        return zeroy_runtime_error('zeroy_build_store_failed', $wpdb->last_error ?: 'Could not store immutable BuildResult.', 500);
    }
    return ['result' => $result, 'diagnostics' => $diagnostics, 'candidate' => is_array($candidate) ? $candidate : null];
}

function zeroy_build_workspace_projection(string $build_id): array|WP_Error
{
    $row = zeroy_build_row($build_id);
    if ($row === null) return zeroy_runtime_error('zeroy_build_missing', 'BuildResult does not exist.', 404, ['buildId' => $build_id]);
    $diagnostics = zeroy_build_diagnostics((string) $row['diagnostics_hash']);
    $projection = is_array($diagnostics['workspaceProjection'] ?? null) ? $diagnostics['workspaceProjection'] : null;
    return is_array($projection)
        ? ['files' => zeroy_runtime_json_map($projection), 'authoredSeeds' => zeroy_runtime_json_map(is_array($diagnostics['authoredSeeds'] ?? null) ? $diagnostics['authoredSeeds'] : [])]
        : zeroy_runtime_error('zeroy_workspace_projection_missing', 'BuildResult has no workspace projection.', 500);
}
