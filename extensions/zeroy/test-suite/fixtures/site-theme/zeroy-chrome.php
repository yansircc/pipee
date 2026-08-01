<?php
/**
 * Shared theme chrome: top bar, CTA band, footer.
 *
 * Chrome strings resolve from the SiteCopy LocalizableSubject. Templates never
 * interpret version documents or inherit decisions.
 */

defined('ABSPATH') || exit;

if (!function_exists('zeroy_copy_reader')) {
    function zeroy_copy_reader(string $locale): callable
    {
        $context = zeroy_theme_context();
        $copy = is_array($context) && is_array($context['resolvedContent']['siteCopy'] ?? null)
            ? $context['resolvedContent']['siteCopy']
            : array();

        return static function (string $key, string $fallback = '') use ($copy): string {
            $value = $copy[$key] ?? $fallback;
            return is_string($value) && '' !== $value ? $value : $fallback;
        };
    }
}

if (!function_exists('zeroy_locale_home_url')) {
    function zeroy_locale_home_url(string $locale): string
    {
        $context = zeroy_theme_context();
        $url = is_array($context) ? ($context['resolvedContent']['_site']['homeUrls'][$locale] ?? null) : null;
        return is_string($url) ? $url : '';
    }
}

if (!function_exists('zeroy_render_topbar')) {
    function zeroy_render_topbar(string $locale, string $route): void
    {
        $zyu = zeroy_copy_reader($locale);
        $home = zeroy_locale_home_url($locale);
        $context = zeroy_theme_context();
        $locale_links = is_array($context) && is_array($context['seo']['alternates'] ?? null) ? $context['seo']['alternates'] : array();
        ?>
        <header class="zy-topbar">
          <div class="zy-container zy-topbar-inner">
            <a class="zy-brand" href="<?php echo esc_url($home); ?>">ZeroY<span>&middot;</span>Industrial</a>
            <nav class="zy-nav" aria-label="Primary">
              <a href="<?php echo esc_url($home . '#solutions'); ?>"><?php echo esc_html($zyu('nav_solutions', 'Solutions')); ?></a>
              <a href="<?php echo esc_url($home . '#process'); ?>"><?php echo esc_html($zyu('nav_process', 'Process')); ?></a>
              <a href="<?php echo esc_url($home . '#industries'); ?>"><?php echo esc_html($zyu('nav_industries', 'Industries')); ?></a>
              <a href="<?php echo esc_url($home . '#contact'); ?>"><?php echo esc_html($zyu('nav_contact', 'Contact')); ?></a>
            </nav>
            <div class="zy-top-actions">
              <div class="zy-lang" aria-label="Language">
                <?php foreach ($locale_links as $zeroy_link) : ?>
                  <?php $zeroy_label = 'zh-CN' === $zeroy_link['locale'] ? '中文' : 'EN'; ?>
                  <?php if ($zeroy_link['locale'] === $locale) : ?>
                    <span><?php echo esc_html($zeroy_label); ?></span>
                  <?php elseif ($zeroy_link['available']) : ?>
                    <a href="<?php echo esc_url($zeroy_link['url']); ?>"><?php echo esc_html($zeroy_label); ?></a>
                  <?php endif; ?>
                <?php endforeach; ?>
              </div>
              <a class="zy-btn zy-btn-primary zy-btn-sm" href="<?php echo esc_url($home . '#contact'); ?>"><?php echo esc_html($zyu('cta_primary', 'Request a Proposal')); ?></a>
            </div>
          </div>
        </header>
        <?php
    }
}

if (!function_exists('zeroy_render_cta_band')) {
    function zeroy_render_cta_band(string $locale): void
    {
        $zyu = zeroy_copy_reader($locale);
        ?>
        <section class="zy-cta" id="contact">
          <div class="zy-container">
            <h2><?php echo esc_html($zyu('cta_band_title', 'Discuss Your Project')); ?></h2>
            <p><?php echo esc_html($zyu('cta_band_text', 'Tell us your material, target product and capacity — our engineers will respond with a process proposal and equipment configuration.')); ?></p>
            <div class="zy-hero-actions zy-cta-actions">
              <a class="zy-btn zy-btn-primary" href="mailto:project@example.com"><?php echo esc_html($zyu('cta_primary', 'Request a Proposal')); ?></a>
              <a class="zy-btn zy-btn-outline" href="mailto:project@example.com"><?php echo esc_html($zyu('cta_consult', 'Get Technical Consultation')); ?></a>
            </div>
          </div>
        </section>
        <?php
    }
}

if (!function_exists('zeroy_render_footer')) {
    function zeroy_render_footer(string $locale): void
    {
        $zyu = zeroy_copy_reader($locale);
        ?>
        <footer class="zy-footer">
          <div class="zy-container zy-footer-inner">
            <span>&copy; <?php echo esc_html(gmdate('Y')); ?> ZeroY Industrial &mdash; <?php echo esc_html($zyu('footer_tagline', 'Turnkey production lines & process equipment.')); ?></span>
            <span><?php echo esc_html($zyu('footer_proof', 'Rendered from one canonical object × locale documents.')); ?></span>
          </div>
        </footer>
        <?php
    }
}
