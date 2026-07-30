<?php
/**
 * The runtime passes $zeroy_object_id, $zeroy_locale, $zeroy_schema_id and $zeroy_route.
 *
 * This template deliberately uses the explicit object × locale × schema API.
 */

defined('ABSPATH') || exit;

$zeroy_content = zeroy_locale_content(
    (int) $zeroy_object_id,
    (string) $zeroy_locale,
    (string) $zeroy_schema_id
);
$zeroy_document = $zeroy_content['nodes'];

get_header();
?>
<main class="zeroy-shell">
  <article class="zeroy-card">
    <div class="zeroy-meta">
      <span>zeroY Runtime Connector</span>
      <span><?php echo esc_html((string) $zeroy_locale); ?></span>
    </div>
    <div class="zeroy-content">
      <h1><?php echo esc_html($zeroy_document['title']); ?></h1>
      <p><?php echo esc_html($zeroy_document['intro']); ?></p>
      <nav class="zeroy-language-switch" aria-label="Language">
        <?php foreach (zeroy_locale_links((string) $zeroy_route) as $zeroy_link) : ?>
          <?php if ($zeroy_link['locale'] === $zeroy_locale) : ?>
            <span><?php echo esc_html($zeroy_link['locale']); ?></span>
          <?php elseif ($zeroy_link['available']) : ?>
            <a href="<?php echo esc_url($zeroy_link['url']); ?>"><?php echo esc_html($zeroy_link['locale']); ?></a>
          <?php endif; ?>
        <?php endforeach; ?>
      </nav>
    </div>
    <p class="zeroy-proof">This page is rendered from one canonical WordPress object and locale-specific documents.</p>
  </article>
</main>
<?php
get_footer();
