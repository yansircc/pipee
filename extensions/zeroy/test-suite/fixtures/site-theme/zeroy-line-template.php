<?php
/**
 * zeroY production line detail template.
 *
 * WordPress/ACF facts resolve through the LocaleOverlay runtime.
 */

defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';

$zy_context = zeroy_theme_context();
if (is_wp_error($zy_context)) { return; }
$zeroy_locale = (string) $zy_context['locale'];
$zeroy_route = (string) ($zy_context['route'] ?? '');
$zeroy_content = is_array($zy_context['resolvedContent'] ?? null) ? $zy_context['resolvedContent'] : [];
$zyu = zeroy_copy_reader($zeroy_locale);

$zy_field = static function (string $key) use ($zeroy_content) {
    return $zeroy_content['acf'][$key] ?? null;
};

$zy_lines = static function ($value): array {
    if (!is_string($value)) {
        return array();
    }
    return array_values(array_filter(array_map('trim', preg_split('/\r\n|\r|\n/', $value))));
};

$zy_row_text = static function (array $row, string $key): string {
    return isset($row[$key]) && is_string($row[$key]) ? $row[$key] : '';
};

$zy_machine_id = static function ($machine): int {
    $id = 0;
    if ($machine instanceof WP_Post) {
        $id = (int) $machine->ID;
    } elseif (is_numeric($machine)) {
        $id = (int) $machine;
    } elseif (is_array($machine) && isset($machine['ID'])) {
        $id = (int) $machine['ID'];
    }
    return $id;
};

$zy_title = (string) ($zeroy_content['post']['title'] ?? '');
$zy_intro = (string) ($zeroy_content['post']['content'] ?? '');

$zy_products = $zy_lines($zy_field('field_applicable_products'));
$zy_materials = $zy_lines($zy_field('field_applicable_materials'));
$zy_capacity = $zy_field('field_applicable_products') ? (string) $zy_field('field_capacity_description') : '';
$zy_automation = (string) $zy_field('field_automation_level');
$zy_purpose = (array) $zy_field('field_project_purpose');
$zy_delivery = (array) $zy_field('field_delivery_scope');
$zy_steps = (array) $zy_field('field_process_steps');
$zy_specs = (array) $zy_field('field_technical_specs');
$zy_machine_ids = array();
foreach ($zy_steps as $zy_step) {
    if (!is_array($zy_step)) {
        continue;
    }
    $zy_related = $zy_step['field_related_machines'] ?? array();
    foreach (is_array($zy_related) ? $zy_related : array() as $zy_machine) {
        $zy_id = $zy_machine_id($zy_machine);
        if ($zy_id > 0) {
            $zy_machine_ids[$zy_id] = $zy_id;
        }
    }
}
$zy_machine_projection = array();
if (array() !== $zy_machine_ids) {
    $zy_entities = is_array($zeroy_content['_entities'] ?? null) ? $zeroy_content['_entities'] : array();
    foreach ($zy_machine_ids as $zy_related_machine_id) {
        $zy_entity = $zy_entities[(string) $zy_related_machine_id] ?? null;
        if (is_array($zy_entity)) {
            $zy_machine_projection[$zy_related_machine_id] = $zy_entity;
        }
    }
}
$zy_machine_link = static function ($machine) use ($zy_machine_id, $zy_machine_projection): ?array {
    $id = $zy_machine_id($machine);
    $entity = $zy_machine_projection[$id] ?? null;
    return is_array($entity) && is_string($entity['url'] ?? null)
        ? array($entity['url'], (string) ($entity['fields']['post']['title'] ?? ''))
        : null;
};

get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zeroy_locale, $zeroy_route); ?>

  <section class="zy-hero zy-hero-detail">
    <div class="zy-container">
      <a class="zy-back" href="<?php echo esc_url(zeroy_locale_home_url($zeroy_locale)); ?>">&larr; <?php echo esc_html($zyu('back_home', 'Back to Home')); ?></a>
      <p class="zy-eyebrow"><?php echo esc_html($zyu('label_cpt_line', 'Turnkey Production Line')); ?></p>
      <h1><?php echo esc_html($zy_title); ?></h1>
      <?php if ('' !== $zy_intro) : ?>
        <p class="zy-lead"><?php echo esc_html($zy_intro); ?></p>
      <?php endif; ?>
      <?php if (array() !== $zy_purpose) : ?>
        <div class="zy-chips" data-zeroy-field="/acf/field_project_purpose">
          <?php foreach ($zy_purpose as $zy_p) : ?>
            <span class="zy-chip"><?php echo esc_html((string) $zy_p); ?></span>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
  </section>

  <section class="zy-section">
    <div class="zy-container">
      <div class="zy-glance">
        <?php if (array() !== $zy_products) : ?>
          <div class="zy-glance-card" data-zeroy-field="/acf/field_applicable_products">
            <h3><?php echo esc_html($zyu('label_applicable_products', 'Applicable Products')); ?></h3>
            <ul>
              <?php foreach ($zy_products as $zy_item) : ?>
                <li><?php echo esc_html($zy_item); ?></li>
              <?php endforeach; ?>
            </ul>
          </div>
        <?php endif; ?>
        <?php if (array() !== $zy_materials) : ?>
          <div class="zy-glance-card" data-zeroy-field="/acf/field_applicable_materials">
            <h3><?php echo esc_html($zyu('label_applicable_materials', 'Applicable Materials')); ?></h3>
            <ul>
              <?php foreach ($zy_materials as $zy_item) : ?>
                <li><?php echo esc_html($zy_item); ?></li>
              <?php endforeach; ?>
            </ul>
          </div>
        <?php endif; ?>
        <?php if ('' !== $zy_capacity) : ?>
          <div class="zy-glance-card" data-zeroy-field="/acf/field_capacity_description">
            <h3><?php echo esc_html($zyu('label_capacity', 'Capacity')); ?></h3>
            <p><?php echo esc_html($zy_capacity); ?></p>
          </div>
        <?php endif; ?>
        <?php if ('' !== $zy_automation) : ?>
          <div class="zy-glance-card" data-zeroy-field="/acf/field_automation_level">
            <h3><?php echo esc_html($zyu('label_automation', 'Automation Level')); ?></h3>
            <p><?php echo esc_html($zy_automation); ?></p>
          </div>
        <?php endif; ?>
      </div>
      <?php if (array() !== $zy_delivery) : ?>
        <div class="zy-delivery" data-zeroy-field="/acf/field_delivery_scope">
          <h3><?php echo esc_html($zyu('label_delivery', 'Delivery Scope')); ?></h3>
          <div class="zy-chips zy-chips-light">
            <?php foreach ($zy_delivery as $zy_d) : ?>
              <span class="zy-chip zy-chip-light"><?php echo esc_html((string) $zy_d); ?></span>
            <?php endforeach; ?>
          </div>
        </div>
      <?php endif; ?>
    </div>
  </section>

  <?php if (array() !== $zy_steps) : ?>
    <section class="zy-section zy-section-alt" data-zeroy-field="/acf/field_process_steps">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_process', 'Process Steps & Equipment')); ?></h2>
        </div>
        <div class="zy-steps zy-steps-3">
          <?php $zy_n = 0; ?>
          <?php foreach ($zy_steps as $zy_row) : ?>
            <?php
            if (!is_array($zy_row)) {
                continue;
            }
            $zy_n++;
            $zy_related = $zy_row['field_related_machines'] ?? array();
            ?>
            <article class="zy-step">
              <span class="zy-num"><?php echo esc_html($zyu('step_prefix', 'Step')); ?> 0<?php echo (int) $zy_n; ?></span>
              <h3><?php echo esc_html($zy_row_text($zy_row, 'field_step_name')); ?></h3>
              <p><?php echo esc_html($zy_row_text($zy_row, 'field_step_description')); ?></p>
              <?php if (is_array($zy_related) && array() !== $zy_related) : ?>
                <div class="zy-machine-links">
                  <?php foreach ($zy_related as $zy_machine) : ?>
                    <?php $zy_link = $zy_machine_link($zy_machine); ?>
                    <?php if (null !== $zy_link) : ?>
                      <a href="<?php echo esc_url($zy_link[0]); ?>"><?php echo esc_html($zy_link[1]); ?></a>
                    <?php endif; ?>
                  <?php endforeach; ?>
                </div>
              <?php endif; ?>
            </article>
          <?php endforeach; ?>
        </div>
      </div>
    </section>
  <?php endif; ?>

  <?php if (array() !== $zy_specs) : ?>
    <section class="zy-section" data-zeroy-field="/acf/field_technical_specs">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_specs', 'Technical Specifications')); ?></h2>
        </div>
        <dl class="zy-spec-table">
          <?php foreach ($zy_specs as $zy_row) : ?>
            <?php if (!is_array($zy_row)) { continue; } ?>
            <div class="zy-spec-row">
              <dt><?php echo esc_html($zy_row_text($zy_row, 'field_spec_name')); ?></dt>
              <dd><?php echo esc_html($zy_row_text($zy_row, 'field_spec_value')); ?></dd>
            </div>
          <?php endforeach; ?>
        </dl>
      </div>
    </section>
  <?php endif; ?>

  <?php zeroy_render_cta_band($zeroy_locale); ?>
  <?php zeroy_render_footer($zeroy_locale); ?>
</main>
<?php
get_footer();
