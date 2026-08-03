import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const port = process.env.ZEROY_LOCALWP_PORT ?? "10014";
const endpoint = `http://localhost:${port}/wp-json/zeroy/v1`;
const repository = new URL("../../..", import.meta.url).pathname.replace(/\/$/u, "");
const wp = (...args) =>
  execFileSync("locwp", ["wp", port, "--", ...args], {
    encoding: "utf8",
    env: { ...process.env, ZEROY_ACCEPTANCE_REPOSITORY: repository },
  }).trim();
const key = wp("option", "get", "zeroy_runtime_connection_key");
const fail = (message, evidence) => {
  throw new Error(
    `${message}${evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`}`,
  );
};
const canonicalValue = (value) =>
  Array.isArray(value)
    ? value.map(canonicalValue)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
            .map(([name, entry]) => [name, canonicalValue(entry)]),
        )
      : value;
const requestHash = (value) => {
  const bytes = JSON.stringify(canonicalValue(value));
  return createHash("sha256")
    .update(`push-request\0${Buffer.byteLength(bytes)}\0`)
    .update(bytes)
    .digest("hex");
};
const post = async (path, body) => {
  const response = await fetch(`${endpoint}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zeroy-key": key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const get = async (path) => {
  const response = await fetch(`${endpoint}/${path}`, { headers: { "x-zeroy-key": key } });
  return { status: response.status, body: await response.json() };
};
const makeRequest = (refName, commitHash, mode, label) => {
  const request = {
    checkoutId: label,
    refName,
    expectedCommit: null,
    commitHash,
    mode,
    message: label,
    changeSummary: {
      changedPathCount: 0,
      changedSubjectCount: 0,
      uploadedObjectCount: 0,
      uploadedBytes: 0,
    },
  };
  return { commandId: randomUUID(), requestHash: requestHash(request), ...request };
};

const fixture = JSON.parse(
  wp(
    "eval",
    String.raw`
$repository = getenv('ZEROY_ACCEPTANCE_REPOSITORY');
$root = $repository . '/extensions/zeroy/test-suite/fixtures';
$fixturePostIds = get_posts([
    'post_type' => ['machine', 'production_line', 'service', 'attachment'],
    'post_status' => 'any',
    'posts_per_page' => -1,
    'fields' => 'ids',
]);
foreach ($fixturePostIds as $fixturePostId) {
    get_post_type((int) $fixturePostId) === 'attachment'
        ? wp_delete_attachment((int) $fixturePostId, true)
        : wp_delete_post((int) $fixturePostId, true);
}
$files = [];
foreach ([['site-theme', 'artifacts/theme'], ['site-logic', 'artifacts/site-logic']] as [$source, $target]) {
    $base = $root . '/' . $source . '/';
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if (!$file->isFile()) continue;
        $relative = substr($file->getPathname(), strlen($base));
        $files[$target . '/' . $relative] = ['bytes' => file_get_contents($file->getPathname()), 'mode' => 'file'];
    }
}
$files['site.json'] = ['bytes' => zeroy_checkout_json_bytes([
    'workspaceFormat' => 'zeroy/site-tree@2',
    'defaultLocale' => 'en',
    'locales' => ['en', 'ja', 'it'],
    'collections' => [
        'machines' => ['subjectKind' => 'post', 'postType' => 'machine', 'schemaId' => 'machine'],
        'production-lines' => ['subjectKind' => 'post', 'postType' => 'production_line', 'schemaId' => 'production-line'],
        'services' => ['subjectKind' => 'post', 'postType' => 'service', 'schemaId' => 'service'],
        'pages-home' => ['subjectKind' => 'post', 'postType' => 'page', 'schemaId' => 'home'],
    ],
]), 'mode' => 'file'];
$files['content/site-copy.json'] = ['bytes' => "{}\n", 'mode' => 'file'];
$files['content/posts/pages-home/home.json'] = ['bytes' => zeroy_checkout_json_bytes([
    'route' => '/',
    'post' => ['title' => 'Industrial systems', 'content' => '', 'excerpt' => ''],
    'acf' => new stdClass(),
    'templateContent' => ['hero_title' => 'Industrial systems', 'hero_subtitle' => 'Built for dependable production.', 'cta_title' => 'Plan your project'],
    'terms' => new stdClass(),
]), 'mode' => 'file'];
foreach (['ja' => ['産業システム', '信頼できる生産設備。', 'プロジェクトを計画'], 'it' => ['Sistemi industriali', 'Progettati per una produzione affidabile.', 'Pianifica il progetto']] as $locale => $copy) {
    $files['locales/' . $locale . '/posts/pages-home/home.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'post' => ['title' => $copy[0]],
        'templateContent' => ['hero_title' => $copy[0], 'hero_subtitle' => $copy[1], 'cta_title' => $copy[2]],
    ]), 'mode' => 'file'];
}
global $wpdb;
foreach ($wpdb->get_col($wpdb->prepare('SELECT ID FROM ' . $wpdb->posts . ' WHERE post_name IN (%s, %s)', 'adoption-machine', 'adoption-pixel')) as $staleId) {
    get_post_type((int) $staleId) === 'attachment' ? wp_delete_attachment((int) $staleId, true) : wp_delete_post((int) $staleId, true);
}
foreach (get_terms(['taxonomy' => 'category', 'hide_empty' => false]) as $term) {
    if (!$term instanceof WP_Term) continue;
    if (str_starts_with($term->slug, 'feed-equipment-')) {
        wp_delete_term($term->term_id, 'category');
        continue;
    }
    $ref = (string) get_term_meta($term->term_id, '_zeroy_authored_ref', true);
    if ($ref === '') $ref = $term->slug;
    $files['content/terms/category/' . $ref . '.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'slug' => $term->slug,
        'name' => $term->name,
        'description' => $term->description,
    ]), 'mode' => 'file'];
}
$tree = zeroy_checkout_store_file_tree($files);
$verificationFiles = $files;
$verificationFiles['artifacts/theme/functions.php'] = ['bytes' => "<?php\nupdate_option('forbidden', 'write');\n", 'mode' => 'file'];
$verificationTree = zeroy_checkout_store_file_tree($verificationFiles);
$emptyTree = zeroy_checkout_store_file_tree([]);
if (is_wp_error($tree) || is_wp_error($verificationTree) || is_wp_error($emptyTree)) {
    echo wp_json_encode(['error' => 'tree_setup_failed']);
    return;
}
$active = zeroy_runtime_active_site_release();
$baseReleaseId = is_array($active) ? (string) $active['active_release_id'] : null;
$parent = is_array($active) ? (string) $active['commit_hash'] : null;
$makeCommit = static function (string $treeHash, string $label, int $offset) use ($baseReleaseId, $parent): string|WP_Error {
    $commit = [
        'contract' => 'zeroy/site-commit@1',
        'tree' => $treeHash,
        'parents' => $parent === null ? [] : [$parent],
        'baseReleaseId' => $baseReleaseId,
        'author' => ['principal' => zeroy_checkout_owner_principal(), 'actorSessionId' => 'localwp-site-tree-v2-acceptance'],
        'message' => $label . '-' . wp_generate_uuid4(),
        'createdAt' => gmdate('c', 1785733200 + $offset),
    ];
    $hash = zeroy_checkout_commit_hash($commit);
    if (is_wp_error($hash)) return $hash;
    $stored = zeroy_checkout_store_commit($commit, $hash);
    return is_wp_error($stored) ? $stored : $hash;
};
$left = $makeCommit($tree, 'ready-left', 0);
$right = $makeCommit($tree, 'ready-right', 1);
$invalid = $makeCommit($emptyTree, 'invalid-checkpoint', 2);
$verificationInvalid = $makeCommit($verificationTree, 'verification-invalid', 3);
if (is_wp_error($left) || is_wp_error($right) || is_wp_error($invalid) || is_wp_error($verificationInvalid)) {
    echo wp_json_encode(['error' => 'commit_setup_failed']);
    return;
}
$leftBuild = zeroy_build_compile($left);
$sameBuild = zeroy_build_compile($left);
$factGroup = acf_import_field_group([
    'key' => 'group_zeroy_build_fact_acceptance',
    'title' => 'zeroY Build Fact Acceptance',
    'fields' => [[
        'key' => 'field_zeroy_build_fact_acceptance',
        'label' => 'Build fact',
        'name' => 'build_fact',
        'type' => 'text',
    ]],
    'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'machine']]],
    'active' => true,
]);
$changedFactBuild = zeroy_build_compile($left);
if (is_array($factGroup) && is_int($factGroup['ID'] ?? null)) wp_delete_post($factGroup['ID'], true);
$previousShowOnFront = get_option('show_on_front');
$previousPageOnFront = get_option('page_on_front');
$adoptionPostId = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Adoption candidate', 'post_name' => 'adoption-candidate', 'post_content' => 'Existing WordPress body']);
$adoption = ['ok' => false];
if (is_int($adoptionPostId) && $adoptionPostId > 0) {
    update_option('show_on_front', 'page');
    update_option('page_on_front', $adoptionPostId);
    $adoptionFiles = $files;
    unset($adoptionFiles['content/posts/pages-home/home.json']);
    foreach (array_keys($adoptionFiles) as $path) if (str_starts_with($path, 'locales/')) unset($adoptionFiles[$path]);
    $adoptionFiles['site.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'workspaceFormat' => 'zeroy/site-tree@2',
        'defaultLocale' => 'en',
        'locales' => ['en'],
        'collections' => ['pages-home' => ['subjectKind' => 'post', 'postType' => 'page', 'schemaId' => 'home']],
    ]), 'mode' => 'file'];
    $adoptionTree = zeroy_checkout_store_file_tree($adoptionFiles);
    $adoptionCommit = is_wp_error($adoptionTree) ? $adoptionTree : $makeCommit($adoptionTree, 'adoption-missing', 4);
    $missingBuild = is_wp_error($adoptionCommit) ? $adoptionCommit : zeroy_build_compile($adoptionCommit);
    $seedPath = 'content/posts/pages-home/adoption-candidate.json';
    $seed = is_array($missingBuild) ? ($missingBuild['diagnostics']['authoredSeeds'][$seedPath] ?? null) : null;
    if (is_array($seed) && ($seed['encoding'] ?? null) === 'utf8' && is_string($seed['content'] ?? null)) {
        $reviewedSeed = json_decode($seed['content'], true);
        $reviewedSeed['templateContent'] = ['hero_title' => 'Adoption candidate', 'hero_subtitle' => 'Existing WordPress content', 'cta_title' => 'Contact us'];
        $adoptionFiles[$seedPath] = ['bytes' => zeroy_checkout_json_bytes($reviewedSeed), 'mode' => 'file'];
        $seededTree = zeroy_checkout_store_file_tree($adoptionFiles);
        $seededCommit = is_wp_error($seededTree) ? $seededTree : $makeCommit($seededTree, 'adoption-seeded', 5);
        $seededBuild = is_wp_error($seededCommit) ? $seededCommit : zeroy_build_compile($seededCommit);
        $operations = is_array($seededBuild) ? ($seededBuild['candidate']['operations'] ?? []) : [];
        $adoption = [
            'ok' => is_array($missingBuild)
                && $missingBuild['result']['state'] === 'invalid'
                && is_array($seededBuild)
                && $seededBuild['result']['state'] === 'ready'
            && count(array_filter($operations, static fn(array $operation): bool => ($operation['kind'] ?? null) === 'adoptCanonical' && (int) ($operation['payload']['postId'] ?? 0) === $adoptionPostId && ($operation['payload']['ref'] ?? null) === 'adoption-candidate')) === 1,
            'missingBuild' => is_array($missingBuild) ? $missingBuild['result'] : null,
            'seededBuild' => is_array($seededBuild) ? $seededBuild['result'] : null,
            'seed' => json_decode($seed['content'], true),
        ];
    }
    update_option('show_on_front', $previousShowOnFront);
    update_option('page_on_front', $previousPageOnFront);
    wp_delete_post($adoptionPostId, true);
}
$relatedAdoption = ['ok' => false];
register_post_type('machine', ['public' => true, 'show_ui' => true]);
register_taxonomy_for_object_type('category', 'machine');
$relatedSlug = 'feed-equipment-' . strtolower(substr(wp_generate_uuid4(), 0, 8));
$relatedTerm = wp_insert_term('Feed equipment', 'category', ['slug' => $relatedSlug]);
$relatedTermId = is_wp_error($relatedTerm) ? 0 : (int) $relatedTerm['term_id'];
$relatedAttachmentId = wp_insert_attachment([
    'post_mime_type' => 'image/png',
    'post_title' => 'Adoption pixel',
    'post_status' => 'inherit',
], wp_upload_bits('adoption-pixel.png', null, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true))['file']);
$relatedPostId = wp_insert_post(['post_type' => 'machine', 'post_status' => 'publish', 'post_title' => 'Adoption machine', 'post_name' => 'adoption-machine', 'post_content' => 'Existing machine body']);
if ($relatedTermId > 0 && is_int($relatedAttachmentId) && $relatedAttachmentId > 0 && is_int($relatedPostId) && $relatedPostId > 0) {
    wp_set_object_terms($relatedPostId, [$relatedTermId], 'category', false);
    update_field('field_machine_purpose', 'Existing machine purpose', $relatedPostId);
    update_field('field_machine_capacity', '5 t/h', $relatedPostId);
    update_field('field_machine_gallery', [$relatedAttachmentId], $relatedPostId);
    $relatedFiles = $files;
    foreach (array_keys($relatedFiles) as $path) if (str_starts_with($path, 'locales/')) unset($relatedFiles[$path]);
    $relatedFiles['site.json'] = ['bytes' => zeroy_checkout_json_bytes([
        'workspaceFormat' => 'zeroy/site-tree@2',
        'defaultLocale' => 'en',
        'locales' => ['en'],
        'collections' => [
            'machines' => ['subjectKind' => 'post', 'postType' => 'machine', 'schemaId' => 'machine'],
            'pages-home' => ['subjectKind' => 'post', 'postType' => 'page', 'schemaId' => 'home'],
        ],
    ]), 'mode' => 'file'];
    $relatedTree = zeroy_checkout_store_file_tree($relatedFiles);
    $relatedCommit = is_wp_error($relatedTree) ? $relatedTree : $makeCommit($relatedTree, 'related-adoption-missing', 6);
    $relatedMissingBuild = is_wp_error($relatedCommit) ? $relatedCommit : zeroy_build_compile($relatedCommit);
    $relatedSeeds = is_array($relatedMissingBuild) ? ($relatedMissingBuild['diagnostics']['authoredSeeds'] ?? []) : [];
    foreach ($relatedSeeds as $seedPath => $seed) {
        if (!is_array($seed)) continue;
        $seedBytes = ($seed['encoding'] ?? null) === 'utf8'
            ? ($seed['content'] ?? null)
            : (($seed['encoding'] ?? null) === 'base64' ? base64_decode((string) ($seed['bytesBase64'] ?? ''), true) : null);
        if (is_string($seedBytes)) $relatedFiles[$seedPath] = ['bytes' => $seedBytes, 'mode' => 'file'];
    }
    $relatedSeededTree = zeroy_checkout_store_file_tree($relatedFiles);
    $relatedSeededCommit = is_wp_error($relatedSeededTree) ? $relatedSeededTree : $makeCommit($relatedSeededTree, 'related-adoption-seeded', 7);
    $relatedSeededBuild = is_wp_error($relatedSeededCommit) ? $relatedSeededCommit : zeroy_build_compile($relatedSeededCommit);
    $relatedOperations = is_array($relatedSeededBuild) ? ($relatedSeededBuild['candidate']['operations'] ?? []) : [];
    $kinds = array_count_values(array_map(static fn(array $operation): string => (string) ($operation['kind'] ?? ''), $relatedOperations));
    $relatedAdoption = [
        'ok' => is_array($relatedMissingBuild)
            && $relatedMissingBuild['result']['state'] === 'invalid'
            && isset($relatedSeeds['content/posts/machines/adoption-machine.json'])
            && isset($relatedSeeds['content/terms/category/' . $relatedSlug . '.json'])
            && isset($relatedSeeds['media/adoption-pixel.png'])
            && is_array($relatedSeededBuild)
            && $relatedSeededBuild['result']['state'] === 'ready'
            && ($kinds['adoptCanonical'] ?? 0) === 1
            && count(array_filter($relatedOperations, static fn(array $operation): bool => ($operation['kind'] ?? null) === 'adoptTerm' && (int) ($operation['payload']['termId'] ?? 0) === $relatedTermId)) === 1
            && ($kinds['adoptMedia'] ?? 0) === 1,
        'missingBuild' => is_array($relatedMissingBuild) ? $relatedMissingBuild['result'] : null,
        'seededBuild' => is_array($relatedSeededBuild) ? $relatedSeededBuild['result'] : null,
        'seedPaths' => array_keys($relatedSeeds),
        'operationKinds' => $kinds,
    ];
}
if (is_int($relatedPostId) && $relatedPostId > 0) wp_delete_post($relatedPostId, true);
if (is_int($relatedAttachmentId) && $relatedAttachmentId > 0) wp_delete_attachment($relatedAttachmentId, true);
if ($relatedTermId > 0) wp_delete_term($relatedTermId, 'category');
$invalidBuild = zeroy_build_compile($invalid);
$verificationInvalidBuild = zeroy_build_compile($verificationInvalid);
if (is_wp_error($leftBuild) || is_wp_error($sameBuild) || is_wp_error($changedFactBuild) || is_wp_error($invalidBuild) || is_wp_error($verificationInvalidBuild)) {
    echo wp_json_encode(['error' => 'build_setup_failed']);
    return;
}
$fixtureSite = json_decode($files['site.json']['bytes'], true);
$frontPageFailure = zeroy_build_verification_failure(
    ['code' => 'candidate_default_front_page_missing', 'locale' => 'en', 'repair' => 'Stage one front-page canonical.'],
    $fixtureSite,
    $leftBuild['candidate'],
);
echo wp_json_encode([
    'commits' => [$left, $right, $invalid],
    'readyBuild' => $leftBuild['result'],
    'sameBuild' => $sameBuild['result'],
    'changedFactBuild' => $changedFactBuild['result'],
    'invalidBuild' => $invalidBuild['result'],
    'verificationInvalidBuild' => $verificationInvalidBuild['result'],
    'verificationFailures' => $verificationInvalidBuild['diagnostics']['failures'],
    'frontPageFailure' => $frontPageFailure,
    'adoption' => $adoption,
    'relatedAdoption' => $relatedAdoption,
    'casRef' => 'refs/drafts/acceptance/' . wp_generate_uuid4(),
    'invalidRef' => 'refs/drafts/acceptance/' . wp_generate_uuid4(),
    'releaseRef' => 'refs/drafts/acceptance/' . wp_generate_uuid4(),
]);`,
  ),
);
if (fixture.error) fail("Could not prepare SiteTree v2 acceptance fixture.", fixture);
if (
  fixture.readyBuild?.state !== "ready" ||
  fixture.invalidBuild?.state !== "invalid" ||
  fixture.verificationInvalidBuild?.state !== "invalid" ||
  !fixture.verificationFailures?.some(
    (failure) =>
      failure.phase === "candidate-verification" && failure.code === "theme_persistence_forbidden",
  ) ||
  fixture.frontPageFailure?.documentPath !== "content/posts/pages-home/front-page.json" ||
  fixture.frontPageFailure?.contractPath !==
    ".zeroy/contracts/content/posts/pages-home.schema.json" ||
  fixture.frontPageFailure?.templatePath !== ".zeroy/templates/content/posts/pages-home.json" ||
  fixture.readyBuild?.buildId !== fixture.sameBuild?.buildId ||
  fixture.readyBuild?.buildId === fixture.changedFactBuild?.buildId ||
  fixture.adoption?.ok !== true ||
  fixture.relatedAdoption?.ok !== true
)
  fail("BuildResult identity or invalid-checkpoint preservation is broken.", fixture);

const codec = JSON.parse(
  wp(
    "eval",
    String.raw`
$field = [
    'key' => 'field_root', 'name' => 'root', 'type' => 'group', 'sub_fields' => [
        ['key' => 'field_label', 'name' => 'label', 'type' => 'text'],
        ['key' => 'field_rows', 'name' => 'rows', 'type' => 'repeater', 'sub_fields' => [
            ['key' => 'field_row_key', 'name' => 'row_key', 'type' => 'text'],
            ['key' => 'field_related', 'name' => 'related', 'type' => 'relationship'],
        ]],
        ['key' => 'field_sections', 'name' => 'sections', 'type' => 'flexible_content', 'layouts' => [[
            'name' => 'hero', 'sub_fields' => [
                ['key' => 'field_section_key', 'name' => 'section_key', 'type' => 'text'],
                ['key' => 'field_image', 'name' => 'image', 'type' => 'image'],
            ],
        ]]],
    ],
];
$runtime = [
    'label' => 'Root',
    'rows' => [['row_key' => 'primary', 'related' => [17, 18]]],
    'sections' => [['acf_fc_layout' => 'hero', 'section_key' => 'hero', 'image' => 21]],
];
$itemKeys = [
    '/acf/field_root/field_rows' => 'field_row_key',
    '/acf/field_root/field_sections' => 'field_section_key',
];
$failures = [];
$resolver = static fn(string $kind, mixed $id): array => ['kind' => $kind, 'ref' => $kind . '-' . (string) $id];
$encoded = zeroy_document_acf_encode_field($field, $runtime, $itemKeys, '/acf/field_root', $resolver, 'codec.json', $failures);
$decoded = zeroy_document_acf_decode_field($field, $encoded, $itemKeys, '/acf/field_root', 'codec.json', $failures);
$identityResolver = static fn(string $kind, mixed $value): mixed => is_array($value) && ($value['kind'] ?? null) === $kind ? $value : new WP_Error('reference_not_normalized');
$reencoded = zeroy_document_acf_encode_field($field, $decoded, $itemKeys, '/acf/field_root', $identityResolver, 'codec.json', $failures);
echo wp_json_encode(['ok' => $reencoded === $encoded && $failures === [], 'encoded' => $encoded, 'decoded' => $decoded, 'reencoded' => $reencoded, 'failures' => $failures]);`,
  ),
);
if (codec.ok !== true)
  fail("Group/repeater/flexible/reference ACF codec did not round-trip.", codec);
const acfNoop = JSON.parse(
  wp(
    "eval",
    String.raw`
$postId = wp_insert_post(['post_type' => 'machine', 'post_status' => 'draft', 'post_title' => 'ACF no-op acceptance']);
update_field('machine_capacity', '5-10 t/h', $postId);
$first = zeroy_runtime_write_canonical_acf_field($postId, 'machine_capacity', '5-10 t/h');
$second = zeroy_runtime_write_canonical_acf_field($postId, 'machine_capacity', '6-12 t/h');
$observed = get_field('machine_capacity', $postId, false);
$attachmentId = wp_insert_attachment(['post_mime_type' => 'image/png', 'post_title' => 'ACF no-op image', 'post_status' => 'inherit']);
$attachmentId = is_int($attachmentId) ? $attachmentId : 0;
update_field('machine_gallery', [$attachmentId], $postId);
$gallery = $attachmentId > 0 ? zeroy_runtime_write_canonical_acf_field($postId, 'machine_gallery', [$attachmentId]) : false;
$galleryObserved = get_field('machine_gallery', $postId, false);
wp_delete_post($postId, true);
if ($attachmentId > 0) wp_delete_attachment($attachmentId, true);
echo wp_json_encode([
    'ok' => $first === true && $second === true && $observed === '6-12 t/h' && $gallery === true && $galleryObserved === [(string) $attachmentId],
    'first' => is_wp_error($first) ? $first->get_error_code() : $first,
    'second' => is_wp_error($second) ? $second->get_error_code() : $second,
    'observed' => $observed,
    'gallery' => is_wp_error($gallery) ? $gallery->get_error_code() : $gallery,
    'galleryObserved' => $galleryObserved,
]);`,
  ),
);
if (acfNoop.ok !== true)
  fail("Canonical ACF materialization is not idempotent for unchanged values.", acfNoop);
const termLocale = JSON.parse(
  wp(
    "eval",
    String.raw`
$definition = ['localization' => [
    'contract' => zeroy_localization_policy_contract(),
    'rules' => [
        ['fieldPattern' => '/term/name', 'mode' => 'translated', 'required' => true, 'contextWeight' => 'primary'],
        ['fieldPattern' => '/term/description', 'mode' => 'overridable', 'required' => false, 'contextWeight' => 'supporting'],
    ],
    'repeaterItemKeys' => new stdClass(),
]];
$localizable = zeroy_localization_term_subject_from_values(['kind' => 'term', 'taxonomy' => 'category', 'ref' => 'feed'], 'category', 'Feed', 'Feed equipment');
$localizable = is_wp_error($localizable) ? $localizable : zeroy_document_localizable_with_policy($localizable, $definition);
$failures = [];
$values = is_wp_error($localizable) ? [] : zeroy_document_locale_values(['name' => '飼料', 'description' => '飼料設備'], $localizable, 'locales/ja/terms/category/feed.json', $failures);
echo wp_json_encode(['values' => $values, 'failures' => $failures, 'error' => is_wp_error($localizable) ? $localizable->get_error_code() : null]);`,
  ),
);
if (
  termLocale.error !== null ||
  termLocale.failures.length !== 0 ||
  termLocale.values["/term/name"] !== "飼料" ||
  termLocale.values["/term/description"] !== "飼料設備"
)
  fail("Term locale natural paths diverge from their concrete contract.", termLocale);
const localeContainers = JSON.parse(
  wp(
    "eval",
    String.raw`
$localizable = ['subject' => ['kind' => 'post', 'id' => 1], 'fields' => [
    ['fieldId' => '/post/title', 'policy' => ['mode' => 'translated']],
    ['fieldId' => '/acf/gallery', 'policy' => ['mode' => 'overridable']],
]];
$failures = [];
$values = zeroy_document_locale_values([
    'post' => ['title' => '日本語'],
    'acf' => ['gallery' => []],
    'templateContent' => [],
], $localizable, 'locales/ja/posts/pages/example.json', $failures);
echo wp_json_encode(['values' => $values, 'failures' => $failures]);`,
  ),
);
if (
  localeContainers.failures.length !== 0 ||
  localeContainers.values["/post/title"] !== "日本語" ||
  !Array.isArray(localeContainers.values["/acf/gallery"]) ||
  localeContainers.values["/acf/gallery"].length !== 0
)
  fail(
    "Locale materialization inferred empty JSON container identity from PHP array shape.",
    localeContainers,
  );
const referenceMaterialization = JSON.parse(
  wp(
    "eval",
    String.raw`
$bytes = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true);
$hash = zeroy_checkout_blob_hash($bytes);
$stored = zeroy_checkout_store_object('blob', $hash, $bytes);
$first = is_wp_error($stored) ? $stored : zeroy_checkout_materialization_media(['ref' => 'acceptance/pixel.png', 'hash' => $hash]);
$second = is_wp_error($first) ? $first : zeroy_checkout_materialization_media(['ref' => 'acceptance/pixel.png', 'hash' => $hash]);
$maps = zeroy_checkout_materialization_reference_maps();
$resolved = is_wp_error($second) ? $second : zeroy_checkout_materialization_reference(['kind' => 'media', 'ref' => 'acceptance/pixel.png'], 'media', $maps['posts'], $maps['terms'], $maps['media']);
echo wp_json_encode([
    'ok' => !is_wp_error($first) && !is_wp_error($second) && !is_wp_error($resolved) && $first['attachmentId'] === $second['attachmentId'] && $resolved === $first['attachmentId'],
    'first' => is_wp_error($first) ? $first->get_error_code() : $first,
    'second' => is_wp_error($second) ? $second->get_error_code() : $second,
    'resolved' => is_wp_error($resolved) ? $resolved->get_error_code() : $resolved,
]);`,
  ),
);
if (referenceMaterialization.ok !== true)
  fail(
    "Stable media ref did not materialize idempotently from its SiteObject blob.",
    referenceMaterialization,
  );
const adoptionOrdering = JSON.parse(
  wp(
    "eval",
    String.raw`
register_post_type('machine', ['public' => true, 'show_ui' => true]);
register_taxonomy_for_object_type('category', 'machine');
$postId = wp_insert_post(['post_type' => 'machine', 'post_status' => 'publish', 'post_title' => 'Adoption order acceptance']);
$projection = zeroy_runtime_existing_unmanaged_post($postId);
$operations = [[
    'kind' => 'assignTerms',
    'payload' => ['objectRef' => 'adoption-order', 'terms' => ['category' => []]],
], [
    'kind' => 'adoptCanonical',
    'payload' => [
        'postId' => $postId,
        'ref' => 'adoption-order',
        'schemaId' => 'machine',
        'route' => '/machine/adoption-order/',
        'expectedSourceHash' => is_array($projection) ? $projection['sourceHash'] : '',
    ],
]];
$applied = zeroy_checkout_apply_materialization_plan($operations, ['schemas' => ['machine' => ['canonicalPostTypes' => ['machine']]]]);
$ref = get_post_meta($postId, '_zeroy_authored_ref', true);
$schema = get_post_meta($postId, ZEROY_RUNTIME_SCHEMA_META, true);
wp_delete_post($postId, true);
echo wp_json_encode([
    'ok' => $applied === true && $ref === 'adoption-order' && $schema === 'machine',
    'result' => is_wp_error($applied) ? $applied->get_error_code() : $applied,
    'ref' => $ref,
    'schema' => $schema,
]);`,
  ),
);
if (adoptionOrdering.ok !== true)
  fail(
    "Adopted refs were not bound before dependent materialization operations.",
    adoptionOrdering,
  );

const left = makeRequest(fixture.casRef, fixture.commits[0], "checkpoint", "cas-left");
const right = makeRequest(fixture.casRef, fixture.commits[1], "checkpoint", "cas-right");
const cas = await Promise.all([post("site-push", left), post("site-push", right)]);
const success = cas.find((entry) => entry.status === 201);
const conflict = cas.find((entry) => entry.status === 409);
if (!success || conflict?.body?.error?.code !== "zeroy_remote_ref_changed")
  fail("Concurrent pushes did not produce exactly one CAS winner.", cas);
if (success.body?.build?.state !== "ready" || !success.body?.build?.buildId)
  fail("Checkpoint receipt did not bind its compact ready BuildResult.", success);

const winner = success.body.commit === left.commitHash ? left : right;
const replay = await post("site-push", winner);
if (replay.status !== 200 || !isDeepStrictEqual(replay.body, success.body))
  fail("Response-loss retry did not return the exact stored PushReceipt.", { success, replay });
const reused = await post("site-push", { ...winner, requestHash: "f".repeat(64) });
if (reused.status !== 409 || reused.body?.error?.code !== "zeroy_push_command_reused")
  fail("commandId reuse with a different request was not rejected.", reused);

const exact = await get(
  `site-checkout?source=commit&commit=${encodeURIComponent(winner.commitHash)}`,
);
if (exact.status !== 200 || exact.body?.commit !== winner.commitHash)
  fail("Exact-commit checkout projection is not addressable.", exact);
const files = Array.isArray(exact.body?.files) ? exact.body.files.map((item) => item.path) : [];
const siteFile = exact.body?.files?.find((item) => item.path === "site.json");
const siteObject = siteFile ? await get(`site-objects/${siteFile.hash}`) : null;
const site =
  siteObject?.status === 200 && typeof siteObject.body?.bytesBase64 === "string"
    ? JSON.parse(Buffer.from(siteObject.body.bytesBase64, "base64").toString("utf8"))
    : null;
if (
  site?.workspaceFormat !== "zeroy/site-tree@2" ||
  site?.config !== undefined ||
  files.some((path) => path.startsWith("translations/")) ||
  !files.includes("content/site-copy.json")
)
  fail("Checkout is not the path-owned SiteTree v2 hard cut.", { site, files });

const workspace = await get(`site-builds/${fixture.readyBuild.buildId}/workspace`);
const projected = workspace.body?.files;
const projectedJson = (path) =>
  typeof projected?.[path] === "string" ? JSON.parse(projected[path]) : null;
const frontier = projectedJson(".zeroy/repair-frontier.json");
if (
  workspace.status !== 200 ||
  Array.isArray(workspace.body?.authoredSeeds) ||
  frontier?.state !== "ready" ||
  !projected?.[".zeroy/contracts/content/posts/machines.schema.json"] ||
  !projected?.[".zeroy/templates/content/posts/machines.json"]
)
  fail("Ready BuildResult did not project concrete contracts and templates.", workspace);
const machineContract = projectedJson(".zeroy/contracts/content/posts/machines.schema.json");
const themeContextContract = projectedJson(".zeroy/contracts/theme-context.schema.json");
const zcssAuthoringContract = projectedJson(".zeroy/contracts/zcss-authoring.json");
const lineContract = projectedJson(".zeroy/contracts/content/posts/production-lines.schema.json");
const siteCopyContract = projectedJson(".zeroy/contracts/content/site-copy.schema.json");
const gallery = machineContract?.properties?.acf?.properties?.field_machine_gallery;
const specs = machineContract?.properties?.acf?.properties?.field_machine_specs;
const processRelationship =
  lineContract?.properties?.acf?.properties?.field_process_steps?.additionalProperties?.properties
    ?.field_related_machines;
const secondaryLocale = site.locales.find((locale) => locale !== site.defaultLocale);
const localeSiteCopyContract = projectedJson(
  `.zeroy/contracts/locales/${secondaryLocale}/site-copy.schema.json`,
);
const themeTemplates = ["index.php", "search.php", "404.php"].map(
  (name) => projected?.[`.zeroy/templates/artifacts/theme/${name}`],
);
if (
  gallery?.items?.properties?.kind?.const !== "media" ||
  gallery?.items?.properties?.ref?.type !== "string" ||
  specs?.type !== "object" ||
  specs?.additionalProperties?.properties?.field_spec_name?.type !== "string" ||
  processRelationship?.items?.properties?.kind?.const !== "post" ||
  themeContextContract?.properties?.archiveItems?.items?.properties?.url?.type !== "string" ||
  !themeContextContract?.required?.includes("collection") ||
  zcssAuthoringContract?.contract !== "zeroy/zcss-authoring@1" ||
  !zcssAuthoringContract?.tokens?.some((token) => token.name === "--z-color-on-surface") ||
  !zcssAuthoringContract?.contrastPairs?.some((pair) => pair.id === "surface") ||
  !zcssAuthoringContract?.primitives?.some((primitive) => primitive.className === "z-container") ||
  Array.isArray(siteCopyContract?.properties) ||
  siteCopyContract?.properties === null ||
  typeof siteCopyContract?.properties !== "object" ||
  Array.isArray(localeSiteCopyContract?.properties?.review?.properties) ||
  localeSiteCopyContract?.properties?.review?.properties === null ||
  typeof localeSiteCopyContract?.properties?.review?.properties !== "object" ||
  themeTemplates.some(
    (template) =>
      typeof template !== "string" ||
      !template.includes("wp_head();") ||
      !template.includes("wp_footer();") ||
      !template.includes("wp_body_open();"),
  )
)
  fail("ACF codecs did not project stable media/post refs and keyed repeater rows.", {
    gallery,
    specs,
    processRelationship,
    themeContextContract,
    zcssAuthoringContract,
    siteCopyContract,
    localeSiteCopyContract,
    themeTemplates,
  });

const browserStylesheetDiagnostic = JSON.parse(
  wp(
    "eval",
    String.raw`
$challenge = [
    'challengeHash' => 'challenge',
    'releaseId' => 'release',
    'themeArtifactId' => 'theme',
    'scenarioSetHash' => 'scenarios',
    'stylesheetSetHash' => 'expected-identity',
    'stylesheets' => [
        ['url' => 'https://example.test/generated.css'],
        ['url' => 'https://example.test/site.css'],
    ],
    'scenarios' => [['id' => 'home', 'expectedStatus' => 200, 'expectedRouteKind' => 'singular']],
    'viewports' => [['id' => 'desktop']],
    'contrastPairs' => [],
];
$result = [
    'scenario' => 'home',
    'viewport' => 'desktop',
    'status' => 200,
    'routeKind' => 'singular',
    'stylesheetIdentity' => 'observed-identity',
    'stylesheets' => ['https://example.test/site.css'],
    'documentClientWidth' => 1200,
    'documentScrollWidth' => 1200,
    'overflowElements' => 0,
    'overflowSamples' => [],
    'mediaOverflowElements' => 0,
    'mediaOverflowSamples' => [],
    'focusVisible' => true,
    'reducedMotion' => true,
    'contrastRatios' => [],
];
$evidence = [
    'challengeHash' => 'challenge',
    'releaseId' => 'release',
    'themeArtifactId' => 'theme',
    'scenarioSetHash' => 'scenarios',
    'stylesheetSetHash' => 'expected-identity',
    'verifier' => ['id' => ZEROY_BROWSER_VERIFIER_ID, 'version' => '1', 'engine' => 'fixture', 'engineVersion' => '1'],
    'results' => [$result, $result],
];
$evidence['results'][1]['scenario'] = 'home-two';
$challenge['scenarios'][] = ['id' => 'home-two', 'expectedStatus' => 200, 'expectedRouteKind' => 'singular'];
$verified = zeroy_runtime_verify_browser_evidence($challenge, $evidence);
echo wp_json_encode($verified);`,
  ),
);
const stylesheetFailures = browserStylesheetDiagnostic.failures?.filter(
  (failure) => failure.code === "candidate_browser_stylesheet_identity_failed",
);
const stylesheetEvidence = stylesheetFailures?.[0]?.evidence
  ? JSON.parse(stylesheetFailures[0].evidence)
  : null;
if (
  stylesheetFailures?.length !== 1 ||
  stylesheetEvidence?.expectedIdentity !== "expected-identity" ||
  stylesheetEvidence?.observedIdentity !== "observed-identity" ||
  stylesheetEvidence?.firstDifferenceIndex !== 0 ||
  stylesheetEvidence?.expectedCount !== 2 ||
  stylesheetEvidence?.observedCount !== 1
)
  fail("Browser stylesheet diagnostics are not bounded and actionable.", {
    browserStylesheetDiagnostic,
    stylesheetEvidence,
  });
for (const [path, value] of Object.entries(projected ?? {})) {
  const bytes = Buffer.byteLength(value);
  if (path === ".zeroy/repair-frontier.json" && bytes > 16 * 1024)
    fail("Root repair frontier exceeds its byte budget.", { path, bytes });
  if (path.startsWith(".zeroy/repair-frontier/") && bytes > 64 * 1024)
    fail("Repair frontier shard exceeds its byte budget.", { path, bytes });
  if (path.startsWith(".zeroy/diagnostics/") && path.endsWith(".json") && bytes > 64 * 1024)
    fail("Diagnostic shard exceeds its byte budget.", { path, bytes });
}

const invalid = makeRequest(
  fixture.invalidRef,
  fixture.commits[2],
  "checkpoint",
  "invalid-checkpoint",
);
const invalidResult = await post("site-push", invalid);
if (invalidResult.status !== 201 || invalidResult.body?.build?.state !== "invalid")
  fail("Invalid checkpoint was not preserved with an immutable BuildResult.", invalidResult);
const invalidState = JSON.parse(
  wp(
    "eval",
    `$ref=zeroy_checkout_ref_row('${fixture.invalidRef}'); echo wp_json_encode(['commit'=>$ref['commit_hash'] ?? null]);`,
  ),
);
if (invalidState.commit !== fixture.commits[2])
  fail("Invalid checkpoint did not advance its DraftRef.", invalidState);

const release = makeRequest(
  fixture.releaseRef,
  fixture.commits[0],
  "release",
  "exact-build-release",
);
const releaseResult = await post("site-push", release);
if (
  releaseResult.status !== 201 ||
  releaseResult.body?.build?.buildId !== fixture.readyBuild.buildId ||
  releaseResult.body?.candidate?.state !== "awaiting-browser" ||
  !releaseResult.body?.candidate?.browserVerification
)
  fail(
    "Release did not consume the exact ready BuildResult into a browser-verifiable candidate.",
    releaseResult,
  );

const garbageBytes = `unreachable-${randomUUID()}`;
const garbage = JSON.parse(
  wp(
    "eval",
    `$bytes='${garbageBytes}'; $hash=zeroy_checkout_blob_hash($bytes); $stored=zeroy_checkout_store_object('blob',$hash,$bytes); global $wpdb; $wpdb->update(zeroy_runtime_table('site_objects'), ['created_at'=>gmdate('Y-m-d H:i:s', time()-3*DAY_IN_SECONDS)], ['object_hash'=>$hash]); $gc=zeroy_checkout_gc(DAY_IN_SECONDS); echo wp_json_encode(['hash'=>$hash,'stored'=>$stored,'gc'=>$gc,'remaining'=>zeroy_checkout_object_row($hash)]);`,
  ),
);
if (garbage.remaining !== null || garbage.gc?.deletedObjects < 1)
  fail("Reachability GC did not collect an expired unreachable object.", garbage);

const reachability = JSON.parse(wp("eval", "echo wp_json_encode(zeroy_checkout_reachability());"));
if (!Array.isArray(reachability.issues) || reachability.issues.length !== 0)
  fail("Reachability integrity is not green after checkout acceptance.", reachability);

console.log(
  "zeroY SiteTree v2, immutable BuildResult, checkpoint, CAS, projection-budget, and exact-release acceptance passed.",
);
