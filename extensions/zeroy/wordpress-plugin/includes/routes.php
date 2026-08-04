<?php

defined('ABSPATH') || exit;

function zeroy_runtime_request_path(): string
{
    $preview_path = $GLOBALS['zeroy_runtime_preview_route_path'] ?? null;
    if (is_string($preview_path)) return strtolower(trim(rawurldecode($preview_path), '/'));
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    return is_string($path) ? strtolower(trim(rawurldecode($path), '/')) : '';
}

/** Non-request projections use the persisted SiteConfig URL algebra. */
function zeroy_runtime_route_url(string $locale, string $route): string
{
    $locale_config = zeroy_runtime_locale_config($locale);
    if ($locale_config === null) return home_url('/');
    $path = trim(($locale_config['urlPrefix'] === '' ? '' : $locale_config['urlPrefix'] . '/') . trim($route, '/'), '/');
    $preview = zeroy_runtime_preview_release_context();
    if (is_array($preview) && ($preview['kind'] ?? null) === 'administrator-preview' && is_array($preview['release'] ?? null)) {
        return zeroy_runtime_admin_preview_url((string) $preview['release']['release_id'], $path);
    }
    return home_url('/' . $path . '/');
}

/** The only input boundary exposed to ThemeArtifact PHP. */
function zeroy_theme_context(): array|WP_Error
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    return is_array($context)
        ? $context
        : zeroy_runtime_error('zeroy_theme_context_missing', 'The current request has no zeroY ThemeRenderContext.', 500);
}

function zeroy_runtime_set_theme_context(array $context): void
{
    foreach (['routeKind', 'locale', 'preview', 'subject', 'resolvedContent', 'searchQuery', 'archiveItems', 'seo'] as $key) {
        if (!array_key_exists($key, $context)) wp_die('The zeroY ThemeRenderContext is incomplete.', 'zeroY render unavailable', ['response' => 500]);
    }
    header('X-zeroY-route-kind: ' . (string) $context['routeKind'], true);
    header('X-zeroY-locale: ' . (string) $context['locale'], true);
    $GLOBALS['zeroy_runtime_theme_context'] = $context;
}

function zeroy_runtime_clear_theme_context(): void
{
    unset($GLOBALS['zeroy_runtime_theme_context']);
}

function zeroy_runtime_render_snapshot_route(): void
{
    $release = zeroy_runtime_request_site_release();
    if (!is_array($release)) return;
    $snapshot = zeroy_runtime_request_snapshot();
    if (is_wp_error($snapshot)) wp_die($snapshot->get_error_message(), 'zeroY render unavailable', ['response' => 503]);
    $query = [];
    if (isset($_GET['s']) && is_string($_GET['s'])) $query['s'] = sanitize_text_field(wp_unslash($_GET['s']));
    if (isset($_GET['page']) && is_numeric($_GET['page'])) $query['page'] = max(1, (int) $_GET['page']);
    $projection = zeroy_runtime_snapshot_context($snapshot, '/' . zeroy_runtime_request_path(), $query, ($release['candidate'] ?? false) === true);
    if (is_wp_error($projection)) wp_die($projection->get_error_message(), 'zeroY render unavailable', ['response' => 500]);
    $context = $projection['context'];
    status_header($context['routeKind'] === 'not-found' ? 404 : 200);
    if (($release['candidate'] ?? false) === true) {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
    }
    header('X-zeroY-snapshot-hash: ' . (string) $snapshot['snapshotHash'], true);
    header('X-zeroY-projection-hash: ' . (string) $projection['projectionHash'], true);
    header('X-zeroY-template: ' . (string) $projection['template'], true);
    header('X-zeroY-schema-id: ' . (string) ($context['subject']['schemaId'] ?? ''), true);
    zeroy_runtime_set_theme_context($context);
    $template = rtrim((string) $release['themeDirectory'], '/') . '/' . ltrim((string) $projection['template'], '/');
    if (!is_file($template) || is_link($template)) wp_die('SiteSnapshot references a missing template.', 'zeroY render unavailable', ['response' => 500]);
    include $template;
    zeroy_runtime_clear_theme_context();
    exit;
}
add_action('template_redirect', 'zeroy_runtime_render_snapshot_route', -100);

/** Used only while constructing non-request subjects such as menu links. */
function zeroy_runtime_locale_links_for_post(int $post_id, string $route): array
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) return [];
    $post = get_post($post_id);
    $links = [];
    foreach ($config['enabledLocales'] as $locale) {
        $available = $locale['locale'] === $config['defaultLocale']
            ? $post instanceof WP_Post && $post->post_status === 'publish'
            : (($head = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $locale['locale'])) !== null && $head['published_version_id'] !== null);
        $links[] = ['locale' => $locale['locale'], 'available' => $available, 'url' => $available ? zeroy_runtime_route_url($locale['locale'], $route) : null];
    }
    return $links;
}

function zeroy_locale_links(string $route): array
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    return is_array($context) && is_array($context['seo']['alternates'] ?? null)
        ? $context['seo']['alternates']
        : [];
}

function zeroy_runtime_localized_title_parts(array $parts): array
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    if (!is_array($context)) return $parts;
    if (is_array($context['collection'] ?? null)) {
        $parts['title'] = (string) ($context['collection']['title'] ?? '');
    } elseif (is_string($context['resolvedContent']['post']['title'] ?? null) && $context['resolvedContent']['post']['title'] !== '') {
        $parts['title'] = $context['resolvedContent']['post']['title'];
    } elseif (($context['routeKind'] ?? null) === 'search') {
        $parts['title'] = 'Search';
    }
    return $parts;
}
add_filter('document_title_parts', 'zeroy_runtime_localized_title_parts');

function zeroy_runtime_emit_seo_links(): void
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    if (!is_array($context) || ($context['preview'] ?? false)) return;
    foreach ($context['seo']['alternates'] ?? [] as $link) {
        if (($link['available'] ?? false) !== true || !is_string($link['url'] ?? null)) continue;
        if (($link['locale'] ?? null) === $context['locale']) echo '<link rel="canonical" href="' . esc_url($link['url']) . "\" />\n";
        echo '<link rel="alternate" hreflang="' . esc_attr($link['locale']) . '" href="' . esc_url($link['url']) . "\" />\n";
    }
}
add_action('wp_head', 'zeroy_runtime_emit_seo_links', 1);
