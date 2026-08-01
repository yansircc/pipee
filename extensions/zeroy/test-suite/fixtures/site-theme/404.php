<?php
defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';
$zy_context = zeroy_theme_context();
if (is_wp_error($zy_context)) { return; }
$zy_locale = (string) $zy_context['locale'];
get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zy_locale, ''); ?>
  <section class="zy-hero zy-hero-detail"><div class="zy-container">
    <p class="zy-eyebrow">404</p><h1>Page not found</h1><p class="zy-lead">The requested page does not exist.</p>
  </div></section>
  <?php zeroy_render_footer($zy_locale); ?>
</main>
<?php get_footer();
