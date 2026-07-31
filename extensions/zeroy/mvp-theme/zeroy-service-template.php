<?php
/**
 * zeroY service detail template.
 *
 * WordPress/ACF facts resolve through the LocaleOverlay runtime.
 */

defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';

$zeroy_object_id = (int) $zeroy_object_id;
$zeroy_locale = (string) $zeroy_locale;
$zeroy_route = (string) $zeroy_route;

$zeroy_content = zeroy_locale_content($zeroy_object_id, $zeroy_locale, (string) $zeroy_schema_id);
$zyu = zeroy_copy_reader($zeroy_locale);

$zy_field = static function (string $name) use ($zeroy_content) {
    return $zeroy_content['acf'][$name] ?? null;
};

$zy_row_text = static function (array $row, string $name): string {
    foreach (array($name, 'field_' . $name) as $key) {
        if (isset($row[$key]) && is_string($row[$key])) {
            return $row[$key];
        }
    }
    return '';
};

$zy_title = (string) ($zeroy_content['post']['title'] ?? '');
$zy_intro = (string) ($zeroy_content['post']['content'] ?? '');

$zy_projects = (array) $zy_field('applicable_projects');
$zy_items = (array) $zy_field('service_items');
$zy_deliverables = (array) $zy_field('service_deliverables');
$zy_steps = (array) $zy_field('service_steps');

get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zeroy_locale, $zeroy_route); ?>

  <section class="zy-hero zy-hero-detail">
    <div class="zy-container">
      <a class="zy-back" href="<?php echo esc_url(zeroy_locale_home_url($zeroy_locale)); ?>">&larr; <?php echo esc_html($zyu('back_home', 'Back to Home')); ?></a>
      <p class="zy-eyebrow"><?php echo esc_html($zyu('label_cpt_service', 'Project Service')); ?></p>
      <h1><?php echo esc_html($zy_title); ?></h1>
      <?php if ('' !== $zy_intro) : ?>
        <p class="zy-lead"><?php echo esc_html($zy_intro); ?></p>
      <?php endif; ?>
      <?php if (array() !== $zy_projects) : ?>
        <div class="zy-chips">
          <?php foreach ($zy_projects as $zy_p) : ?>
            <span class="zy-chip"><?php echo esc_html((string) $zy_p); ?></span>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
  </section>

  <?php if (array() !== $zy_items) : ?>
    <section class="zy-section">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_items', 'Service Items')); ?></h2>
        </div>
        <div class="zy-cards">
          <?php $zy_n = 0; ?>
          <?php foreach ($zy_items as $zy_row) : ?>
            <?php
            if (!is_array($zy_row)) {
                continue;
            }
            $zy_n++;
            ?>
            <article class="zy-card">
              <div class="zy-card-body">
                <span class="zy-index">0<?php echo (int) $zy_n; ?></span>
                <h3><?php echo esc_html($zy_row_text($zy_row, 'item_title')); ?></h3>
                <p><?php echo esc_html($zy_row_text($zy_row, 'item_description')); ?></p>
              </div>
            </article>
          <?php endforeach; ?>
        </div>
      </div>
    </section>
  <?php endif; ?>

  <?php if (array() !== $zy_deliverables) : ?>
    <section class="zy-section zy-section-alt">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_deliverables', 'Deliverables')); ?></h2>
        </div>
        <div class="zy-glance">
          <?php foreach ($zy_deliverables as $zy_row) : ?>
            <?php if (!is_array($zy_row)) { continue; } ?>
            <div class="zy-glance-card">
              <h3><?php echo esc_html($zy_row_text($zy_row, 'deliverable_name')); ?></h3>
              <p><?php echo esc_html($zy_row_text($zy_row, 'deliverable_description')); ?></p>
            </div>
          <?php endforeach; ?>
        </div>
      </div>
    </section>
  <?php endif; ?>

  <?php if (array() !== $zy_steps) : ?>
    <section class="zy-section">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_steps', 'Implementation Steps')); ?></h2>
        </div>
        <div class="zy-steps zy-steps-3">
          <?php $zy_n = 0; ?>
          <?php foreach ($zy_steps as $zy_row) : ?>
            <?php
            if (!is_array($zy_row)) {
                continue;
            }
            $zy_n++;
            ?>
            <article class="zy-step">
              <span class="zy-num"><?php echo esc_html($zyu('step_prefix', 'Step')); ?> 0<?php echo (int) $zy_n; ?></span>
              <h3><?php echo esc_html($zy_row_text($zy_row, 'step_name')); ?></h3>
              <p><?php echo esc_html($zy_row_text($zy_row, 'step_description')); ?></p>
            </article>
          <?php endforeach; ?>
        </div>
      </div>
    </section>
  <?php endif; ?>

  <?php zeroy_render_cta_band($zeroy_locale); ?>
  <?php zeroy_render_footer($zeroy_locale); ?>
</main>
<?php
get_footer();
