import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

const port = process.env.ZEROY_LOCALWP_PORT ?? "10014";
assert.equal(port, "10014", "Destructive headless preparation is restricted to LocalWP 10014.");

const php = String.raw`
global $wpdb;

foreach (array_keys(zeroy_runtime_schema_definitions()) as $name) {
    $wpdb->query('TRUNCATE TABLE ' . zeroy_runtime_table($name));
}
zeroy_runtime_install_schema();
zeroy_runtime_ensure_site_config();
$config = zeroy_runtime_default_site_config();
$config['defaultLocale'] = 'en';
$config['enabledLocales'] = [
    ['locale' => 'en', 'label' => 'English', 'urlPrefix' => ''],
    ['locale' => 'ja', 'label' => '日本語', 'urlPrefix' => 'ja'],
    ['locale' => 'it', 'label' => 'Italiano', 'urlPrefix' => 'it'],
];
$config['siteCopy'] = ['site_name' => 'ZeroY Industrial Systems'];
$written = zeroy_runtime_write_site_config_locked($config, 1);
if (is_wp_error($written)) { echo wp_json_encode(['error' => $written->get_error_code(), 'message' => $written->get_error_message(), 'data' => $written->get_error_data()]); return; }

$preserved = ['acf-post-type', 'acf-taxonomy', 'acf-field-group', 'acf-field', 'acf-ui-options-page'];
$ids = $wpdb->get_col("SELECT ID FROM {$wpdb->posts} WHERE post_type NOT IN ('" . implode("','", $preserved) . "')");
foreach ($ids as $id) {
    get_post_type((int) $id) === 'attachment' ? wp_delete_attachment((int) $id, true) : wp_delete_post((int) $id, true);
}
$wpdb->query("DELETE FROM {$wpdb->termmeta} WHERE meta_key LIKE '_zeroy_%'");
$wpdb->query("DELETE FROM {$wpdb->postmeta} WHERE meta_key LIKE '_zeroy_%'");

$postTypeFixtures = [
    ['key' => 'post_type_machine', 'post_type' => 'machine', 'title' => 'Machines', 'singular' => 'Machine', 'route' => 'machine'],
    ['key' => 'post_type_production_line', 'post_type' => 'production_line', 'title' => 'Production Lines', 'singular' => 'Production Line', 'route' => 'production-line'],
    ['key' => 'post_type_service', 'post_type' => 'service', 'title' => 'Services', 'singular' => 'Service', 'route' => 'service'],
];
foreach ($postTypeFixtures as $fixture) acf_import_post_type([
    'key' => $fixture['key'],
    'title' => $fixture['title'],
    'post_type' => $fixture['post_type'],
    'active' => true,
    'labels' => ['name' => $fixture['title'], 'singular_name' => $fixture['singular']],
    'public' => true,
    'show_ui' => true,
    'show_in_rest' => true,
    'has_archive' => true,
    'rewrite' => ['slug' => $fixture['route'], 'with_front' => true, 'feeds' => true, 'pages' => true],
    'supports' => ['title', 'editor', 'excerpt', 'thumbnail'],
]);
$taxonomyFixtures = [
    ['key' => 'taxonomy_line_category', 'taxonomy' => 'line_category', 'title' => 'Line Categories', 'singular' => 'Line Category', 'object_type' => ['production_line'], 'route' => 'line-category'],
    ['key' => 'taxonomy_process_stage', 'taxonomy' => 'process_stage', 'title' => 'Process Stages', 'singular' => 'Process Stage', 'object_type' => ['machine'], 'route' => 'process-stage'],
];
foreach ($taxonomyFixtures as $fixture) acf_import_taxonomy([
    'key' => $fixture['key'],
    'title' => $fixture['title'],
    'taxonomy' => $fixture['taxonomy'],
    'object_type' => $fixture['object_type'],
    'active' => true,
    'labels' => ['name' => $fixture['title'], 'singular_name' => $fixture['singular']],
    'public' => true,
    'show_ui' => true,
    'show_in_rest' => true,
    'rewrite' => ['slug' => $fixture['route'], 'with_front' => true, 'hierarchical' => false],
]);

register_post_type('machine', ['public' => true, 'show_ui' => true, 'rewrite' => ['slug' => 'machine']]);
register_post_type('production_line', ['public' => true, 'show_ui' => true, 'rewrite' => ['slug' => 'production-line']]);
register_post_type('service', ['public' => true, 'show_ui' => true, 'rewrite' => ['slug' => 'service']]);
register_taxonomy('line_category', ['production_line'], ['public' => true, 'rewrite' => ['slug' => 'line-category']]);
register_taxonomy('process_stage', ['machine'], ['public' => true, 'rewrite' => ['slug' => 'process-stage']]);
foreach (['line_category', 'process_stage'] as $taxonomy) {
    foreach (get_terms(['taxonomy' => $taxonomy, 'hide_empty' => false, 'fields' => 'ids']) as $term_id) wp_delete_term((int) $term_id, $taxonomy);
}

$pixel = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true);
$uploaded = wp_upload_bits('industrial-demo.png', null, $pixel);
$attachment = wp_insert_attachment(['post_mime_type' => 'image/png', 'post_title' => 'Industrial demo', 'post_status' => 'inherit'], $uploaded['file']);

$insert = static function (string $type, string $title, string $slug, string $content, string $excerpt): int {
    return (int) wp_insert_post(['post_type' => $type, 'post_status' => 'publish', 'post_title' => $title, 'post_name' => $slug, 'post_content' => $content, 'post_excerpt' => $excerpt]);
};
$machines = [
    $insert('machine', 'Ring Die Pellet Mill', 'ring-die-pellet-mill', 'High-throughput pelletizing for feed and biomass plants.', 'Stable output with efficient transmission.'),
    $insert('machine', 'Hammer Mill', 'hammer-mill', 'Fine grinding equipment for consistent particle size.', 'Industrial grinding for varied raw materials.'),
    $insert('machine', 'Counterflow Cooler', 'counterflow-cooler', 'Uniform cooling protects pellet quality after pressing.', 'Low-energy cooling for finished pellets.'),
];
$machineFacts = [
    ['Pelletizing feed, biomass and organic fertilizer', '3-12 t/h', [['Main motor', '132 kW'], ['Die diameter', '520 mm']]],
    ['Grinding corn, wheat and fibrous ingredients', '5-15 t/h', [['Rotor speed', '2980 rpm'], ['Screen', '2-8 mm']]],
    ['Cooling hot pellets to near ambient temperature', '5-20 t/h', [['Cooling area', '9 m²'], ['Discharge', 'Variable frequency']]],
];
foreach ($machines as $index => $id) {
    update_field('field_machine_purpose', $machineFacts[$index][0], $id);
    update_field('field_machine_capacity', $machineFacts[$index][1], $id);
    update_field('field_machine_specs', array_map(static fn(array $row): array => ['field_spec_name' => $row[0], 'field_spec_value' => $row[1]], $machineFacts[$index][2]), $id);
    update_field('field_machine_gallery', [$attachment], $id);
    update_field('field_machine_video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', $id);
}
$processTerms = [];
foreach ([['material-preparation', 'Material Preparation'], ['size-reduction', 'Size Reduction'], ['pellet-finishing', 'Pellet Finishing']] as $term) {
    $created = wp_insert_term($term[1], 'process_stage', ['slug' => $term[0]]);
    $processTerms[] = is_wp_error($created) ? 0 : (int) $created['term_id'];
}
foreach ($machines as $index => $id) if (($processTerms[$index] ?? 0) > 0) wp_set_object_terms($id, [$processTerms[$index]], 'process_stage');

$lines = [
    $insert('production_line', 'Animal Feed Pellet Line', 'animal-feed-pellet-line', 'A complete automated line from raw material intake to bagging.', 'A scalable turnkey feed production system.'),
    $insert('production_line', 'Biomass Pellet Line', 'biomass-pellet-line', 'Integrated preparation, drying, pelletizing and cooling.', 'Turn agricultural residues into dense fuel pellets.'),
    $insert('production_line', 'Premix Feed Line', 'premix-feed-line', 'Precision dosing and mixing for premix production.', 'Traceable small-batch formulation and packing.'),
];
$lineTerms = [];
foreach ([['feed-lines', 'Feed Lines'], ['biomass-lines', 'Biomass Lines'], ['premix-lines', 'Premix Lines']] as $term) {
    $created = wp_insert_term($term[1], 'line_category', ['slug' => $term[0]]);
    $lineTerms[] = is_wp_error($created) ? 0 : (int) $created['term_id'];
}
foreach ($lines as $index => $id) {
    update_field('field_applicable_products', ['Feed pellets', 'Biomass pellets', 'Premix'][ $index ], $id);
    update_field('field_applicable_materials', ['Corn, soybean meal and additives', 'Wood chips, straw and husk', 'Vitamins, minerals and carriers'][ $index ], $id);
    update_field('field_capacity_description', ['5-10 t/h', '3-8 t/h', '1-3 t/h'][ $index ], $id);
    update_field('field_automation_level', 'PLC automatic control', $id);
    update_field('field_project_purpose', ['新建工厂'], $id);
    update_field('field_process_steps', [
        ['field_step_name' => 'Preparation', 'field_step_description' => 'Raw materials are cleaned and prepared.', 'field_related_machines' => [$machines[1]]],
        ['field_step_name' => 'Forming', 'field_step_description' => 'Material is processed to the required product.', 'field_related_machines' => [$machines[0], $machines[2]]],
    ], $id);
    update_field('field_technical_specs', [['field_spec_name' => 'Installed power', 'field_spec_value' => ['520 kW', '430 kW', '260 kW'][$index]]], $id);
    update_field('field_delivery_scope', ['方案设计', '定制制造', '安装', '调试', '培训'], $id);
    update_field('field_line_gallery', [$attachment], $id);
    if ($lineTerms[$index] > 0) wp_set_object_terms($id, [$lineTerms[$index]], 'line_category');
}

$services = [
    $insert('service', 'Plant Engineering', 'plant-engineering', 'Process design, layout and utility planning for new plants.', 'Engineering from feasibility to construction drawings.'),
    $insert('service', 'Installation and Commissioning', 'installation-commissioning', 'Site installation, cold commissioning and production ramp-up.', 'A controlled path from delivery to stable output.'),
    $insert('service', 'Lifecycle Support', 'lifecycle-support', 'Spare parts, maintenance planning and capacity upgrades.', 'Keep the plant productive throughout its lifecycle.'),
];
foreach ($services as $index => $id) {
    update_field('field_applicable_projects', ['新建工厂', '升级改造'], $id);
    update_field('field_service_items', [['field_item_title' => 'Scope review', 'field_item_description' => 'Confirm goals, constraints and interfaces.']], $id);
    update_field('field_service_deliverables', [['field_deliverable_name' => 'Project package', 'field_deliverable_description' => 'Documented deliverables for the selected service.']], $id);
    update_field('field_service_steps', [['field_step_name' => 'Assessment', 'field_step_description' => 'Collect facts and define the work plan.'], ['field_step_name' => 'Delivery', 'field_step_description' => 'Execute, verify and hand over.']], $id);
    update_field('field_service_gallery', [$attachment], $id);
}

update_option('show_on_front', 'posts');
update_option('page_on_front', 0);
update_option('blogname', 'ZeroY Industrial Systems');
flush_rewrite_rules(false);

echo wp_json_encode([
    'ok' => true,
    'siteId' => get_option(ZEROY_RUNTIME_SITE_ID_OPTION),
    'posts' => ['machine' => $machines, 'production_line' => $lines, 'service' => $services],
    'attachment' => $attachment,
    'terms' => ['line_category' => $lineTerms, 'process_stage' => $processTerms],
    'zeroYRefs' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_refs')),
    'activeRelease' => zeroy_runtime_active_site_release(),
]);
`;

const output = execFileSync("locwp", ["wp", port, "--", "eval", php], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const result = JSON.parse(output);
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.zeroYRefs, 0);
assert.equal(result.activeRelease, null);

const bootstrapOutput = execFileSync(
  "locwp",
  [
    "wp",
    port,
    "--",
    "eval",
    String.raw`
$commitHash = zeroy_checkout_seed_bootstrap_commit();
$build = is_wp_error($commitHash) ? $commitHash : zeroy_build_compile($commitHash);
if (is_wp_error($build)) {
    echo wp_json_encode(['error' => $build->get_error_code(), 'message' => $build->get_error_message()]);
    return;
}
$commit = zeroy_checkout_commit_row($commitHash);
$files = zeroy_checkout_read_tree_files((string) $commit['tree_hash']);
$site = json_decode((string) $files['site.json']['bytes'], true);
$invalidSeedRoutes = [];
$seedContracts = [];
foreach ($build['diagnostics']['authoredSeeds'] ?? [] as $path => $seed) {
    if (($seed['encoding'] ?? null) === 'utf8' && str_ends_with($path, '.json')) {
        $contractPath = zeroy_workspace_contract_for_document($path, $site);
        $contractBytes = is_string($contractPath) ? ($build['diagnostics']['workspaceProjection'][$contractPath] ?? null) : null;
        $seedContracts[] = ['path' => $path, 'contractPath' => $contractPath, 'document' => json_decode((string) $seed['content']), 'schema' => is_string($contractBytes) ? json_decode($contractBytes) : null];
    }
    if (!str_starts_with($path, 'content/posts/') || ($seed['encoding'] ?? null) !== 'utf8') continue;
    $document = json_decode((string) ($seed['content'] ?? ''), true);
    if (!is_string($document['route'] ?? null) || !str_starts_with($document['route'], '/')) $invalidSeedRoutes[] = $path;
}
echo wp_json_encode([
    'collections' => array_keys($site['collections'] ?? []),
    'seedPaths' => array_keys($build['diagnostics']['authoredSeeds'] ?? []),
    'termContracts' => array_values(array_filter(array_keys($build['diagnostics']['workspaceProjection'] ?? []), static fn(string $path): bool => str_starts_with($path, '.zeroy/contracts/content/terms/'))),
    'seedContracts' => $seedContracts,
    'invalidSeedRoutes' => $invalidSeedRoutes,
]);`,
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const bootstrap = JSON.parse(bootstrapOutput);
assert.deepEqual(bootstrap.invalidSeedRoutes, []);
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
for (const seed of bootstrap.seedContracts) {
  assert.equal(
    typeof seed.contractPath,
    "string",
    `Connector-authored seed ${seed.path} has no WorkspaceContract.`,
  );
  assert.notEqual(
    seed.schema,
    null,
    `Connector-authored seed ${seed.path} has no projected ${seed.contractPath}.`,
  );
  const validate = ajv.compile(seed.schema);
  assert.equal(
    validate(seed.document),
    true,
    `Connector-authored seed ${seed.path} violates ${seed.contractPath}: ${JSON.stringify(validate.errors)}`,
  );
}
assert.deepEqual(bootstrap.collections.sort(), [
  "front-page",
  "machine",
  "pages",
  "production-line",
  "service",
]);
for (const expected of [
  "content/posts/machine/ring-die-pellet-mill.json",
  "content/posts/production-line/animal-feed-pellet-line.json",
  "content/posts/service/plant-engineering.json",
  "content/terms/line_category/feed-lines.json",
  "media/industrial-demo.png",
])
  assert(
    bootstrap.seedPaths.includes(expected),
    `Bootstrap did not project ${expected}: ${JSON.stringify(bootstrap)}`,
  );
for (const expected of [
  ".zeroy/contracts/content/terms/line_category.schema.json",
  ".zeroy/contracts/content/terms/process_stage.schema.json",
])
  assert(
    bootstrap.termContracts.includes(expected),
    `Bootstrap did not project ${expected}: ${JSON.stringify(bootstrap)}`,
  );
process.stdout.write(`${JSON.stringify(result)}\n`);
