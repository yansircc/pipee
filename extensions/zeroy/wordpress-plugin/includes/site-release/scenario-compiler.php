<?php

defined('ABSPATH') || exit;

/**
 * The declared set is contract-only. It intentionally does not contain post IDs,
 * routes discovered from content, or timestamps: ordinary content changes must
 * not stale a release proof. Candidate expansion below selects current fixtures
 * only for the runtime observation attached to that proof.
 */
function zeroy_runtime_site_release_scenario_set(array $theme_contract): array
{
    $scenarios = [];
    foreach ($theme_contract['site']['enabledLocales'] as $locale) {
        $name = (string) $locale['locale'];
        $scenarios[] = ['id' => 'front-page:' . $name, 'kind' => 'front-page', 'locale' => $name];
        $scenarios[] = ['id' => 'search:' . $name, 'kind' => 'search', 'locale' => $name];
        $scenarios[] = ['id' => 'not-found:' . $name, 'kind' => 'not-found', 'locale' => $name];
        foreach ($theme_contract['contentSchemas'] as $schema) {
            $scenarios[] = ['id' => 'singular:' . $schema['schemaId'] . ':' . $name, 'kind' => 'singular', 'schemaId' => $schema['schemaId'], 'locale' => $name];
        }
        foreach ($theme_contract['collectionRoutes'] as $collection) {
            $scenarios[] = ['id' => 'collection:' . $collection['collectionId'] . ':' . $name, 'kind' => 'collection', 'collectionId' => $collection['collectionId'], 'locale' => $name];
            if ($collection['kind'] === 'post-archive') {
                $scenarios[] = ['id' => 'pagination:' . $collection['collectionId'] . ':' . $name, 'kind' => 'pagination', 'collectionId' => $collection['collectionId'], 'locale' => $name];
            }
        }
    }
    usort($scenarios, static fn(array $left, array $right): int => strcmp($left['id'], $right['id']));
    return $scenarios;
}

function zeroy_runtime_candidate_route_path(array $locale, string $route = ''): string
{
    $path = trim(($locale['urlPrefix'] === '' ? '' : $locale['urlPrefix'] . '/') . trim($route, '/'), '/');
    return $path === '' ? '/' : '/' . $path . '/';
}

function zeroy_runtime_candidate_post_route(WP_Post $post, array $schema): ?string
{
    $route = array_key_exists('route', $schema) ? $schema['route'] : zeroy_runtime_normalize_route((string) $post->post_name);
    return is_string($route) ? $route : null;
}

function zeroy_runtime_candidate_post_locale_available(int $post_id, string $locale, string $default_locale): bool
{
    if ($locale === $default_locale) {
        $post = get_post($post_id);
        return $post instanceof WP_Post && $post->post_status === 'publish';
    }
    $head = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $locale);
    return is_array($head) && $head['published_version_id'] !== null;
}

function zeroy_runtime_candidate_first_post(string $schema_id): ?WP_Post
{
    $ids = get_posts([
        'post_type' => get_post_types(['public' => true]),
        'post_status' => 'publish',
        'posts_per_page' => 1,
        'meta_key' => ZEROY_RUNTIME_SCHEMA_META,
        'meta_value' => $schema_id,
        'fields' => 'ids',
        'orderby' => 'ID',
        'order' => 'ASC',
    ]);
    $post = isset($ids[0]) ? get_post((int) $ids[0]) : null;
    return $post instanceof WP_Post ? $post : null;
}

function zeroy_runtime_candidate_front_page_available(array $schemas, string $locale, string $default_locale): bool
{
    foreach ($schemas as $schema_id => $schema) {
        if (($schema['route'] ?? null) !== '') {
            continue;
        }
        $post = zeroy_runtime_candidate_first_post($schema_id);
        return $post instanceof WP_Post && zeroy_runtime_candidate_post_locale_available($post->ID, $locale, $default_locale);
    }
    // A site with no zeroY front-page schema still has a WordPress front page
    // in its default locale. Non-default zeroY routes need published content.
    return $locale === $default_locale;
}

function zeroy_runtime_candidate_collection_page_count(array $collection): int
{
    $ids = get_posts([
        'post_type' => get_post_types(['public' => true]),
        'post_status' => 'publish',
        'posts_per_page' => -1,
        'meta_key' => ZEROY_RUNTIME_SCHEMA_META,
        'meta_value' => $collection['schemaId'],
        'fields' => 'ids',
    ]);
    return is_array($ids) ? count($ids) : 0;
}

function zeroy_runtime_candidate_taxonomy_route(array $collection): ?string
{
    if (($collection['kind'] ?? null) !== 'taxonomy') {
        return null;
    }
    $terms = get_terms(['taxonomy' => $collection['taxonomy'], 'hide_empty' => false, 'number' => 1, 'orderby' => 'term_id', 'order' => 'ASC']);
    return is_array($terms) && ($terms[0] ?? null) instanceof WP_Term
        ? $collection['route'] . '/' . $terms[0]->slug
        : null;
}

function zeroy_runtime_candidate_scenario_url(string $release_id, array $scenario): string
{
    $token = hash_hmac('sha256', $release_id, zeroy_runtime_connection_key());
    return add_query_arg([
        'zeroy_candidate_release' => $release_id,
        'token' => $token,
        ...($scenario['query'] ?? []),
    ], home_url($scenario['path']));
}

function zeroy_runtime_compile_candidate_scenarios(array $theme_contract, array $theme_schema): array
{
    $scenarios = [];
    $default_locale = $theme_contract['site']['defaultLocale'];
    $schema_by_id = $theme_schema['schemas'];
    $collections = [];
    foreach ($theme_contract['collectionRoutes'] as $collection) {
        $collections[$collection['collectionId']] = $collection;
    }
    foreach ($theme_contract['site']['enabledLocales'] as $locale) {
        $locale_name = $locale['locale'];
        $prefix_path = zeroy_runtime_candidate_route_path($locale);
        if (zeroy_runtime_candidate_front_page_available($schema_by_id, $locale_name, $default_locale)) {
            $scenarios[] = ['id' => 'front-page:' . $locale_name, 'kind' => 'front-page', 'locale' => $locale_name, 'path' => $prefix_path, 'expectedStatus' => 200];
            $scenarios[] = ['id' => 'search:' . $locale_name, 'kind' => 'search', 'locale' => $locale_name, 'path' => $prefix_path, 'query' => ['s' => 'zeroy-verifier'], 'expectedStatus' => 200];
        }
        $scenarios[] = ['id' => 'not-found:' . $locale_name, 'kind' => 'not-found', 'locale' => $locale_name, 'path' => zeroy_runtime_candidate_route_path($locale, '__zeroy-verifier-not-found__'), 'expectedStatus' => 404];
        foreach ($theme_contract['contentSchemas'] as $schema_summary) {
            $schema_id = $schema_summary['schemaId'];
            $post = zeroy_runtime_candidate_first_post($schema_id);
            $definition = $schema_by_id[$schema_id] ?? null;
            if (!$post instanceof WP_Post || !is_array($definition) || !zeroy_runtime_candidate_post_locale_available($post->ID, $locale_name, $default_locale)) {
                continue;
            }
            $route = zeroy_runtime_candidate_post_route($post, $definition);
            if ($route !== null) {
                $scenarios[] = ['id' => 'singular:' . $schema_id . ':' . $locale_name, 'kind' => 'singular', 'schemaId' => $schema_id, 'locale' => $locale_name, 'path' => zeroy_runtime_candidate_route_path($locale, $route), 'expectedStatus' => 200];
            }
        }
        foreach ($collections as $collection_id => $collection) {
            $route = $collection['kind'] === 'taxonomy'
                ? zeroy_runtime_candidate_taxonomy_route($collection)
                : $collection['route'];
            if ($route === null) {
                continue;
            }
            $scenarios[] = ['id' => 'collection:' . $collection_id . ':' . $locale_name, 'kind' => 'collection', 'collectionId' => $collection_id, 'locale' => $locale_name, 'path' => zeroy_runtime_candidate_route_path($locale, $route), 'expectedStatus' => 200];
            if ($collection['kind'] === 'post-archive' && zeroy_runtime_candidate_collection_page_count($collection) > 12) {
                $scenarios[] = ['id' => 'pagination:' . $collection_id . ':' . $locale_name, 'kind' => 'pagination', 'collectionId' => $collection_id, 'locale' => $locale_name, 'path' => zeroy_runtime_candidate_route_path($locale, $route . '/page/2'), 'expectedStatus' => 200];
            }
        }
    }
    usort($scenarios, static fn(array $left, array $right): int => strcmp($left['id'], $right['id']));
    return $scenarios;
}
