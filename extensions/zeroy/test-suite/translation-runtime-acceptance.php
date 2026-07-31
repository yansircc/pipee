<?php
/**
 * Disposable LocalWP proof for the Agent Translation hard cut.
 *
 * Run after activating an Artifact built from mvp-theme:
 * locwp wp <site-id> -- eval-file /absolute/path/to/translation-runtime-acceptance.php
 */

defined('ABSPATH') || exit(1);

function zeroy_translation_accept(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function zeroy_translation_accept_error(mixed $value, string $code, string $message): void
{
    zeroy_translation_accept(is_wp_error($value), $message . ' did not fail.');
    zeroy_translation_accept($value->get_error_code() === $code, $message . ' failed with ' . $value->get_error_code() . '.');
}

function zeroy_translation_required_values(array $job, string $prefix): array
{
    $values = [];
    foreach ($job['fields'] as $field) {
        if ($field['required']) {
            $values[$field['fieldId']] = $prefix . ' ' . $field['fieldId'];
        }
    }
    return $values;
}

function zeroy_translation_field(array $job, string $field_id): ?array
{
    foreach ($job['fields'] as $field) {
        if ($field['fieldId'] === $field_id) {
            return $field;
        }
    }
    return null;
}

function zeroy_translation_menu_item(array $resolved, string $type): ?array
{
    foreach ($resolved['menu']['items'] ?? [] as $item) {
        if (is_array($item) && ($item['type'] ?? null) === $type) {
            return $item;
        }
    }
    return null;
}

function zeroy_translation_inventory_locale(int $post_id, string $locale): ?array
{
    $inventory = zeroy_runtime_inventory(1, 100);
    foreach ($inventory['items'] as $item) {
        if (($item['objectId'] ?? null) !== $post_id) {
            continue;
        }
        foreach ($item['locales'] as $candidate) {
            if (($candidate['locale'] ?? null) === $locale) {
                return $candidate;
            }
        }
    }
    return null;
}

function zeroy_translation_artifact_archive(array $manifest, string $root): string
{
    $tar = zeroy_runtime_staging_root() . '/translation-acceptance-' . wp_generate_uuid4() . '.tar';
    $gzip = $tar . '.gz';
    try {
        $archive = new PharData($tar);
        foreach ($manifest['entries'] as $entry) {
            $archive->addFile($root . '/' . $entry['path'], $entry['path']);
        }
        $archive->compress(Phar::GZ);
        $bytes = file_get_contents($gzip);
        if (!is_string($bytes)) {
            throw new RuntimeException('Could not read Translation acceptance Artifact archive.');
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

function zeroy_translation_activate_policy_fixture(bool $intro_searchable = true, ?string $candidate_url = null): array
{
    $active = zeroy_runtime_active_theme_state();
    zeroy_translation_accept(is_array($active), 'An active ThemeArtifact is required for Translation acceptance.');
    $source = zeroy_runtime_artifact_directory((string) $active['artifact_id']);
    $stage = zeroy_runtime_staging_root() . '/translation-policy-' . wp_generate_uuid4();
    $manifest = zeroy_runtime_scan_theme_tree($source);
    $copied = is_wp_error($manifest) ? $manifest : zeroy_runtime_copy_manifest_tree($source, $stage, $manifest);
    zeroy_translation_accept(!is_wp_error($copied), 'Could not create Translation policy Artifact candidate.');
    $schema_path = $stage . '/zeroy.schema.json';
    chmod($schema_path, 0644);
    $schema = json_decode((string) file_get_contents($schema_path), true);
    $rules = $schema['schemas']['showcase']['localization']['rules'] ?? null;
    zeroy_translation_accept(is_array($rules), 'Acceptance Artifact has no showcase LocalizationPolicy.');
    $fixture_patterns = [
        '/acf/field_zeroy_capacity',
        '/acf/field_zeroy_hero',
        '/acf/field_zeroy_specs/*/field_zeroy_spec_code',
        '/acf/field_zeroy_specs/*/field_zeroy_spec_label',
    ];
    $schema['schemas']['showcase']['localization']['rules'] = [
        ...array_values(array_filter($rules, static fn(array $rule): bool => !in_array($rule['fieldPattern'] ?? null, $fixture_patterns, true))),
        ['fieldPattern' => '/acf/field_zeroy_capacity', 'mode' => 'shared', 'contextWeight' => 'supporting'],
        ['fieldPattern' => '/acf/field_zeroy_hero', 'mode' => 'translated', 'required' => true, 'contextWeight' => 'primary'],
        ['fieldPattern' => '/acf/field_zeroy_specs/*/field_zeroy_spec_code', 'mode' => 'shared', 'contextWeight' => 'hidden'],
        ['fieldPattern' => '/acf/field_zeroy_specs/*/field_zeroy_spec_label', 'mode' => 'translated', 'required' => true, 'contextWeight' => 'primary'],
    ];
    $schema['schemas']['showcase']['localization']['repeaterItemKeys'] = ['/acf/field_zeroy_specs' => 'field_zeroy_spec_code'];
    $schema['schemas']['showcase']['templateContent'] = [
        'title' => ['kind' => 'text', 'searchable' => true, 'localization' => ['mode' => 'translated', 'required' => true, 'contextWeight' => 'primary']],
        'intro' => ['kind' => 'text', 'searchable' => $intro_searchable, 'localization' => ['mode' => 'translated', 'required' => true, 'contextWeight' => 'primary']],
    ];
    $menu_rules = $schema['localizationSubjects']['menu']['localization']['rules'] ?? [];
    if (!in_array('/menu/*/url', array_column($menu_rules, 'fieldPattern'), true)) {
        $schema['localizationSubjects']['menu']['localization']['rules'][] = ['fieldPattern' => '/menu/*/url', 'mode' => 'overridable', 'required' => false, 'contextWeight' => 'supporting'];
    }
    $schema['collections']['categories'] = [
        'kind' => 'taxonomy',
        'label' => 'Categories',
        'route' => 'category',
        'template' => 'zeroy-collection-template.php',
        'schemaId' => 'showcase',
        'taxonomy' => 'category',
    ];
    zeroy_translation_accept(file_put_contents($schema_path, zeroy_runtime_json($schema), LOCK_EX) !== false, 'Could not write Translation policy Artifact candidate.');
    chmod($schema_path, 0444);
    $candidate = zeroy_runtime_scan_theme_tree($stage);
    $uploaded = is_wp_error($candidate) ? $candidate : zeroy_runtime_materialize_artifact_archive($candidate, zeroy_translation_artifact_archive($candidate, $stage));
    zeroy_runtime_remove_artifact_staging($stage);
    zeroy_translation_accept(!is_wp_error($uploaded), 'Could not upload Translation policy Artifact candidate.');
    $prepared = zeroy_runtime_prepare_theme_deployment((string) $uploaded['artifactId'], (string) $active['artifact_id'], ['message' => 'Translation policy acceptance']);
    zeroy_translation_accept(!is_wp_error($prepared) && ($prepared['state'] ?? null) === 'prepared', 'Could not prepare Translation policy Artifact.');
    if ($candidate_url !== null) {
        $query = [];
        parse_str((string) wp_parse_url((string) $prepared['previewUrl'], PHP_URL_QUERY), $query);
        $preview = wp_remote_get(add_query_arg($query, $candidate_url), ['timeout' => 15]);
        zeroy_translation_accept(
            !is_wp_error($preview)
            && wp_remote_retrieve_response_code($preview) === 200
            && str_contains(strtolower((string) wp_remote_retrieve_header($preview, 'x-robots-tag')), 'noindex'),
            'Candidate ThemeSchema preview must resolve existing locale content with its pending Overlay reconciliation.'
        );
    }
    $activated = zeroy_runtime_activate_theme_deployment((string) $prepared['deploymentId']);
    zeroy_translation_accept(!is_wp_error($activated) && ($activated['state'] ?? null) === 'active', 'Could not activate Translation policy Artifact.');
    return $activated;
}

zeroy_translation_accept(function_exists('acf_import_field_group'), 'This proof requires ACF Pro.');

$translation_field_group = [
    'key' => 'group_zeroy_translation_acceptance',
    'title' => 'zeroY Translation Acceptance',
    'fields' => [
        ['key' => 'field_zeroy_capacity', 'label' => 'Capacity', 'name' => 'capacity', 'type' => 'number'],
        ['key' => 'field_zeroy_hero', 'label' => 'Hero copy', 'name' => 'hero_copy', 'type' => 'text'],
        [
            'key' => 'field_zeroy_specs',
            'label' => 'Specifications',
            'name' => 'specifications',
            'type' => 'repeater',
            'sub_fields' => [
                ['key' => 'field_zeroy_spec_code', 'label' => 'Code', 'name' => 'code', 'type' => 'text'],
                ['key' => 'field_zeroy_spec_label', 'label' => 'Label', 'name' => 'label', 'type' => 'text'],
            ],
        ],
    ],
    'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
];
$existing_translation_group = acf_get_field_group('group_zeroy_translation_acceptance');
if (is_array($existing_translation_group) && isset($existing_translation_group['ID'])) {
    $translation_field_group['ID'] = (int) $existing_translation_group['ID'];
}
$imported_translation_group = acf_import_field_group($translation_field_group);
zeroy_translation_accept(is_array($imported_translation_group) && isset($imported_translation_group['ID']), 'Could not persist the Translation acceptance ACF fixture.');

zeroy_translation_activate_policy_fixture();

$config = zeroy_runtime_site_config();
zeroy_translation_accept(!is_wp_error($config), 'SiteConfig is unavailable.');
$target_locale = null;
foreach ($config['enabledLocales'] as $locale) {
    if ($locale['locale'] !== $config['defaultLocale']) {
        $target_locale = $locale['locale'];
        break;
    }
}
zeroy_translation_accept(is_string($target_locale), 'Translation acceptance requires one enabled non-default locale.');
$configured = zeroy_runtime_update_site_config([
    ...$config,
    'translationProfile' => [
        'contract' => 'zeroy/translation-profile@1',
        'companySummary' => 'Industrial equipment manufacturer.',
        'targetAudience' => 'B2B production-line buyers.',
        'brandVoice' => 'Precise, practical and technical.',
        'localeGuidance' => [$target_locale => 'Use direct international technical English.'],
        'glossary' => [['source' => '环模', 'translations' => [$target_locale => 'ring die']]],
        'protectedTerms' => ['zeroY'],
    ],
    'siteCopy' => ['nav_demo' => '产品导航'],
], (int) $config['revision']);
zeroy_translation_accept(!is_wp_error($configured), 'Could not configure TranslationProfile and canonical SiteCopy.');

$post_id = zeroy_runtime_create_canonical('page', 'showcase', 'translation-acceptance-' . wp_generate_password(8, false, false));
zeroy_translation_accept(!is_wp_error($post_id), 'Could not create canonical page fixture.');
$post_id = (int) $post_id['objectId'];
wp_update_post(['ID' => $post_id, 'post_title' => '制粒机', 'post_content' => '适用于连续饲料生产。', 'post_excerpt' => '紧凑型设备。']);
update_field('field_zeroy_capacity', 120, $post_id);
update_field('field_zeroy_hero', '连续生产，稳定产能。', $post_id);
$specifications = [
    ['code' => 'motor', 'label' => '主电机'],
    ['code' => 'die', 'label' => '环模'],
];
update_field('field_zeroy_specs', $specifications, $post_id);

$canonical = zeroy_runtime_canonical($post_id);
zeroy_translation_accept(!is_wp_error($canonical), 'Canonical fixture is unreadable.');
$template = zeroy_runtime_write_template_content($post_id, ['title' => '制粒机', 'intro' => '适用于连续饲料生产。'], (int) $canonical['revision']);
zeroy_translation_accept(!is_wp_error($template), 'Could not write canonical TemplateContent.');

$job = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
zeroy_translation_accept(!is_wp_error($job), 'Could not derive the initial TranslationJob.');
zeroy_translation_accept(zeroy_translation_field($job, '/acf/field_zeroy_capacity') === null, 'Shared ACF capacity must not be writable.');
zeroy_translation_accept(count(array_filter($job['contextFacts'], static fn(array $field): bool => $field['fieldId'] === '/acf/field_zeroy_capacity')) === 1, 'Shared ACF capacity must be compact translation context.');

$shared_write = zeroy_localization_write_translation_draft((string) $job['jobToken'], ['/acf/field_zeroy_capacity' => 130], (int) $job['expectedRevision']);
zeroy_translation_accept_error($shared_write, 'zeroy_translation_field_invalid', 'Shared ACF capacity write');

$draft = zeroy_localization_write_translation_draft((string) $job['jobToken'], zeroy_translation_required_values($job, 'English'), (int) $job['expectedRevision']);
zeroy_translation_accept(!is_wp_error($draft), is_wp_error($draft) ? 'Translation draft failed: ' . $draft->get_error_code() . ' ' . $draft->get_error_message() : 'Translation draft failed.');
zeroy_translation_accept(($draft['state'] ?? null) === 'draft' && is_string($draft['previewUrl'] ?? null), 'Translation draft must return a preview URL.');
$preview = wp_remote_get((string) $draft['previewUrl'], ['timeout' => 15]);
zeroy_translation_accept(!is_wp_error($preview) && wp_remote_retrieve_response_code($preview) === 200 && str_contains(strtolower((string) wp_remote_retrieve_header($preview, 'x-robots-tag')), 'noindex'), 'Translation preview must be an accessible noindex page.');

$published = zeroy_localization_publish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $draft['revision']);
zeroy_translation_accept(!is_wp_error($published) && ($published['state'] ?? null) === 'published', 'Translation draft could not publish.');
$route = zeroy_localization_subject_route(['kind' => 'post', 'id' => $post_id], zeroy_runtime_schema_definition('showcase'));
zeroy_translation_accept(!is_wp_error($route), 'Published post route is invalid.');
$published_page = wp_remote_get(zeroy_runtime_route_url($target_locale, $route), ['timeout' => 15]);
$published_html = is_wp_error($published_page) ? '' : wp_remote_retrieve_body($published_page);
zeroy_translation_accept(!is_wp_error($published_page) && wp_remote_retrieve_response_code($published_page) === 200 && str_contains($published_html, 'hreflang="' . $target_locale . '"') && str_contains($published_html, 'rel="canonical"'), 'Published page must emit zeroY canonical and hreflang links.');
$published_coverage = zeroy_translation_inventory_locale($post_id, $target_locale);
zeroy_translation_accept(($published_coverage['state'] ?? null) === 'published' && is_string($published_coverage['lastPublishedAt'] ?? null) && (($published_coverage['translation']['current'] ?? 0) > 0), 'Inventory must project current translation coverage and its published timestamp.');

$unpublished = zeroy_localization_unpublish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $published['revision']);
zeroy_translation_accept(!is_wp_error($unpublished) && ($unpublished['state'] ?? null) === 'unpublished', 'Unpublish must only move the public pointer.');
$head = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $target_locale);
zeroy_translation_accept($head !== null && $head['published_version_id'] === null && $head['draft_version_id'] !== null, 'Unpublish must retain immutable draft history.');
$republished = zeroy_localization_publish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $unpublished['revision']);
zeroy_translation_accept(!is_wp_error($republished), 'An unpublished overlay must be republishable without rewriting values.');

update_field('field_zeroy_capacity', 160, $post_id);
$shared_changed = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
zeroy_translation_accept(!is_wp_error($shared_changed) && !in_array('stale', array_map(static fn(array $field): string => $field['status'], $shared_changed['fields']), true), 'Shared canonical changes must not stale a translation.');

update_field('field_zeroy_hero', '连续生产，升级产能。', $post_id);
$stale = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
$hero = zeroy_translation_field($stale, '/acf/field_zeroy_hero');
zeroy_translation_accept(!is_wp_error($stale) && is_array($hero) && $hero['status'] === 'stale', 'Only the changed translated source field must stale.');
$stale_coverage = zeroy_translation_inventory_locale($post_id, $target_locale);
zeroy_translation_accept(($stale_coverage['translation']['stale'] ?? 0) === 1, 'Inventory must project only the stale translated field.');
$stale_publish = zeroy_localization_publish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $stale['expectedRevision']);
zeroy_translation_accept_error($stale_publish, 'zeroy_translation_not_publishable', 'Stale translation publish');
$repaired = zeroy_localization_write_translation_draft((string) $stale['jobToken'], ['/acf/field_zeroy_hero' => 'Continuous production with upgraded capacity.'], (int) $stale['expectedRevision']);
zeroy_translation_accept(!is_wp_error($repaired), 'A stale field must be repairable without rewriting unrelated fields.');
$repaired_publish = zeroy_localization_publish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $repaired['revision']);
zeroy_translation_accept(!is_wp_error($repaired_publish), 'Repaired translation could not publish.');

$canonical = zeroy_runtime_canonical($post_id);
$template_changed = is_wp_error($canonical)
    ? $canonical
    : zeroy_runtime_write_template_content($post_id, ['intro' => '适用于连续饲料生产，升级产能。'], (int) $canonical['revision']);
zeroy_translation_accept(!is_wp_error($template_changed), 'Could not change canonical TemplateContent.');
$template_stale = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
$template_intro = zeroy_translation_field($template_stale, '/template-content/intro');
zeroy_translation_accept(!is_wp_error($template_stale) && is_array($template_intro) && $template_intro['status'] === 'stale', 'Canonical TemplateContent changes must stale only their translated field.');
$template_stale_ids = array_column(array_filter($template_stale['fields'], static fn(array $field): bool => $field['status'] === 'stale'), 'fieldId');
zeroy_translation_accept($template_stale_ids === ['/template-content/intro'], 'TemplateContent changes must not stale unrelated translated fields.');
$template_repaired = zeroy_localization_write_translation_draft((string) $template_stale['jobToken'], ['/template-content/intro' => 'For continuous feed production with upgraded capacity.'], (int) $template_stale['expectedRevision']);
zeroy_translation_accept(!is_wp_error($template_repaired), 'A stale TemplateContent field must be repairable without rewriting unrelated fields.');
$template_republished = is_wp_error($template_repaired)
    ? $template_repaired
    : zeroy_localization_publish_translation(['kind' => 'post', 'id' => $post_id], $target_locale, (int) $template_repaired['revision']);
zeroy_translation_accept(!is_wp_error($template_republished), 'A repaired TemplateContent translation could not publish.');

$before_policy_migration = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $target_locale);
$policy_deployment = zeroy_translation_activate_policy_fixture(false, zeroy_runtime_route_url($target_locale, $route));
$after_policy_migration = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $target_locale);
zeroy_translation_accept(
    ($policy_deployment['migratedHeads'] ?? 0) > 0
    && is_array($before_policy_migration)
    && is_array($after_policy_migration)
    && $after_policy_migration['draft_version_id'] !== $before_policy_migration['draft_version_id']
    && $after_policy_migration['published_version_id'] !== $before_policy_migration['published_version_id'],
    'ThemeSchema policy activation must atomically replace published and draft LocaleOverlay pointers.'
);
$policy_migrated_job = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
$policy_migrated_intro = zeroy_translation_field($policy_migrated_job, '/template-content/intro');
zeroy_translation_accept(!is_wp_error($policy_migrated_job) && is_array($policy_migrated_intro) && $policy_migrated_intro['status'] === 'stale', 'ThemeSchema TemplateContent policy changes must preserve the translation value and mark its affected field stale.');

update_field('field_zeroy_specs', array_reverse($specifications), $post_id);
$reordered = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
$reordered_ids = array_column($reordered['fields'], 'fieldId');
$reordered_motor = zeroy_translation_field($reordered, '/acf/field_zeroy_specs/motor/field_zeroy_spec_label');
$reordered_die = zeroy_translation_field($reordered, '/acf/field_zeroy_specs/die/field_zeroy_spec_label');
zeroy_translation_accept(!is_wp_error($reordered) && in_array('/acf/field_zeroy_specs/motor/field_zeroy_spec_label', $reordered_ids, true) && in_array('/acf/field_zeroy_specs/die/field_zeroy_spec_label', $reordered_ids, true) && ($reordered_motor['status'] ?? null) === 'current' && ($reordered_die['status'] ?? null) === 'current', 'Repeater reorder must preserve itemKey translation identity.');
update_field('field_zeroy_specs', [['code' => 'motor', 'label' => '主电机'], ['code' => 'motor', 'label' => '备用电机']], $post_id);
$duplicate = zeroy_localization_translation_job(['kind' => 'post', 'id' => $post_id], $target_locale);
zeroy_translation_accept_error($duplicate, 'zeroy_localization_item_key_duplicate', 'Duplicate repeater itemKey');
update_field('field_zeroy_specs', $specifications, $post_id);

$attachment_id = wp_insert_attachment(['post_title' => '设备照片', 'post_excerpt' => '设备正面', 'post_mime_type' => 'image/jpeg', 'post_status' => 'inherit']);
update_post_meta($attachment_id, '_wp_attachment_image_alt', '设备照片');
$media_job = zeroy_localization_translation_job(['kind' => 'media', 'id' => $attachment_id], $target_locale);
zeroy_translation_accept(!is_wp_error($media_job), 'Media must be a LocalizableSubject.');
$media_draft = zeroy_localization_write_translation_draft((string) $media_job['jobToken'], ['/media/alt' => 'Pellet mill front view'], (int) $media_job['expectedRevision']);
zeroy_translation_accept(!is_wp_error($media_draft), 'Could not draft localized media alt text.');
$media_publish = zeroy_localization_publish_translation(['kind' => 'media', 'id' => $attachment_id], $target_locale, (int) $media_draft['revision']);
$media = zeroy_locale_media($attachment_id, $target_locale);
zeroy_translation_accept(!is_wp_error($media_publish) && !is_wp_error($media) && ($media['media']['attachmentId'] ?? null) === $attachment_id && ($media['media']['alt'] ?? null) === 'Pellet mill front view', 'Localized media must retain one canonical attachment ID.');

$term = wp_insert_term('制粒设备 ' . $post_id, 'category');
zeroy_translation_accept(!is_wp_error($term), 'Could not create taxonomy fixture.');
$term_id = (int) $term['term_id'];
wp_set_post_categories($post_id, [$term_id]);
$term_job = zeroy_localization_translation_job(['kind' => 'term', 'taxonomy' => 'category', 'id' => $term_id], $target_locale);
$term_draft = is_wp_error($term_job) ? $term_job : zeroy_localization_write_translation_draft((string) $term_job['jobToken'], ['/term/name' => 'Pellet Equipment'], (int) $term_job['expectedRevision']);
$term_publish = is_wp_error($term_draft) ? $term_draft : zeroy_localization_publish_translation(['kind' => 'term', 'taxonomy' => 'category', 'id' => $term_id], $target_locale, (int) $term_draft['revision']);
$term_content = zeroy_localization_term_content('category', $term_id, $target_locale);
zeroy_translation_accept(!is_wp_error($term_publish) && !is_wp_error($term_content) && ($term_content['term']['name'] ?? null) === 'Pellet Equipment', 'Term names must resolve through LocaleOverlay.');

$menu_id = wp_create_nav_menu('Translation acceptance menu ' . $post_id);
zeroy_translation_accept(!is_wp_error($menu_id), 'Could not create menu fixture.');
wp_update_nav_menu_item($menu_id, 0, ['menu-item-title' => '设备', 'menu-item-object' => 'page', 'menu-item-object-id' => $post_id, 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish']);
wp_update_nav_menu_item($menu_id, 0, ['menu-item-title' => '分类', 'menu-item-object' => 'category', 'menu-item-object-id' => $term_id, 'menu-item-type' => 'taxonomy', 'menu-item-status' => 'publish']);
wp_update_nav_menu_item($menu_id, 0, ['menu-item-title' => '外部网站', 'menu-item-url' => 'https://example.com/', 'menu-item-type' => 'custom', 'menu-item-status' => 'publish']);
$menu_job = zeroy_localization_translation_job(['kind' => 'menu', 'id' => $menu_id], $target_locale);
$menu_draft = is_wp_error($menu_job) ? $menu_job : zeroy_localization_write_translation_draft((string) $menu_job['jobToken'], zeroy_translation_required_values($menu_job, 'English'), (int) $menu_job['expectedRevision']);
$menu_publish = is_wp_error($menu_draft) ? $menu_draft : zeroy_localization_publish_translation(['kind' => 'menu', 'id' => $menu_id], $target_locale, (int) $menu_draft['revision']);
$menu = zeroy_locale_menu($menu_id, $target_locale);
$menu_post = is_wp_error($menu) ? null : zeroy_translation_menu_item($menu, 'post_type');
$menu_term = is_wp_error($menu) ? null : zeroy_translation_menu_item($menu, 'taxonomy');
$menu_custom = is_wp_error($menu) ? null : zeroy_translation_menu_item($menu, 'custom');
zeroy_translation_accept(!is_wp_error($menu_publish) && ($menu_post['url'] ?? null) === zeroy_runtime_route_url($target_locale, $route) && ($menu_term['url'] ?? null) === zeroy_runtime_route_url($target_locale, 'category/' . get_term_field('slug', $term_id, 'category')) && ($menu_custom['url'] ?? null) === 'https://example.com/', 'Menu labels and target URLs must resolve at the current locale.');

$site_copy_job = zeroy_localization_translation_job(['kind' => 'site-copy', 'id' => 'default'], $target_locale);
$site_copy_draft = is_wp_error($site_copy_job) ? $site_copy_job : zeroy_localization_write_translation_draft((string) $site_copy_job['jobToken'], ['/site-copy/nav_demo' => 'Product navigation'], (int) $site_copy_job['expectedRevision']);
$site_copy_publish = is_wp_error($site_copy_draft) ? $site_copy_draft : zeroy_localization_publish_translation(['kind' => 'site-copy', 'id' => 'default'], $target_locale, (int) $site_copy_draft['revision']);
$site_copy = zeroy_localization_site_copy($target_locale);
zeroy_translation_accept(!is_wp_error($site_copy_publish) && !is_wp_error($site_copy) && ($site_copy['siteCopy']['nav_demo'] ?? null) === 'Product navigation', 'SiteCopy must share the same LocaleOverlay generator.');

echo wp_json_encode([
    'ok' => true,
    'checks' => [
        'policy-owned-writable-fields',
        'draft-preview-publish-unpublish',
        'shared-and-field-level-stale',
        'template-content-stale',
        'theme-deployment-overlay-reconciliation',
        'repeater-item-key',
        'media-alt',
        'term-menu-site-copy',
        'route-seo',
    ],
    'postId' => $post_id,
    'url' => zeroy_runtime_route_url($target_locale, $route),
]);
