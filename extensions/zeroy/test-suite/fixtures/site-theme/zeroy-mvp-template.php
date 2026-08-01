<?php

defined('ABSPATH') || exit;

$zy_context = zeroy_theme_context();
if (is_wp_error($zy_context)) { return; }
$zeroy_locale = (string) $zy_context['locale'];
$zeroy_route = (string) ($zy_context['route'] ?? '');
$zeroy_content = is_array($zy_context['resolvedContent'] ?? null) ? $zy_context['resolvedContent'] : [];
$zeroy_template_content = is_array($zeroy_content['templateContent'] ?? null) ? $zeroy_content['templateContent'] : [];

get_header();
?>
<main class="zeroy-shell">
  <article class="zeroy-card">
    <div class="zeroy-meta"><span>zeroY Runtime Connector</span><span><?php echo esc_html((string) $zeroy_locale); ?></span></div>
    <div class="zeroy-content">
      <h1><?php echo esc_html((string) ($zeroy_template_content['title'] ?? $zeroy_content['post']['title'] ?? '')); ?></h1>
      <p><?php echo esc_html((string) ($zeroy_template_content['intro'] ?? $zeroy_content['post']['content'] ?? '')); ?></p>
      <nav class="zeroy-language-switch" aria-label="Language">
        <?php foreach (is_array($zy_context['seo']['alternates'] ?? null) ? $zy_context['seo']['alternates'] : array() as $zeroy_link) : ?>
          <?php if ($zeroy_link['locale'] === $zeroy_locale) : ?><span><?php echo esc_html($zeroy_link['locale']); ?></span>
          <?php elseif ($zeroy_link['available']) : ?><a href="<?php echo esc_url($zeroy_link['url']); ?>"><?php echo esc_html($zeroy_link['locale']); ?></a><?php endif; ?>
        <?php endforeach; ?>
      </nav>
    </div>
  </article>
</main>
<?php get_footer();
