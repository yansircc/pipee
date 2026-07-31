<?php
/**
 * zeroY machine detail template.
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

$zy_purpose = (string) $zy_field('machine_purpose');
$zy_capacity = (string) $zy_field('machine_capacity');
$zy_specs = (array) $zy_field('machine_specs');
$zy_video = (string) $zy_field('machine_video');

get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zeroy_locale, $zeroy_route); ?>

  <section class="zy-hero zy-hero-detail">
    <div class="zy-container">
      <a class="zy-back" href="<?php echo esc_url(zeroy_locale_home_url($zeroy_locale)); ?>">&larr; <?php echo esc_html($zyu('back_home', 'Back to Home')); ?></a>
      <p class="zy-eyebrow"><?php echo esc_html($zyu('label_cpt_machine', 'Core Equipment')); ?></p>
      <h1><?php echo esc_html($zy_title); ?></h1>
      <?php if ('' !== $zy_intro) : ?>
        <p class="zy-lead"><?php echo esc_html($zy_intro); ?></p>
      <?php endif; ?>
      <?php if ('' !== $zy_capacity) : ?>
        <div class="zy-chips">
          <span class="zy-chip"><strong><?php echo esc_html($zyu('label_capacity', 'Capacity')); ?></strong>&nbsp;&middot;&nbsp;<?php echo esc_html($zy_capacity); ?></span>
        </div>
      <?php endif; ?>
    </div>
  </section>

  <section class="zy-section">
    <div class="zy-container">
      <div class="zy-glance">
        <?php if ('' !== $zy_purpose) : ?>
          <div class="zy-glance-card">
            <h3><?php echo esc_html($zyu('label_purpose', 'Purpose')); ?></h3>
            <p><?php echo esc_html($zy_purpose); ?></p>
          </div>
        <?php endif; ?>
        <?php if ('' !== $zy_video) : ?>
          <div class="zy-glance-card">
            <h3><?php echo esc_html($zyu('label_video', 'Video')); ?></h3>
            <p><?php echo esc_html($zyu('label_watch_video', 'Watch the machine in operation.')); ?></p>
            <a class="zy-btn zy-btn-primary zy-btn-sm" href="<?php echo esc_url($zy_video); ?>" target="_blank" rel="noopener"><?php echo esc_html($zyu('label_watch_video', 'Watch Video')); ?> &nearr;</a>
          </div>
        <?php endif; ?>
      </div>
    </div>
  </section>

  <?php if (array() !== $zy_specs) : ?>
    <section class="zy-section zy-section-alt">
      <div class="zy-container">
        <div class="zy-section-head">
          <h2><?php echo esc_html($zyu('label_specs', 'Technical Specifications')); ?></h2>
        </div>
        <dl class="zy-spec-table">
          <?php foreach ($zy_specs as $zy_row) : ?>
            <?php if (!is_array($zy_row)) { continue; } ?>
            <div class="zy-spec-row">
              <dt><?php echo esc_html($zy_row_text($zy_row, 'spec_name')); ?></dt>
              <dd><?php echo esc_html($zy_row_text($zy_row, 'spec_value')); ?></dd>
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
