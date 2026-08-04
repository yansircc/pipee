<?php

defined('ABSPATH') || exit;

function zeroy_runtime_snapshot_apply_overlay(array $localizable, array $overlay): array|WP_Error
{
    $compiled = zeroy_localization_compile_subject_policy($localizable, ['localization' => $overlay['policy'] ?? []]);
    if (is_wp_error($compiled)) return $compiled;
    $view = $localizable['view'];
    foreach (($overlay['values'] ?? []) as $field_id => $stored) {
        $field = $compiled['fields'][$field_id] ?? null;
        if (!is_array($field) || !is_array($stored) || !array_key_exists('value', $stored)) {
            return zeroy_runtime_error('zeroy_site_snapshot_overlay_invalid', 'SiteSnapshot overlay contains an unknown field.', 409, ['fieldId' => $field_id]);
        }
        zeroy_localization_set_view_value($view, $field['viewPath'], $stored['value']);
    }
    return $view;
}

function zeroy_runtime_snapshot_overlay_from_head(
    array $head,
    string $pointer,
    array $subject,
    string $locale,
    array $compiled,
): array|WP_Error {
    $overlay = zeroy_localization_overlay_for_head(
        $head,
        $pointer,
        $subject,
        $locale,
        $compiled['policy']['hash'],
    );
    return is_wp_error($overlay) && $overlay->get_error_code() === 'zeroy_localization_policy_changed'
        ? zeroy_localization_candidate_overlay_for_head($head, $pointer, $subject, $locale, $compiled)
        : $overlay;
}

function zeroy_runtime_snapshot_resolved_locales(array $subject, array $localizable, array $definition, array $site_config): array|WP_Error
{
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    if (is_wp_error($compiled)) return $compiled;
    $resolved = [];
    foreach ($site_config['enabledLocales'] as $locale_config) {
        $locale = (string) $locale_config['locale'];
        if ($locale === $site_config['defaultLocale']) {
            $resolved[$locale] = ['available' => true, 'revision' => 0, 'view' => $localizable['view'], 'draftOverlay' => null, 'publishedOverlay' => null];
            continue;
        }
        $head = zeroy_localization_overlay_head($subject, $locale);
        if ($head === null || $head['published_version_id'] === null) {
            $draft_overlay = $head !== null && $head['draft_version_id'] !== null
                ? zeroy_runtime_snapshot_overlay_from_head($head, 'draft_version_id', $subject, $locale, $compiled)
                : null;
            if (is_wp_error($draft_overlay)) return $draft_overlay;
            $resolved[$locale] = ['available' => false, 'revision' => $head === null ? 0 : (int) $head['revision'], 'view' => null, 'draftOverlay' => $draft_overlay, 'publishedOverlay' => null];
            continue;
        }
        $overlay = zeroy_runtime_snapshot_overlay_from_head($head, 'published_version_id', $subject, $locale, $compiled);
        if (is_wp_error($overlay)) return $overlay;
        $view = $localizable['view'];
        foreach ($overlay['values'] as $field_id => $stored) {
            $field = $compiled['fields'][$field_id] ?? null;
            if (!is_array($field) || !is_array($stored) || !array_key_exists('value', $stored)) {
                return zeroy_runtime_error('zeroy_site_snapshot_overlay_invalid', 'LocaleOverlay cannot be projected into SiteSnapshot.', 409, ['subject' => $subject, 'locale' => $locale, 'fieldId' => $field_id]);
            }
            zeroy_localization_set_view_value($view, $field['viewPath'], $stored['value']);
        }
        $draft_overlay = $head['draft_version_id'] === null
            ? null
            : zeroy_runtime_snapshot_overlay_from_head($head, 'draft_version_id', $subject, $locale, $compiled);
        if (is_wp_error($draft_overlay)) return $draft_overlay;
        $resolved[$locale] = ['available' => true, 'revision' => (int) $head['revision'], 'view' => $view, 'draftOverlay' => $draft_overlay, 'publishedOverlay' => $overlay];
    }
    return $resolved;
}

function zeroy_runtime_snapshot_post_entity(int $post_id, string $schema_id, array $definition, array $site_config): array|WP_Error
{
    $canonical = zeroy_runtime_canonical($post_id);
    if (is_wp_error($canonical)) return $canonical;
    $localizable = zeroy_localization_post_subject($post_id, $definition, $schema_id);
    if (is_wp_error($localizable)) return $localizable;
    $route = $canonical['route'];
    if (!is_string($route)) return zeroy_runtime_error('zeroy_site_snapshot_route_missing', 'Canonical object has no explicit route.', 409, ['objectId' => $post_id]);
    $route_kind = $definition['routeKind'] ?? null;
    if (!is_string($route_kind) || !in_array($route_kind, ['front-page', 'document', 'singular'], true)) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_kind_invalid', 'Canonical ThemeSchema has no explicit routeKind.', 409, ['objectId' => $post_id, 'schemaId' => $schema_id]);
    }
    if (($route_kind === 'front-page') !== ($route === '')) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_kind_conflict', 'front-page must own / and document/singular routes must be non-root.', 409, ['objectId' => $post_id, 'schemaId' => $schema_id, 'routeKind' => $route_kind, 'route' => $route]);
    }
    $locales = zeroy_runtime_snapshot_resolved_locales(['kind' => 'post', 'id' => $post_id], $localizable, $definition, $site_config);
    if (is_wp_error($locales)) return $locales;
    $terms = [];
    foreach (get_object_taxonomies($canonical['post']->post_type) as $taxonomy) {
        $assigned = wp_get_object_terms($post_id, $taxonomy, ['fields' => 'slugs']);
        if (!is_wp_error($assigned) && is_array($assigned)) $terms[$taxonomy] = array_values(array_map('strval', $assigned));
    }
    $authored_ref = get_post_meta($post_id, '_zeroy_authored_ref', true);
    return [
        'identity' => 'post:' . $post_id,
        'subject' => ['kind' => 'post', 'id' => $post_id],
        'authoredRef' => is_string($authored_ref) && $authored_ref !== '' ? $authored_ref : null,
        'objectId' => $post_id,
        'postType' => $canonical['post']->post_type,
        'status' => $canonical['post']->post_status,
        'schemaId' => $schema_id,
        'routeKind' => $route_kind,
        'route' => $route,
        'revision' => (int) $canonical['revision'],
        'localizable' => $localizable,
        'locales' => $locales,
        'terms' => $terms,
    ];
}

function zeroy_runtime_snapshot_site_copy(array $schema, array $site_config): array|WP_Error
{
    $definition = $schema['localizationSubjects']['siteCopy'] ?? null;
    if (!is_array($definition)) return [];
    $subject = ['kind' => 'site-copy', 'id' => 'default'];
    $localizable = zeroy_localization_site_copy_subject();
    if (is_wp_error($localizable)) return $localizable;
    $locales = zeroy_runtime_snapshot_resolved_locales($subject, $localizable, $definition, $site_config);
    if (is_wp_error($locales)) return $locales;
    return ['subject' => $subject, 'localizable' => $localizable, 'definition' => $definition, 'locales' => $locales];
}

function zeroy_runtime_snapshot_terms(array $theme_contract, array $schema, array $site_config): array|WP_Error
{
    $definition = $schema['localizationSubjects']['term'] ?? null;
    if (!is_array($definition)) return [];
    $taxonomies = [];
    foreach ($theme_contract['collectionRoutes'] as $collection) if (($collection['kind'] ?? null) === 'taxonomy') $taxonomies[(string) $collection['taxonomy']] = true;
    $result = [];
    foreach (array_keys($taxonomies) as $taxonomy) {
        $terms = get_terms(['taxonomy' => $taxonomy, 'hide_empty' => false]);
        if (is_wp_error($terms)) return $terms;
        foreach ($terms as $term) {
            if (!$term instanceof WP_Term) continue;
            $subject = ['kind' => 'term', 'taxonomy' => $taxonomy, 'id' => $term->term_id];
            $localizable = zeroy_localization_term_subject($taxonomy, $term->term_id);
            if (is_wp_error($localizable)) return $localizable;
            $locales = zeroy_runtime_snapshot_resolved_locales($subject, $localizable, $definition, $site_config);
            if (is_wp_error($locales)) return $locales;
            $result[$taxonomy . ':' . $term->slug] = ['subject' => $subject, 'taxonomy' => $taxonomy, 'slug' => $term->slug, 'localizable' => $localizable, 'definition' => $definition, 'locales' => $locales];
        }
    }
    return $result;
}

function zeroy_runtime_snapshot_entity_item(array $snapshot, array $entity, string $locale): ?array
{
    $locale_state = $entity['locales'][$locale] ?? null;
    if (!is_array($locale_state) || ($locale_state['available'] ?? false) !== true || !is_array($locale_state['view'] ?? null)) return null;
    $url = zeroy_runtime_snapshot_route_url($snapshot, $locale, (string) $entity['route']);
    if (is_wp_error($url)) return null;
    return [
        'objectId' => $entity['objectId'],
        'subject' => $entity['subject'],
        'locale' => $locale,
        'schemaId' => $entity['schemaId'],
        'route' => $entity['route'],
        'url' => $url,
        'fields' => $locale_state['view'],
    ];
}

function zeroy_runtime_snapshot_register_route(array &$routes, array &$route_urls, string $locale, string $route, string $route_id, array $descriptor): true|WP_Error
{
    if (array_key_exists($route, $routes[$locale])) {
        return zeroy_runtime_error(
            'zeroy_site_snapshot_route_conflict',
            'Two candidate route owners declare the same locale path.',
            409,
            ['locale' => $locale, 'route' => $route, 'existingRouteId' => $routes[$locale][$route]['routeId'] ?? null, 'candidateRouteId' => $route_id]
        );
    }
    $routes[$locale][$route] = ['routeId' => $route_id, 'route' => $route, ...$descriptor];
    $route_urls[$route_id][$locale] = $route;
    return true;
}

function zeroy_runtime_snapshot_compile_routes(array $snapshot, array $theme_contract, array $schema): array|WP_Error
{
    $routes = [];
    $route_urls = [];
    $search_items = [];
    foreach ($snapshot['site']['enabledLocales'] as $locale_config) {
        $locale = (string) $locale_config['locale'];
        $routes[$locale] = [];
        $search_items[$locale] = [];
        foreach ($snapshot['entities'] as $identity => $entity) {
            $item = zeroy_runtime_snapshot_entity_item($snapshot, $entity, $locale);
            if ($item === null) continue;
            $route = (string) $entity['route'];
            $route_id = 'subject:' . $identity;
            $resolved = $item['fields'];
            $resolved['siteCopy'] = $snapshot['siteCopy']['locales'][$locale]['view']['siteCopy'] ?? [];
            $registered = zeroy_runtime_snapshot_register_route($routes, $route_urls, $locale, $route, $route_id, [
                'routeKind' => $entity['routeKind'],
                'template' => $schema['schemas'][$entity['schemaId']]['template'],
                'subject' => $entity['subject'] + ['schemaId' => $entity['schemaId']],
                'resolvedContent' => $resolved,
            ]);
            if (is_wp_error($registered)) return $registered;
            $search_items[$locale][] = $item;
        }
        foreach ($theme_contract['collectionRoutes'] as $collection) {
            $collection_id = (string) $collection['collectionId'];
            $kind = $collection['kind'] === 'taxonomy' ? 'taxonomy' : 'archive';
            if ($kind === 'taxonomy') {
                foreach ($snapshot['terms'] as $term) {
                    if ($term['taxonomy'] !== $collection['taxonomy']) continue;
                    $route = $collection['route'] . '/' . $term['slug'];
                    $term_locale = $term['locales'][$locale] ?? null;
                    if (!is_array($term_locale) || ($term_locale['available'] ?? false) !== true) continue;
                    $items = array_values(array_filter(array_map(static function (array $entity) use ($snapshot, $locale, $term, $collection): ?array {
                        return in_array($term['slug'], $entity['terms'][$collection['taxonomy']] ?? [], true) ? zeroy_runtime_snapshot_entity_item($snapshot, $entity, $locale) : null;
                    }, $snapshot['entities'])));
                    $route_id = 'collection:' . $collection_id . ':term:' . $term['slug'];
                    $registered = zeroy_runtime_snapshot_register_route($routes, $route_urls, $locale, $route, $route_id, ['routeKind' => 'taxonomy', 'template' => $collection['template'], 'collectionId' => $collection_id, 'schemaId' => $collection['schemaId'], 'title' => $term_locale['view']['term']['name'] ?? $term['slug'], 'subject' => $term['subject'], 'resolvedContent' => $term_locale['view'], 'items' => $items]);
                    if (is_wp_error($registered)) return $registered;
                }
            } else {
                $route = (string) $collection['route'];
                $items = [];
                foreach ($snapshot['entities'] as $entity) if ($entity['schemaId'] === $collection['schemaId'] && ($item = zeroy_runtime_snapshot_entity_item($snapshot, $entity, $locale)) !== null) $items[] = $item;
                $route_id = 'collection:' . $collection_id;
                $registered = zeroy_runtime_snapshot_register_route($routes, $route_urls, $locale, $route, $route_id, ['routeKind' => 'archive', 'template' => $collection['template'], 'collectionId' => $collection_id, 'schemaId' => $collection['schemaId'], 'title' => $collection['label'], 'items' => $items]);
                if (is_wp_error($registered)) return $registered;
            }
        }
        $search = $theme_contract['routeSpec']['search'];
        $registered = zeroy_runtime_snapshot_register_route($routes, $route_urls, $locale, (string) $search['route'], 'search', ['routeKind' => 'search', 'template' => $search['template']]);
        if (is_wp_error($registered)) return $registered;
        $route_urls['not-found'][$locale] = null;
    }
    $snapshot['routes'] = $routes;
    $snapshot['routeUrls'] = $route_urls;
    $snapshot['searchItems'] = $search_items;
    $snapshot['notFound'] = array_fill_keys(array_keys($routes), ['routeId' => 'not-found', 'routeKind' => 'not-found', 'route' => '', 'template' => $theme_contract['routeSpec']['notFound']['template']]);
    return $snapshot;
}

function zeroy_runtime_snapshot_entity_identity(mixed $reference): string|WP_Error
{
    if (is_int($reference) && $reference > 0) return 'post:' . $reference;
    if (is_string($reference) && $reference !== '') return 'draft:' . $reference;
    if (is_array($reference) && ($reference['kind'] ?? null) === 'post') {
        if (is_int($reference['id'] ?? null) && $reference['id'] > 0) return 'post:' . $reference['id'];
        if (is_string($reference['ref'] ?? null) && $reference['ref'] !== '') return 'draft:' . $reference['ref'];
    }
    return zeroy_runtime_error('zeroy_site_checkout_ref_missing', 'SiteCheckout subject does not identify a candidate post.', 409, ['reference' => $reference]);
}

function zeroy_runtime_snapshot_subject_address(array $snapshot, mixed $reference): array|WP_Error
{
    $post_identity = zeroy_runtime_snapshot_entity_identity($reference);
    if (!is_wp_error($post_identity)) {
        return isset($snapshot['entities'][$post_identity])
            ? ['collection' => 'entities', 'key' => $post_identity]
            : zeroy_runtime_error('zeroy_site_checkout_ref_missing', 'SiteCheckout subject does not exist in the candidate snapshot.', 409, ['identity' => $post_identity]);
    }
    if (!is_array($reference)) return $post_identity;
    if (($reference['kind'] ?? null) === 'site-copy' && ($reference['id'] ?? null) === 'default') {
        return is_array($snapshot['siteCopy']['localizable'] ?? null)
            ? ['collection' => 'siteCopy', 'key' => null]
            : zeroy_runtime_error('zeroy_site_checkout_ref_missing', 'Candidate ThemeSchema does not declare SiteCopy.', 409);
    }
    if (($reference['kind'] ?? null) === 'term' && is_string($reference['taxonomy'] ?? null) && (is_int($reference['id'] ?? null) || is_string($reference['ref'] ?? null))) {
        foreach ($snapshot['terms'] as $key => $entry) {
            $same_identity = is_int($reference['id'] ?? null)
                ? ($entry['subject']['id'] ?? null) === $reference['id']
                : ($entry['subject']['ref'] ?? null) === $reference['ref'];
            if (($entry['subject']['kind'] ?? null) === 'term' && ($entry['subject']['taxonomy'] ?? null) === $reference['taxonomy'] && $same_identity) {
                return ['collection' => 'terms', 'key' => $key];
            }
        }
        return zeroy_runtime_error('zeroy_site_checkout_ref_missing', 'Taxonomy term does not exist in the candidate snapshot.', 409, ['subject' => $reference]);
    }
    return zeroy_runtime_error('zeroy_site_checkout_subject_unsupported', 'SiteCheckout translation subject is not owned by SiteSnapshot.', 409, ['subject' => $reference]);
}

function zeroy_runtime_snapshot_subject_entry(array $snapshot, array $address): array
{
    return $address['collection'] === 'siteCopy'
        ? $snapshot['siteCopy']
        : $snapshot[$address['collection']][$address['key']];
}

function zeroy_runtime_snapshot_put_subject_entry(array &$snapshot, array $address, array $entry): void
{
    if ($address['collection'] === 'siteCopy') $snapshot['siteCopy'] = $entry;
    else $snapshot[$address['collection']][$address['key']] = $entry;
}

function zeroy_runtime_snapshot_subject_definition(array $entry, array $schema): array|WP_Error
{
    if (is_array($entry['definition'] ?? null)) return $entry['definition'];
    $schema_id = $entry['schemaId'] ?? null;
    return is_string($schema_id) && is_array($schema['schemas'][$schema_id] ?? null)
        ? $schema['schemas'][$schema_id]
        : zeroy_runtime_error('zeroy_schema_not_found', 'Candidate translation subject has no ThemeSchema definition.', 409, ['schemaId' => $schema_id]);
}

function zeroy_runtime_snapshot_overlay_view(array $localizable, array $compiled, ?array $overlay): array|WP_Error
{
    if ($overlay === null) return $localizable['view'];
    $view = $localizable['view'];
    foreach (($overlay['values'] ?? []) as $field_id => $stored) {
        $field = $compiled['fields'][$field_id] ?? null;
        if (!is_array($field) || !is_array($stored) || !array_key_exists('value', $stored)) return zeroy_runtime_error('zeroy_site_snapshot_overlay_invalid', 'Candidate overlay contains an unknown field.', 409, ['fieldId' => $field_id]);
        zeroy_localization_set_view_value($view, $field['viewPath'], $stored['value']);
    }
    return $view;
}

function zeroy_runtime_snapshot_refresh_locales(array $entry, array $definition, array $site_config, bool $canonical_available): array|WP_Error
{
    $compiled = zeroy_localization_compile_subject_policy($entry['localizable'], $definition);
    if (is_wp_error($compiled)) return $compiled;
    $previous = is_array($entry['locales'] ?? null) ? $entry['locales'] : [];
    $locales = [];
    foreach ($site_config['enabledLocales'] as $locale_config) {
        $locale = (string) $locale_config['locale'];
        if ($locale === $site_config['defaultLocale']) {
            $locales[$locale] = ['available' => $canonical_available, 'revision' => 0, 'view' => $entry['localizable']['view'], 'draftOverlay' => null, 'publishedOverlay' => null];
            continue;
        }
        $state = is_array($previous[$locale] ?? null) ? $previous[$locale] : ['available' => false, 'revision' => 0, 'draftOverlay' => null, 'publishedOverlay' => null];
        $published = is_array($state['publishedOverlay'] ?? null) ? $state['publishedOverlay'] : null;
        $view = $published === null ? null : zeroy_runtime_snapshot_overlay_view($entry['localizable'], $compiled, $published);
        if (is_wp_error($view)) return $view;
        $locales[$locale] = [...$state, 'available' => $published !== null && $canonical_available, 'view' => $view];
    }
    return [...$entry, 'locales' => $locales];
}

function zeroy_runtime_snapshot_refresh_entity(array $entity, array $schema, array $site_config): array|WP_Error
{
    $definition = $schema['schemas'][$entity['schemaId']] ?? null;
    if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'Candidate entity references an unknown ThemeSchema.', 409, ['schemaId' => $entity['schemaId']]);
    $route_kind = $definition['routeKind'] ?? null;
    $route = $entity['route'] ?? null;
    if (!is_string($route_kind) || !in_array($route_kind, ['front-page', 'document', 'singular'], true) || !is_string($route)) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_kind_invalid', 'Candidate entity has no valid explicit route contract.', 409, ['subject' => $entity['subject'] ?? null, 'schemaId' => $entity['schemaId']]);
    }
    if (($route_kind === 'front-page') !== ($route === '')) {
        return zeroy_runtime_error('zeroy_site_snapshot_route_kind_conflict', 'front-page must own / and document/singular routes must be non-root.', 409, ['subject' => $entity['subject'] ?? null, 'schemaId' => $entity['schemaId'], 'routeKind' => $route_kind, 'route' => $route]);
    }
    $localizable = zeroy_localization_post_subject_from_view(
        $entity['subject'],
        (string) $entity['schemaId'],
        $definition,
        (string) $entity['postType'],
        $entity['localizable']['view'],
        (int) $entity['revision'],
        is_int($entity['objectId'] ?? null) ? ['post_id' => $entity['objectId']] : ['post_type' => $entity['postType']]
    );
    if (is_wp_error($localizable)) return $localizable;
    return zeroy_runtime_snapshot_refresh_locales([...$entity, 'routeKind' => $route_kind, 'localizable' => $localizable], $definition, $site_config, ($entity['status'] ?? null) === 'publish');
}

function zeroy_runtime_snapshot_translation_write(array $entry, array $definition, string $locale, array $values, int $expected_revision, array $site_config): array|WP_Error
{
    if ($locale === $site_config['defaultLocale']) return zeroy_runtime_error('zeroy_translation_default_locale', 'Default locale is canonical and has no translation draft.', 409);
    $state = $entry['locales'][$locale] ?? null;
    if (!is_array($state)) return zeroy_runtime_error('zeroy_locale_disabled', 'Locale is not enabled in the candidate SiteConfig.', 409, ['locale' => $locale]);
    if ((int) $state['revision'] !== $expected_revision) return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'Candidate locale revision changed.', 409, ['currentRevision' => $state['revision']]);
    $compiled = zeroy_localization_compile_subject_policy($entry['localizable'], $definition);
    if (is_wp_error($compiled)) return $compiled;
    $overlay = is_array($state['draftOverlay'] ?? null)
        ? $state['draftOverlay']
        : (is_array($state['publishedOverlay'] ?? null) ? $state['publishedOverlay'] : zeroy_localization_empty_overlay($entry['subject'], $locale, $compiled['policy']['hash']));
    foreach ($values as $field_id => $value) {
        $field = is_string($field_id) ? ($compiled['fields'][$field_id] ?? null) : null;
        if (!is_array($field) || !in_array($field['policy']['mode'], ['translated', 'overridable'], true)) return zeroy_runtime_error('zeroy_translation_field_invalid', 'Candidate translation field is not writable.', 409, ['fieldId' => $field_id]);
        if ($value === null) {
            if ($field['policy']['mode'] !== 'overridable') return zeroy_runtime_error('zeroy_translation_value_invalid', 'Translated fields cannot inherit the canonical value.', 409, ['fieldId' => $field_id]);
            unset($overlay['values'][$field_id]);
        } else {
            $overlay['values'][$field_id] = ['sourceHash' => $field['sourceHash'], 'value' => $value];
        }
    }
    $state['draftOverlay'] = $overlay;
    $state['revision'] = $expected_revision + 1;
    $entry['locales'][$locale] = $state;
    return $entry;
}

function zeroy_runtime_snapshot_translation_publish(array $entry, array $definition, string $locale, int $expected_revision, bool $publish): array|WP_Error
{
    $state = $entry['locales'][$locale] ?? null;
    if (!is_array($state) || (int) $state['revision'] !== $expected_revision) return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'Candidate locale revision changed.', 409, ['currentRevision' => is_array($state) ? $state['revision'] : null]);
    if ($publish && !is_array($state['draftOverlay'] ?? null)) return zeroy_runtime_error('zeroy_translation_draft_missing', 'Candidate locale has no translation draft.', 409);
    $compiled = zeroy_localization_compile_subject_policy($entry['localizable'], $definition);
    if (is_wp_error($compiled)) return $compiled;
    if ($publish) {
        $violations = [];
        foreach ($compiled['fields'] as $field) {
            if (!in_array($field['policy']['mode'], ['translated', 'overridable'], true)) continue;
            $status = zeroy_localization_translation_status($field, $state['draftOverlay']);
            if ($status['status'] === 'stale' || $status['status'] === 'review-needed' || (($field['policy']['required'] ?? false) === true && $status['status'] === 'missing')) $violations[] = ['fieldId' => $field['fieldId'], 'status' => $status['status']];
        }
        if ($violations !== []) return zeroy_runtime_error('zeroy_translation_not_publishable', 'Candidate translation is incomplete or stale.', 409, ['violations' => $violations]);
        $state['publishedOverlay'] = $state['draftOverlay'];
        if (($entry['subject']['kind'] ?? null) === 'post') $entry['status'] = 'publish';
    } else {
        if (!is_array($state['publishedOverlay'] ?? null)) return zeroy_runtime_error('zeroy_translation_not_published', 'Candidate locale is not published.', 409);
        $state['publishedOverlay'] = null;
    }
    $state['revision'] = $expected_revision + 1;
    $entry['locales'][$locale] = $state;
    return $entry;
}

function zeroy_runtime_apply_operations_to_snapshot(array $snapshot, array $operations, array $theme_contract, array $schema): array|WP_Error
{
    foreach ($operations as $operation) {
        $kind = $operation['kind'] ?? null;
        $payload = $operation['payload'] ?? null;
        if ($kind === 'artifact.files' || $kind === 'upsertMedia' || $kind === 'adoptMedia') continue;
        if (!is_string($kind) || !is_array($payload)) return zeroy_runtime_error('zeroy_site_checkout_operation_invalid', 'SiteCheckout operation is malformed.', 409);
        if ($kind === 'siteConfig') {
            if ((int) ($snapshot['siteConfig']['revision'] ?? -1) !== (int) $payload['expectedRevision']) return zeroy_runtime_error('zeroy_site_config_conflict', 'Candidate SiteConfig revision changed.', 409, ['currentRevision' => $snapshot['siteConfig']['revision'] ?? null]);
            $site_config = zeroy_runtime_validate_site_config(is_array($payload['siteConfig'] ?? null) ? $payload['siteConfig'] : []);
            if (is_wp_error($site_config)) return $site_config;
            $snapshot['siteConfig'] = [...$site_config, 'revision' => (int) $payload['expectedRevision'] + 1];
            $snapshot['site'] = ['baseUrl' => $snapshot['site']['baseUrl'], 'defaultLocale' => $payload['siteConfig']['defaultLocale'], 'enabledLocales' => array_map(static fn(array $locale): array => ['locale' => $locale['locale'], 'urlPrefix' => $locale['urlPrefix']], $payload['siteConfig']['enabledLocales'])];
            foreach ($snapshot['entities'] as $identity => $entity) {
                $refreshed = zeroy_runtime_snapshot_refresh_entity($entity, $schema, $snapshot['siteConfig']);
                if (is_wp_error($refreshed)) return $refreshed;
                $snapshot['entities'][$identity] = $refreshed;
            }
            if (is_array($snapshot['siteCopy']['localizable'] ?? null)) {
                $definition = $schema['localizationSubjects']['siteCopy'] ?? null;
                $localizable = zeroy_localization_site_copy_subject_from_values($snapshot['siteConfig']['siteCopy'] ?? [], (int) $snapshot['siteConfig']['revision']);
                if (!is_array($definition) || is_wp_error($localizable)) return is_wp_error($localizable) ? $localizable : zeroy_runtime_error('zeroy_schema_not_found', 'Candidate SiteCopy definition is missing.', 409);
                $snapshot['siteCopy'] = zeroy_runtime_snapshot_refresh_locales([...$snapshot['siteCopy'], 'definition' => $definition, 'localizable' => $localizable], $definition, $snapshot['siteConfig'], true);
                if (is_wp_error($snapshot['siteCopy'])) return $snapshot['siteCopy'];
            }
            foreach ($snapshot['terms'] as $term_key => $term) {
                $definition = $schema['localizationSubjects']['term'] ?? null;
                if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'Candidate term localization definition is missing.', 409);
                $refreshed = zeroy_runtime_snapshot_refresh_locales([...$term, 'definition' => $definition], $definition, $snapshot['siteConfig'], true);
                if (is_wp_error($refreshed)) return $refreshed;
                $snapshot['terms'][$term_key] = $refreshed;
            }
            continue;
        }
        if ($kind === 'createCanonical') {
            $identity = 'draft:' . $payload['ref'];
            if (isset($snapshot['entities'][$identity])) return zeroy_runtime_error('zeroy_site_checkout_ref_conflict', 'Staged canonical ref is duplicated.', 409, ['ref' => $payload['ref']]);
            $definition = $schema['schemas'][$payload['schemaId']] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'createCanonical references an unknown candidate schema.', 409, ['schemaId' => $payload['schemaId']]);
            $route = zeroy_runtime_normalize_route((string) $payload['route']);
            if (is_wp_error($route)) return $route;
            $view = ['post' => ['title' => (string) ($payload['postTitle'] ?? ''), 'content' => (string) ($payload['postContent'] ?? ''), 'excerpt' => (string) ($payload['postExcerpt'] ?? '')], 'acf' => [], 'templateContent' => is_array($payload['templateContent'] ?? null) ? $payload['templateContent'] : []];
            $localizable = zeroy_localization_post_subject_from_view(['kind' => 'post', 'ref' => $payload['ref']], (string) $payload['schemaId'], $definition, (string) $payload['postType'], $view, 1, ['post_type' => $payload['postType']]);
            if (is_wp_error($localizable)) return $localizable;
            // A newly created canonical has no independent publication step:
            // the SiteRelease commit that materializes this snapshot is that
            // step. Candidate routing must therefore evaluate it as public.
            $entity = ['identity' => $identity, 'subject' => ['kind' => 'post', 'ref' => $payload['ref']], 'authoredRef' => $payload['ref'], 'objectId' => null, 'postType' => $payload['postType'], 'status' => 'publish', 'schemaId' => $payload['schemaId'], 'route' => $route, 'revision' => 1, 'localizable' => $localizable, 'locales' => [], 'terms' => []];
            $entity = zeroy_runtime_snapshot_refresh_entity($entity, $schema, $snapshot['siteConfig']);
            if (is_wp_error($entity)) return $entity;
            $snapshot['entities'][$identity] = $entity;
            continue;
        }
        if ($kind === 'adoptCanonical') {
            $identity = 'post:' . (int) $payload['postId'];
            if (isset($snapshot['entities'][$identity])) return zeroy_runtime_error('zeroy_canonical_already_adopted', 'WordPress post is already canonical in the candidate.', 409);
            $existing = zeroy_runtime_existing_unmanaged_post((int) $payload['postId']);
            if (is_wp_error($existing) || !hash_equals((string) ($existing['sourceHash'] ?? ''), (string) $payload['expectedSourceHash'])) return zeroy_runtime_error('zeroy_adoption_source_conflict', 'Adoption source changed.', 409);
            $definition = $schema['schemas'][$payload['schemaId']] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'adoptCanonical references an unknown candidate schema.', 409);
            $route = zeroy_runtime_normalize_route((string) $payload['route']);
            if (is_wp_error($route)) return $route;
            $stable_acf = zeroy_localization_acf_stable_top_view(is_array($existing['acf'] ?? null) ? $existing['acf'] : [], ['post_id' => (int) $payload['postId']]);
            if (is_wp_error($stable_acf)) return $stable_acf;
            $view = ['post' => ['title' => $existing['post']['postTitle'], 'content' => $existing['post']['postContent'], 'excerpt' => $existing['post']['postExcerpt']], 'acf' => $stable_acf, 'templateContent' => []];
            $localizable = zeroy_localization_post_subject_from_view(['kind' => 'post', 'id' => (int) $payload['postId']], (string) $payload['schemaId'], $definition, (string) $existing['post']['postType'], $view, 1, ['post_id' => (int) $payload['postId']]);
            if (is_wp_error($localizable)) return $localizable;
            $entity = ['identity' => $identity, 'subject' => ['kind' => 'post', 'id' => (int) $payload['postId']], 'authoredRef' => $payload['ref'], 'objectId' => (int) $payload['postId'], 'postType' => $existing['post']['postType'], 'status' => $existing['post']['postStatus'], 'schemaId' => $payload['schemaId'], 'route' => $route, 'revision' => 1, 'localizable' => $localizable, 'locales' => [], 'terms' => []];
            $entity = zeroy_runtime_snapshot_refresh_entity($entity, $schema, $snapshot['siteConfig']);
            if (is_wp_error($entity)) return $entity;
            $snapshot['entities'][$identity] = $entity;
            continue;
        }
        if ($kind === 'retireCanonical') {
            $identity = 'post:' . (int) ($payload['objectId'] ?? 0);
            $entity = $snapshot['entities'][$identity] ?? null;
            if (!is_array($entity)) return zeroy_runtime_error('zeroy_canonical_missing', 'retireCanonical references a missing candidate canonical object.', 409, ['objectId' => $payload['objectId'] ?? null]);
            if ((int) $entity['revision'] !== (int) ($payload['expectedRevision'] ?? -1)) return zeroy_runtime_error('zeroy_canonical_conflict', 'Candidate canonical revision changed before retirement.', 409, ['currentRevision' => $entity['revision']]);
            unset($snapshot['entities'][$identity]);
            continue;
        }
        if ($kind === 'createTerm') {
            $key = (string) $payload['taxonomy'] . ':' . (string) $payload['slug'];
            if (isset($snapshot['terms'][$key])) return zeroy_runtime_error('zeroy_term_conflict', 'SiteCommit term ref or slug is duplicated.', 409, ['ref' => $payload['ref'] ?? null]);
            $definition = $schema['localizationSubjects']['term'] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'Candidate ThemeSchema does not define term localization.', 409);
            $subject = ['kind' => 'term', 'taxonomy' => (string) $payload['taxonomy'], 'ref' => (string) $payload['ref']];
            $localizable = zeroy_localization_term_subject_from_values($subject, (string) $payload['taxonomy'], (string) $payload['name'], (string) ($payload['description'] ?? ''));
            $entry = ['subject' => $subject, 'taxonomy' => (string) $payload['taxonomy'], 'slug' => (string) $payload['slug'], 'localizable' => $localizable, 'definition' => $definition, 'locales' => []];
            $entry = zeroy_runtime_snapshot_refresh_locales($entry, $definition, $snapshot['siteConfig'], true);
            if (is_wp_error($entry)) return $entry;
            $snapshot['terms'][$key] = $entry;
            continue;
        }
        if ($kind === 'adoptTerm') {
            $key = (string) $payload['taxonomy'] . ':' . (string) $payload['slug'];
            $definition = $schema['localizationSubjects']['term'] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'Candidate ThemeSchema does not define term localization.', 409);
            $current = zeroy_localization_term_subject((string) $payload['taxonomy'], (int) $payload['termId']);
            if (is_wp_error($current) || !hash_equals((string) ($current['canonicalRevision'] ?? ''), (string) ($payload['expectedSourceHash'] ?? ''))) return zeroy_runtime_error('zeroy_term_source_conflict', 'Taxonomy term changed after checkout.', 409, ['termId' => $payload['termId'] ?? null]);
            if (isset($snapshot['terms'][$key]) && (int) ($snapshot['terms'][$key]['subject']['id'] ?? 0) !== (int) $payload['termId']) return zeroy_runtime_error('zeroy_term_conflict', 'SiteCommit term ref or slug is duplicated.', 409, ['ref' => $payload['ref'] ?? null]);
            $subject = ['kind' => 'term', 'taxonomy' => (string) $payload['taxonomy'], 'id' => (int) $payload['termId']];
            $localizable = zeroy_localization_term_subject_from_values($subject, (string) $payload['taxonomy'], (string) $payload['name'], (string) ($payload['description'] ?? ''));
            $entry = ['subject' => $subject, 'taxonomy' => (string) $payload['taxonomy'], 'slug' => (string) $payload['slug'], 'localizable' => $localizable, 'definition' => $definition, 'locales' => []];
            $entry = zeroy_runtime_snapshot_refresh_locales($entry, $definition, $snapshot['siteConfig'], true);
            if (is_wp_error($entry)) return $entry;
            $snapshot['terms'][$key] = $entry;
            continue;
        }
        if ($kind === 'updateTerm' || $kind === 'retireTerm') {
            $found_key = null;
            foreach ($snapshot['terms'] as $key => $term) if (($term['subject']['id'] ?? null) === ($payload['termId'] ?? null) && ($term['taxonomy'] ?? null) === ($payload['taxonomy'] ?? null)) $found_key = $key;
            if ($found_key === null) return zeroy_runtime_error('zeroy_term_missing', 'SiteCommit references a missing taxonomy term.', 409, ['termId' => $payload['termId'] ?? null]);
            $term = $snapshot['terms'][$found_key];
            if (!hash_equals((string) ($term['localizable']['canonicalRevision'] ?? ''), (string) ($payload['expectedSourceHash'] ?? ''))) return zeroy_runtime_error('zeroy_term_source_conflict', 'Taxonomy term changed after checkout.', 409, ['termId' => $payload['termId']]);
            unset($snapshot['terms'][$found_key]);
            if ($kind === 'retireTerm') continue;
            $term['slug'] = (string) $payload['slug'];
            $term['localizable'] = zeroy_localization_term_subject_from_values($term['subject'], (string) $payload['taxonomy'], (string) $payload['name'], (string) ($payload['description'] ?? ''));
            $term = zeroy_runtime_snapshot_refresh_locales($term, $term['definition'], $snapshot['siteConfig'], true);
            if (is_wp_error($term)) return $term;
            $snapshot['terms'][(string) $payload['taxonomy'] . ':' . (string) $payload['slug']] = $term;
            continue;
        }
        if ($kind === 'assignTerms') {
            $identity = zeroy_runtime_snapshot_entity_identity($payload['objectRef'] ?? null);
            if (is_wp_error($identity) || !isset($snapshot['entities'][$identity])) return is_wp_error($identity) ? $identity : zeroy_runtime_error('zeroy_site_commit_ref_missing', 'Term assignment references a missing candidate entity.', 409);
            $snapshot['entities'][$identity]['terms'] = is_array($payload['terms'] ?? null) ? $payload['terms'] : [];
            continue;
        }
        if (in_array($kind, ['writeTranslationDraft', 'publishTranslation', 'unpublishTranslation'], true)) {
            $address = zeroy_runtime_snapshot_subject_address($snapshot, $payload['subject'] ?? null);
            if (is_wp_error($address)) return $address;
            $entry = zeroy_runtime_snapshot_subject_entry($snapshot, $address);
            $definition = zeroy_runtime_snapshot_subject_definition($entry, $schema);
            if (is_wp_error($definition)) return $definition;
            $entry = $kind === 'writeTranslationDraft'
                ? zeroy_runtime_snapshot_translation_write($entry, $definition, (string) $payload['locale'], $payload['values'], (int) $payload['expectedRevision'], $snapshot['siteConfig'])
                : zeroy_runtime_snapshot_translation_publish($entry, $definition, (string) $payload['locale'], (int) $payload['expectedRevision'], $kind === 'publishTranslation');
            if (is_wp_error($entry)) return $entry;
            $entry = $address['collection'] === 'entities'
                ? zeroy_runtime_snapshot_refresh_entity($entry, $schema, $snapshot['siteConfig'])
                : zeroy_runtime_snapshot_refresh_locales($entry, $definition, $snapshot['siteConfig'], true);
            if (is_wp_error($entry)) return $entry;
            zeroy_runtime_snapshot_put_subject_entry($snapshot, $address, $entry);
            continue;
        }
        $identity = zeroy_runtime_snapshot_entity_identity($payload['objectRef'] ?? ($payload['subject'] ?? null));
        if (is_wp_error($identity) || !isset($snapshot['entities'][$identity])) return is_wp_error($identity) ? $identity : zeroy_runtime_error('zeroy_site_checkout_ref_missing', 'Operation references a missing candidate entity.', 409, ['identity' => $identity]);
        $entity = $snapshot['entities'][$identity];
        if (in_array($kind, ['assignSchema', 'writeTemplateContent', 'writeCanonicalContent'], true)) {
            if ((int) $entity['revision'] !== (int) $payload['expectedRevision']) return zeroy_runtime_error('zeroy_canonical_conflict', 'Candidate canonical revision changed.', 409, ['currentRevision' => $entity['revision']]);
            if ($kind === 'assignSchema') $entity['schemaId'] = $payload['schemaId'];
            elseif ($kind === 'writeTemplateContent') $entity['localizable']['view']['templateContent'] = [...$entity['localizable']['view']['templateContent'], ...$payload['templateContent']];
            else {
                foreach (['postTitle' => 'title', 'postContent' => 'content', 'postExcerpt' => 'excerpt'] as $input => $field) if (array_key_exists($input, $payload)) $entity['localizable']['view']['post'][$field] = $payload[$input];
                if (is_array($payload['acf'] ?? null)) $entity['localizable']['view']['acf'] = [...$entity['localizable']['view']['acf'], ...$payload['acf']];
                if (array_key_exists('route', $payload)) {
                    $route = zeroy_runtime_normalize_route((string) $payload['route']);
                    if (is_wp_error($route)) return $route;
                    $entity['route'] = $route;
                }
            }
            $entity['revision']++;
            $entity = zeroy_runtime_snapshot_refresh_entity($entity, $schema, $snapshot['siteConfig']);
        } else return zeroy_runtime_error('zeroy_site_checkout_operation_invalid', 'Unsupported SiteCheckout operation.', 409, ['kind' => $kind]);
        if (is_wp_error($entity)) return $entity;
        $entity = zeroy_runtime_snapshot_refresh_entity($entity, $schema, $snapshot['siteConfig']);
        if (is_wp_error($entity)) return $entity;
        $snapshot['entities'][$identity] = $entity;
    }
    return zeroy_runtime_snapshot_compile_routes($snapshot, $theme_contract, $schema);
}

function zeroy_runtime_compile_base_snapshot(array $theme_contract, array $schema): array|WP_Error
{
    $site_config = zeroy_runtime_site_config();
    if (is_wp_error($site_config)) return $site_config;
    $snapshot = [
        'contract' => ZEROY_SITE_SNAPSHOT_CONTRACT,
        'site' => ['baseUrl' => home_url('/'), 'defaultLocale' => $site_config['defaultLocale'], 'enabledLocales' => array_map(static fn(array $locale): array => ['locale' => $locale['locale'], 'urlPrefix' => $locale['urlPrefix']], $site_config['enabledLocales'])],
        'siteConfig' => $site_config,
        'entities' => [],
        'terms' => [],
        'siteCopy' => [],
    ];
    foreach ($schema['schemas'] as $schema_id => $definition) {
        $ids = get_posts(['post_type' => 'any', 'post_status' => ['publish', 'draft', 'private'], 'posts_per_page' => -1, 'fields' => 'ids', 'meta_key' => ZEROY_RUNTIME_SCHEMA_META, 'meta_value' => $schema_id]);
        foreach ($ids as $id) {
            $entity = zeroy_runtime_snapshot_post_entity((int) $id, (string) $schema_id, $definition, $site_config);
            if (is_wp_error($entity)) return $entity;
            $snapshot['entities'][$entity['identity']] = $entity;
        }
    }
    $site_copy = zeroy_runtime_snapshot_site_copy($schema, $site_config);
    if (is_wp_error($site_copy)) return $site_copy;
    $terms = zeroy_runtime_snapshot_terms($theme_contract, $schema, $site_config);
    if (is_wp_error($terms)) return $terms;
    $snapshot['siteCopy'] = $site_copy;
    $snapshot['terms'] = $terms;
    return zeroy_runtime_snapshot_compile_routes($snapshot, $theme_contract, $schema);
}

function zeroy_runtime_snapshot_required_content_failure(string $code, array $subject, string $locale, string $field_id, string $evidence): array
{
    return [
        'code' => $code,
        'invariant' => 'Every published required localized field must have a present, current value under the candidate ThemeSchema.',
        'subject' => $subject,
        'locale' => $locale,
        'fieldId' => $field_id,
        'evidence' => $evidence,
        'repair' => 'Write the required canonical or locale value, then prepare a new SiteRelease.',
    ];
}

function zeroy_runtime_snapshot_required_entry_checks(array $entry, array $site_config): array
{
    $failures = [];
    $checks = [];
    $compiled = zeroy_localization_compile_subject_policy($entry['localizable'], $entry['definition']);
    if (is_wp_error($compiled)) return ['checks' => [], 'failures' => [['code' => $compiled->get_error_code(), 'message' => $compiled->get_error_message(), 'subject' => $entry['subject']]]];
    $required = array_filter($compiled['fields'], static fn(array $field): bool => ($field['policy']['required'] ?? false) === true);
    foreach ($required as $field) if (!zeroy_localization_value_is_present($field['value'])) $failures[] = zeroy_runtime_snapshot_required_content_failure('candidate_required_source_missing', $entry['subject'], (string) $site_config['defaultLocale'], (string) $field['fieldId'], 'The SiteSnapshot canonical source value is empty.');
    $checks[] = ['subject' => $entry['subject'], 'locale' => $site_config['defaultLocale'], 'requiredFields' => count($required)];
    foreach ($entry['locales'] as $locale => $state) {
        if ($locale === $site_config['defaultLocale'] || ($state['available'] ?? false) !== true) continue;
        $overlay = $state['publishedOverlay'] ?? null;
        if (!is_array($overlay)) {
            $failures[] = zeroy_runtime_snapshot_required_content_failure('candidate_required_locale_unreadable', $entry['subject'], (string) $locale, '', 'SiteSnapshot marks a locale available without a published overlay.');
            continue;
        }
        foreach ($required as $field) {
            $status = zeroy_localization_translation_status($field, $overlay);
            if ($status['status'] !== 'current') $failures[] = zeroy_runtime_snapshot_required_content_failure('candidate_required_locale_not_current', $entry['subject'], (string) $locale, (string) $field['fieldId'], 'SiteSnapshot locale value is ' . $status['status'] . '.');
        }
        $checks[] = ['subject' => $entry['subject'], 'locale' => $locale, 'requiredFields' => count($required)];
    }
    return ['checks' => $checks, 'failures' => $failures];
}

function zeroy_runtime_snapshot_required_content_checks(array $snapshot, array $schema): array
{
    $checks = [];
    $failures = [];
    $default_locale = (string) ($snapshot['siteConfig']['defaultLocale'] ?? '');
    $front_pages = array_values(array_filter(
        $snapshot['entities'],
        static fn(array $entity): bool => ($entity['routeKind'] ?? null) === 'front-page'
            && ($entity['route'] ?? null) === ''
            && (($entity['locales'][$default_locale]['available'] ?? false) === true),
    ));
    if (count($front_pages) !== 1) {
        $failures[] = [
            'code' => 'candidate_default_front_page_missing',
            'invariant' => 'A releasable site has exactly one default-locale front page at /.',
            'locale' => $default_locale,
            'evidence' => 'Candidate SiteSnapshot has ' . count($front_pages) . ' available front-page route owners for the default locale.',
            'repair' => 'Stage one front-page canonical with route / and all required default-locale content before committing.',
        ];
    }
    foreach ($snapshot['entities'] as $entity) {
        $definition = $schema['schemas'][$entity['schemaId']] ?? null;
        if (!is_array($definition)) {
            $failures[] = ['code' => 'candidate_schema_missing', 'subject' => $entity['subject'], 'schemaId' => $entity['schemaId']];
            continue;
        }
        $result = zeroy_runtime_snapshot_required_entry_checks(['subject' => $entity['subject'], 'localizable' => $entity['localizable'], 'definition' => $definition, 'locales' => $entity['locales']], $snapshot['siteConfig']);
        $checks = [...$checks, ...$result['checks']];
        $failures = [...$failures, ...$result['failures']];
    }
    if (is_array($snapshot['siteCopy']['localizable'] ?? null)) {
        $result = zeroy_runtime_snapshot_required_entry_checks($snapshot['siteCopy'], $snapshot['siteConfig']);
        $checks = [...$checks, ...$result['checks']];
        $failures = [...$failures, ...$result['failures']];
    }
    foreach ($snapshot['terms'] as $term) {
        $result = zeroy_runtime_snapshot_required_entry_checks($term, $snapshot['siteConfig']);
        $checks = [...$checks, ...$result['checks']];
        $failures = [...$failures, ...$result['failures']];
    }
    return ['checks' => $checks, 'failures' => $failures];
}

function zeroy_runtime_snapshot_semantic_acf_fields(array $snapshot, array $descriptor): array
{
    $route_id = (string) ($descriptor['routeId'] ?? '');
    if (!str_starts_with($route_id, 'subject:')) return [];
    $entity = $snapshot['entities'][substr($route_id, strlen('subject:'))] ?? null;
    if (!is_array($entity)) return [];
    $reference_types = ['image', 'file', 'gallery', 'post_object', 'relationship', 'taxonomy'];
    $fields = [];
    foreach (is_array($entity['localizable']['fields'] ?? null) ? $entity['localizable']['fields'] : [] as $field) {
        $kind = (string) ($field['kind'] ?? '');
        $field_id = (string) ($field['fieldId'] ?? '');
        if (!str_starts_with($kind, 'acf:') || in_array(substr($kind, strlen('acf:')), $reference_types, true)) continue;
        $parts = zeroy_localization_pointer_parts($field_id);
        if (is_wp_error($parts) || count($parts) < 2 || $parts[0] !== 'acf') continue;
        $fields['/acf/' . zeroy_localization_pointer_segment((string) $parts[1])] = true;
    }
    return $fields;
}

function zeroy_runtime_snapshot_scenarios(array $snapshot): array
{
    $scenarios = [];
    foreach ($snapshot['routes'] as $locale => $routes) {
        foreach ($routes as $route => $descriptor) {
            $kind = (string) $descriptor['routeKind'];
            $required_fields = [];
            $semantic_fields = zeroy_runtime_snapshot_semantic_acf_fields($snapshot, $descriptor);
            foreach (is_array($descriptor['resolvedContent']['acf'] ?? null) ? $descriptor['resolvedContent']['acf'] : [] as $field_key => $value) {
                $has_value = is_array($value) ? $value !== [] : !in_array($value, [null, ''], true);
                $field_id = '/acf/' . zeroy_localization_pointer_segment((string) $field_key);
                if ($has_value && isset($semantic_fields[$field_id])) $required_fields[] = $field_id;
            }
            sort($required_fields, SORT_STRING);
            $scenarios[] = [
                'id' => $kind . ':' . $locale . ':' . ($route === '' ? 'root' : $route),
                'kind' => $kind,
                'locale' => $locale,
                'path' => parse_url((string) zeroy_runtime_snapshot_route_url($snapshot, (string) $locale, (string) $route), PHP_URL_PATH) ?: '/',
                ...($kind === 'search' ? ['query' => ['s' => 'zeroy-verifier']] : []),
                'expectedStatus' => 200,
                'expectedRouteKind' => $kind,
                'requiredFields' => $required_fields,
            ];
        }
        $prefix = '';
        foreach ($snapshot['site']['enabledLocales'] as $config) if ($config['locale'] === $locale) $prefix = trim((string) $config['urlPrefix'], '/');
        $scenarios[] = ['id' => 'not-found:' . $locale, 'kind' => 'not-found', 'locale' => $locale, 'path' => '/' . ($prefix === '' ? '' : $prefix . '/') . '__zeroy-verifier-not-found__/', 'expectedStatus' => 404, 'expectedRouteKind' => 'not-found', 'requiredFields' => []];
    }
    usort($scenarios, static fn(array $left, array $right): int => strcmp($left['id'], $right['id']));
    return $scenarios;
}
