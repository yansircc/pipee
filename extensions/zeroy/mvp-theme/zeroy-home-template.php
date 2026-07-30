<?php
/**
 * zeroY industrial home template.
 *
 * Page content comes from zeroy_locale_content(); theme chrome is shared
 * via zeroy-chrome.php and reads ThemeCopy documents.
 */

defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';

$zeroy_content = zeroy_locale_content(
    (int) $zeroy_object_id,
    (string) $zeroy_locale,
    (string) $zeroy_schema_id
);
$zeroy_document = $zeroy_content['nodes'];

$zy = static function (string $key, string $fallback = '') use ($zeroy_document): string {
    $value = $zeroy_document[$key] ?? $fallback;
    return is_string($value) ? $value : $fallback;
};

$zyu = zeroy_copy_reader((string) $zeroy_locale);

get_header();
?>
<main class="zy-home">
  <?php zeroy_render_topbar((string) $zeroy_locale, (string) $zeroy_route); ?>

  <section class="zy-hero">
    <div class="zy-container">
      <div class="zy-hero-grid">
        <div class="zy-hero-copy">
          <p class="zy-eyebrow"><?php echo esc_html($zy('hero_eyebrow')); ?></p>
          <h1><?php echo esc_html($zy('hero_title')); ?></h1>
          <p class="zy-lead"><?php echo esc_html($zy('hero_subtitle')); ?></p>
          <div class="zy-hero-actions">
            <a class="zy-btn zy-btn-primary" href="#contact"><?php echo esc_html($zyu('cta_primary', 'Request a Proposal')); ?></a>
            <a class="zy-btn zy-btn-outline" href="#solutions"><?php echo esc_html($zyu('cta_explore', 'Explore Solutions')); ?></a>
          </div>
        </div>
        <div class="zy-hero-media">
          <img src="<?php echo esc_url($zy('hero_image')); ?>" alt="<?php echo esc_attr($zy('hero_title')); ?>">
        </div>
      </div>
      <div class="zy-hero-stats">
        <?php for ($i = 1; $i <= 3; $i++) : ?>
          <div class="zy-stat">
            <b><?php echo esc_html($zy("stat_{$i}_value")); ?></b>
            <span><?php echo esc_html($zy("stat_{$i}_label")); ?></span>
          </div>
        <?php endfor; ?>
      </div>
    </div>
  </section>

  <section class="zy-section" id="solutions">
    <div class="zy-container">
      <div class="zy-section-head">
        <p class="zy-eyebrow"><?php echo esc_html($zy('solutions_eyebrow')); ?></p>
        <h2><?php echo esc_html($zy('solutions_title')); ?></h2>
        <p><?php echo esc_html($zy('solutions_subtitle')); ?></p>
      </div>
      <div class="zy-cards">
        <?php for ($i = 1; $i <= 3; $i++) : ?>
          <article class="zy-card">
            <img src="<?php echo esc_url($zy("solution_{$i}_image")); ?>" alt="<?php echo esc_attr($zy("solution_{$i}_title")); ?>" loading="lazy">
            <div class="zy-card-body">
              <span class="zy-index">0<?php echo (int) $i; ?></span>
              <h3><?php echo esc_html($zy("solution_{$i}_title")); ?></h3>
              <p><?php echo esc_html($zy("solution_{$i}_text")); ?></p>
            </div>
          </article>
        <?php endfor; ?>
      </div>
    </div>
  </section>

  <section class="zy-section zy-section-alt" id="process">
    <div class="zy-container">
      <div class="zy-section-head">
        <p class="zy-eyebrow"><?php echo esc_html($zy('process_eyebrow')); ?></p>
        <h2><?php echo esc_html($zy('process_title')); ?></h2>
        <p><?php echo esc_html($zy('process_subtitle')); ?></p>
      </div>
      <div class="zy-steps">
        <?php for ($i = 1; $i <= 4; $i++) : ?>
          <article class="zy-step">
            <span class="zy-num"><?php echo esc_html($zyu('step_prefix', 'Step')); ?> 0<?php echo (int) $i; ?></span>
            <h3><?php echo esc_html($zy("step_{$i}_title")); ?></h3>
            <p><?php echo esc_html($zy("step_{$i}_text")); ?></p>
          </article>
        <?php endfor; ?>
      </div>
    </div>
  </section>

  <section class="zy-section zy-industries" id="industries">
    <div class="zy-container">
      <div class="zy-section-head">
        <p class="zy-eyebrow"><?php echo esc_html($zy('industries_eyebrow')); ?></p>
        <h2><?php echo esc_html($zy('industries_title')); ?></h2>
      </div>
      <p class="zy-industries-list"><?php echo esc_html($zy('industries_text')); ?></p>
    </div>
  </section>

  <section class="zy-cta" id="contact">
    <div class="zy-container">
      <h2><?php echo esc_html($zy('cta_title')); ?></h2>
      <p><?php echo esc_html($zy('cta_text')); ?></p>
      <div class="zy-hero-actions zy-cta-actions">
        <a class="zy-btn zy-btn-primary" href="mailto:project@example.com"><?php echo esc_html($zyu('cta_primary', 'Request a Proposal')); ?></a>
        <a class="zy-btn zy-btn-outline" href="mailto:project@example.com"><?php echo esc_html($zyu('cta_consult', 'Get Technical Consultation')); ?></a>
      </div>
    </div>
  </section>

  <?php zeroy_render_footer((string) $zeroy_locale); ?>
</main>
<?php
get_footer();
