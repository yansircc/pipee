<?php
defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';
$zy_context = zeroy_theme_context();
if (is_wp_error($zy_context)) { return; }
$zy_locale = (string) $zy_context['locale'];
$zy_search_url = is_string($zy_context['seo']['canonical'] ?? null) ? $zy_context['seo']['canonical'] : '';
$zy_query = (string) ($zy_context['searchQuery'] ?? '');
$zy_items = is_array($zy_context['archiveItems'] ?? null) ? $zy_context['archiveItems'] : [];

get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zy_locale, (string) ($zy_context['route'] ?? 'search')); ?>
  <section class="zy-hero zy-hero-detail"><div class="zy-container">
    <p class="zy-eyebrow">Search</p>
    <h1><?php echo esc_html($zy_query === '' ? 'Search' : 'Search results'); ?></h1>
    <form method="get" action="<?php echo esc_url($zy_search_url); ?>">
      <label><span class="screen-reader-text">Search</span><input type="search" name="s" value="<?php echo esc_attr($zy_query); ?>"></label>
      <button class="zy-btn zy-btn-primary" type="submit">Search</button>
    </form>
  </div></section>
  <section class="zy-section"><div class="zy-container">
    <?php if ($zy_items === []) : ?><p class="zy-lead">No matching results.</p>
    <?php else : ?><div class="zy-cards">
      <?php foreach ($zy_items as $zy_item) : ?><article class="zy-card zy-archive-card"><div class="zy-card-body">
        <h2><a href="<?php echo esc_url((string) ($zy_item['url'] ?? '#')); ?>"><?php echo esc_html((string) ($zy_item['fields']['post']['title'] ?? '')); ?></a></h2>
        <p><?php echo esc_html((string) ($zy_item['fields']['post']['excerpt'] ?? '')); ?></p>
      </div></article><?php endforeach; ?>
    </div><?php endif; ?>
  </div></section>
  <?php zeroy_render_footer($zy_locale); ?>
</main>
<?php get_footer();
