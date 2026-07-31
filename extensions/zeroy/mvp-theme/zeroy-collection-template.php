<?php
/**
 * Generic CollectionRoute template.
 *
 * Route identity, locale alternates, SEO and resolved entity selection are
 * Connector-owned. This file owns only visual rendering.
 */

defined('ABSPATH') || exit;

require_once get_stylesheet_directory() . '/zeroy-chrome.php';

$zy_context = zeroy_collection_context();
if (is_wp_error($zy_context)) {
    return;
}
$zy_page = max(1, (int) get_query_var('paged', 1));
$zy_result = zeroy_collection_items(['url', '/post/title', '/post/excerpt'], $zy_page, 12);
if (is_wp_error($zy_result)) {
    $zy_result = ['items' => [], 'total' => 0];
}
$zy_locale = (string) $zy_context['locale'];

get_header();
?>
<main class="zy-home zy-detail">
  <?php zeroy_render_topbar($zy_locale, (string) $zy_context['route']); ?>

  <section class="zy-hero zy-hero-detail">
    <div class="zy-container">
      <a class="zy-back" href="<?php echo esc_url(zeroy_locale_home_url($zy_locale)); ?>">&larr; Home</a>
      <h1><?php echo esc_html((string) $zy_context['title']); ?></h1>
    </div>
  </section>

  <section class="zy-section">
    <div class="zy-container">
      <?php if (count($zy_result['items']) === 0) : ?>
        <p class="zy-lead">No published items yet.</p>
      <?php else : ?>
        <div class="zy-cards">
          <?php foreach ($zy_result['items'] as $zy_item) : ?>
            <?php
            $zy_title = (string) ($zy_item['fields']['post']['title'] ?? '');
            $zy_excerpt = (string) ($zy_item['fields']['post']['excerpt'] ?? '');
            ?>
            <article class="zy-card zy-archive-card">
              <div class="zy-card-body">
                <h3><a href="<?php echo esc_url($zy_item['url']); ?>"><?php echo esc_html($zy_title); ?></a></h3>
                <?php if ($zy_excerpt !== '') : ?>
                  <p><?php echo esc_html($zy_excerpt); ?></p>
                <?php endif; ?>
                <a class="zy-card-link" href="<?php echo esc_url($zy_item['url']); ?>">View details &rarr;</a>
              </div>
            </article>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </div>
  </section>

  <?php zeroy_render_cta_band($zy_locale); ?>
  <?php zeroy_render_footer($zy_locale); ?>
</main>
<?php
get_footer();
