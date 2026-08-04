<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_SNAPSHOT_CONTRACT = 'zeroy/site-snapshot@2';

function zeroy_runtime_snapshot_relative_request(array $snapshot, string $request_path): array|WP_Error
{
    $site = $snapshot['site'] ?? null;
    if (!is_array($site) || !is_string($site['defaultLocale'] ?? null) || !is_array($site['enabledLocales'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_snapshot_invalid', 'SiteSnapshot has no valid site projection.', 500);
    }
    $path = strtolower(trim(rawurldecode($request_path), '/'));
    foreach ($site['enabledLocales'] as $locale) {
        if (!is_array($locale) || !is_string($locale['locale'] ?? null) || !is_string($locale['urlPrefix'] ?? null)) {
            return zeroy_runtime_error('zeroy_site_snapshot_invalid', 'SiteSnapshot contains an invalid locale projection.', 500);
        }
        $prefix = trim(strtolower($locale['urlPrefix']), '/');
        if ($prefix !== '' && ($path === $prefix || str_starts_with($path, $prefix . '/'))) {
            return ['locale' => $locale['locale'], 'route' => $path === $prefix ? '' : substr($path, strlen($prefix) + 1)];
        }
    }
    return ['locale' => $site['defaultLocale'], 'route' => $path];
}

function zeroy_runtime_snapshot_route_url(array $snapshot, string $locale, string $route): string|WP_Error
{
    $site = $snapshot['site'] ?? null;
    if (!is_array($site) || !is_string($site['baseUrl'] ?? null) || !is_array($site['enabledLocales'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_snapshot_invalid', 'SiteSnapshot has no valid URL projection.', 500);
    }
    foreach ($site['enabledLocales'] as $locale_config) {
        if (!is_array($locale_config) || ($locale_config['locale'] ?? null) !== $locale) continue;
        $prefix = is_string($locale_config['urlPrefix'] ?? null) ? trim($locale_config['urlPrefix'], '/') : '';
        $path = trim(($prefix === '' ? '' : $prefix . '/') . trim($route, '/'), '/');
        return rtrim($site['baseUrl'], '/') . '/' . ($path === '' ? '' : $path . '/');
    }
    return zeroy_runtime_error('zeroy_site_snapshot_locale_missing', 'SiteSnapshot does not contain the requested locale.', 404, ['locale' => $locale]);
}

function zeroy_runtime_snapshot_route_links(array $snapshot, string $route_id): array|WP_Error
{
    $site = $snapshot['site'] ?? null;
    $routes = $snapshot['routeUrls'][$route_id] ?? null;
    if (!is_array($site) || !is_array($site['enabledLocales'] ?? null) || !is_array($routes)) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_invalid', 'SiteSnapshot route identity is incomplete.', 500, ['routeId' => $route_id]);
    }
    $links = [];
    foreach ($site['enabledLocales'] as $locale) {
        $name = is_array($locale) ? ($locale['locale'] ?? null) : null;
        if (!is_string($name)) return zeroy_runtime_error('zeroy_site_snapshot_invalid', 'SiteSnapshot contains an invalid locale.', 500);
        $route = $routes[$name] ?? null;
        $url = is_string($route) ? zeroy_runtime_snapshot_route_url($snapshot, $name, $route) : null;
        if (is_wp_error($url)) return $url;
        $links[] = ['locale' => $name, 'available' => is_string($route), 'url' => $url];
    }
    return $links;
}

function zeroy_runtime_snapshot_page(array $items, int $page, int $per_page): array
{
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    return [
        'items' => array_slice(array_values($items), ($page - 1) * $per_page, $per_page),
        'page' => $page,
        'perPage' => $per_page,
        'total' => count($items),
    ];
}

function zeroy_runtime_snapshot_search(array $items, string $query, int $page, int $per_page): array
{
    $needle = mb_strtolower(trim($query));
    $matches = array_values(array_filter($items, static function (array $item) use ($needle): bool {
        $post = is_array($item['fields']['post'] ?? null) ? $item['fields']['post'] : [];
        return $needle === ''
            || str_contains(mb_strtolower((string) ($post['title'] ?? '')), $needle)
            || str_contains(mb_strtolower((string) ($post['excerpt'] ?? '')), $needle);
    }));
    return zeroy_runtime_snapshot_page($matches, $page, $per_page);
}

function zeroy_runtime_snapshot_context(array $snapshot, string $request_path, array $query = [], bool $preview = true): array|WP_Error
{
    if (($snapshot['contract'] ?? null) !== ZEROY_SITE_SNAPSHOT_CONTRACT || !is_array($snapshot['routes'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_snapshot_invalid', 'SiteSnapshot contract or route projection is invalid.', 500);
    }
    $request = zeroy_runtime_snapshot_relative_request($snapshot, $request_path);
    if (is_wp_error($request)) return $request;
    $locale_routes = $snapshot['routes'][$request['locale']] ?? null;
    if (!is_array($locale_routes)) return zeroy_runtime_error('zeroy_site_snapshot_locale_missing', 'SiteSnapshot has no routes for the requested locale.', 404, ['locale' => $request['locale']]);
    $descriptor = $locale_routes[$request['route']] ?? ($snapshot['notFound'][$request['locale']] ?? null);
    if (!is_array($descriptor) || !is_string($descriptor['routeKind'] ?? null) || !is_string($descriptor['routeId'] ?? null) || !is_string($descriptor['template'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_invalid', 'SiteSnapshot route descriptor is invalid.', 500, ['locale' => $request['locale'], 'route' => $request['route']]);
    }
    $links = zeroy_runtime_snapshot_route_links($snapshot, $descriptor['routeId']);
    if (is_wp_error($links)) return $links;
    $canonical = zeroy_runtime_snapshot_route_url($snapshot, $request['locale'], (string) ($descriptor['route'] ?? $request['route']));
    if (is_wp_error($canonical)) return $canonical;
    $search_query = null;
    $archive = ['items' => [], 'page' => 1, 'perPage' => 12, 'total' => 0];
    if (in_array($descriptor['routeKind'], ['archive', 'taxonomy'], true)) {
        $archive = zeroy_runtime_snapshot_page(is_array($descriptor['items'] ?? null) ? $descriptor['items'] : [], (int) ($query['page'] ?? 1), (int) ($query['perPage'] ?? 12));
    } elseif ($descriptor['routeKind'] === 'search') {
        $search_query = is_string($query['s'] ?? null) ? $query['s'] : '';
        $catalog = $snapshot['searchItems'][$request['locale']] ?? [];
        $archive = zeroy_runtime_snapshot_search(is_array($catalog) ? $catalog : [], $search_query, (int) ($query['page'] ?? 1), (int) ($query['perPage'] ?? 12));
    }
    $global_content = ['siteCopy' => $snapshot['siteCopy']['locales'][$request['locale']]['view']['siteCopy'] ?? [], '_entities' => [], '_site' => ['homeUrls' => []]];
    foreach (($snapshot['searchItems'][$request['locale']] ?? []) as $item) {
        $key = is_int($item['objectId'] ?? null) ? (string) $item['objectId'] : zeroy_runtime_hash($item['subject'] ?? []);
        $global_content['_entities'][$key] = $item;
    }
    foreach ($snapshot['site']['enabledLocales'] as $locale_config) {
        $home = zeroy_runtime_snapshot_route_url($snapshot, (string) $locale_config['locale'], '');
        if (!is_wp_error($home)) $global_content['_site']['homeUrls'][(string) $locale_config['locale']] = $home;
    }
    $resolved_content = is_array($descriptor['resolvedContent'] ?? null) ? [...$descriptor['resolvedContent'], ...$global_content] : $global_content;
    $context = [
        'routeKind' => $descriptor['routeKind'],
        'locale' => $request['locale'],
        'preview' => $preview,
        'subject' => is_array($descriptor['subject'] ?? null) ? $descriptor['subject'] : null,
        'resolvedContent' => $resolved_content,
        'searchQuery' => $search_query,
        'archiveItems' => $archive['items'],
        'collection' => null,
        'seo' => ['canonical' => $descriptor['routeKind'] === 'not-found' ? null : $canonical, 'alternates' => $links],
        'route' => (string) ($descriptor['route'] ?? $request['route']),
    ];
    if (in_array($descriptor['routeKind'], ['archive', 'taxonomy', 'search'], true)) {
        $context['collection'] = [
            'collectionId' => $descriptor['collectionId'] ?? null,
            'schemaId' => $descriptor['schemaId'] ?? null,
            'title' => $descriptor['title'] ?? null,
            'page' => $archive['page'],
            'perPage' => $archive['perPage'],
            'total' => $archive['total'],
        ];
    }
    return [
        'template' => $descriptor['template'],
        'context' => $context,
        'projectionHash' => zeroy_runtime_hash(['route' => $descriptor, 'context' => $context]),
    ];
}
