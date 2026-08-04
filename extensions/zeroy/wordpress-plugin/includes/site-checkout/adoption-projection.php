<?php

defined('ABSPATH') || exit;

function zeroy_adoption_unmanaged_posts(?string $post_type = null): array
{
    global $wpdb;
    $where = "schema_meta.post_id IS NULL AND p.post_status NOT IN ('auto-draft', 'trash', 'inherit') AND p.post_type NOT IN ('revision', 'attachment', 'nav_menu_item', 'custom_css', 'customize_changeset')";
    $arguments = [ZEROY_RUNTIME_SCHEMA_META];
    if (is_string($post_type) && $post_type !== '') {
        $where .= ' AND p.post_type = %s';
        $arguments[] = $post_type;
    }
    $rows = $wpdb->get_results($wpdb->prepare(
        'SELECT p.ID FROM ' . $wpdb->posts . ' p LEFT JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s WHERE ' . $where . ' ORDER BY p.ID ASC',
        ...$arguments,
    ), ARRAY_A);
    $posts = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $post = get_post((int) ($row['ID'] ?? 0));
        if ($post instanceof WP_Post && ($post_type !== null || is_post_type_viewable($post->post_type))) $posts[] = $post;
    }
    return $posts;
}

function zeroy_adoption_post_ref(WP_Post $post): string|WP_Error
{
    $ref = sanitize_title((string) $post->post_name);
    if ($ref === '') $ref = sanitize_title((string) $post->post_title);
    return $ref !== '' && zeroy_document_ref_valid($ref)
        ? $ref
        : zeroy_runtime_error('zeroy_adoption_ref_invalid', 'An unmanaged WordPress post has no path-safe stable slug.', 409, ['postId' => (int) $post->ID]);
}

function zeroy_adoption_post_route(WP_Post $post): string|WP_Error
{
    if ($post->post_type === 'page' && (int) get_option('page_on_front', 0) === (int) $post->ID) return '/';
    $permalink = get_permalink($post);
    $path = is_string($permalink) ? wp_parse_url($permalink, PHP_URL_PATH) : null;
    if (!is_string($path) || $path === '') return zeroy_runtime_error('zeroy_adoption_route_invalid', 'An unmanaged WordPress post has no usable permalink path.', 409, ['postId' => (int) $post->ID]);
    $normalized = zeroy_runtime_normalize_route($path);
    return is_wp_error($normalized) ? $normalized : ($normalized === '' ? '/' : '/' . trim($normalized, '/') . '/');
}

function zeroy_adoption_post_matches_definition(WP_Post $post, array $definition): bool
{
    $front_page_id = (int) get_option('page_on_front', 0);
    return ($definition['routeKind'] ?? null) === 'front-page'
        ? $front_page_id > 0 && $front_page_id === (int) $post->ID
        : $front_page_id === 0 || $front_page_id !== (int) $post->ID;
}

function zeroy_adoption_text_seed(string $bytes): array
{
    return ['encoding' => 'utf8', 'content' => $bytes];
}

function zeroy_adoption_binary_seed(string $bytes): array
{
    return ['encoding' => 'base64', 'bytesBase64' => base64_encode($bytes)];
}

function zeroy_adoption_media_ref(WP_Post $attachment): string|WP_Error
{
    $owned = get_post_meta($attachment->ID, '_zeroy_authored_media_ref', true);
    if (is_string($owned) && $owned !== '') return $owned;
    $file = get_attached_file($attachment->ID);
    $filename = is_string($file) ? strtolower((string) basename($file)) : '';
    $ref = preg_replace('/[^a-z0-9._-]+/', '-', $filename);
    return is_string($ref) && $ref !== '' && preg_match('#\A[a-z0-9](?:[a-z0-9._/-]{0,190}[a-z0-9])?\z#', $ref) === 1
        ? $ref
        : zeroy_runtime_error('zeroy_adoption_media_ref_invalid', 'An unmanaged WordPress attachment has no path-safe stable filename.', 409, ['attachmentId' => (int) $attachment->ID]);
}

function zeroy_adoption_media_bytes(WP_Post $attachment): string|WP_Error
{
    $file = get_attached_file($attachment->ID);
    $bytes = is_string($file) && is_file($file) ? file_get_contents($file) : false;
    return is_string($bytes)
        ? $bytes
        : zeroy_runtime_error('zeroy_adoption_media_bytes_missing', 'An unmanaged WordPress attachment cannot be read from its source file.', 409, ['attachmentId' => (int) $attachment->ID]);
}

function zeroy_adoption_unmanaged_terms(array $taxonomies): array
{
    $terms = [];
    foreach (array_values(array_unique(array_filter($taxonomies, 'is_string'))) as $taxonomy) {
        if (!taxonomy_exists($taxonomy)) continue;
        $rows = get_terms(['taxonomy' => $taxonomy, 'hide_empty' => false]);
        foreach (is_array($rows) ? $rows : [] as $term) {
            if (!$term instanceof WP_Term || get_term_meta($term->term_id, '_zeroy_authored_ref', true) !== '') continue;
            $terms[] = $term;
        }
    }
    return $terms;
}

function zeroy_adoption_taxonomies(array $compiled): array
{
    $taxonomies = [];
    foreach (is_array($compiled['schema']['collections'] ?? null) ? $compiled['schema']['collections'] : [] as $collection) {
        if (($collection['kind'] ?? null) === 'taxonomy' && is_string($collection['taxonomy'] ?? null)) $taxonomies[$collection['taxonomy']] = true;
    }
    return array_keys($taxonomies);
}

function zeroy_adoption_reference(string $kind, mixed $value, array $field): array|WP_Error
{
    $id = $value instanceof WP_Post
        ? (int) $value->ID
        : ($value instanceof WP_Term
            ? (int) $value->term_id
            : (is_numeric($value) ? (int) $value : (is_array($value) && is_numeric($value['ID'] ?? null) ? (int) $value['ID'] : 0)));
    if ($kind === 'post') {
        $post = $value instanceof WP_Post ? $value : get_post($id);
        if (!$post instanceof WP_Post) return zeroy_runtime_error('zeroy_adoption_post_reference_missing', 'An ACF post reference cannot be projected to a stable ref.', 409);
        $ref = zeroy_adoption_post_ref($post);
        return is_wp_error($ref) ? $ref : ['kind' => 'post', 'ref' => $ref];
    }
    if ($kind === 'term') {
        $taxonomy = is_string($field['taxonomy'] ?? null) ? $field['taxonomy'] : (is_array($field['taxonomy'] ?? null) ? (string) ($field['taxonomy'][0] ?? '') : '');
        $term = $value instanceof WP_Term ? $value : ($id > 0 && $taxonomy !== '' ? get_term($id, $taxonomy) : null);
        if (!$term instanceof WP_Term || $term->slug === '') return zeroy_runtime_error('zeroy_adoption_term_reference_missing', 'An ACF term reference cannot be projected to a stable ref.', 409);
        return ['kind' => 'term', 'taxonomy' => $term->taxonomy, 'ref' => $term->slug];
    }
    $attachment = get_post($id);
    if (!$attachment instanceof WP_Post || $attachment->post_type !== 'attachment') return zeroy_runtime_error('zeroy_adoption_media_reference_missing', 'An ACF media reference cannot be projected to a stable ref.', 409);
    $ref = zeroy_adoption_media_ref($attachment);
    return is_wp_error($ref) ? $ref : ['kind' => 'media', 'ref' => $ref];
}

function zeroy_adoption_collect_references(mixed $value, array &$terms, array &$media): void
{
    if (!is_array($value)) return;
    if (($value['kind'] ?? null) === 'term' && is_string($value['taxonomy'] ?? null) && is_string($value['ref'] ?? null)) {
        $terms[$value['taxonomy'] . ':' . $value['ref']] = true;
        return;
    }
    if (($value['kind'] ?? null) === 'media' && is_string($value['ref'] ?? null)) {
        $media[$value['ref']] = true;
        return;
    }
    foreach ($value as $entry) zeroy_adoption_collect_references($entry, $terms, $media);
}

function zeroy_adoption_term_assignment_reference(WP_Term $term): array
{
    return ['kind' => 'term', 'ref' => $term->slug];
}

function zeroy_adoption_acf_document(WP_Post $post, array $definition, string $path, array &$failures): array
{
    $runtime = function_exists('get_fields') ? get_fields($post->ID, true) : [];
    if (!is_array($runtime)) return [];
    $policy = zeroy_localization_compiled_policy($definition);
    $item_keys = is_wp_error($policy) ? [] : $policy['repeaterItemKeys'];
    $encoded = [];
    foreach (zeroy_document_acf_fields($post->post_type) as $key => $field) {
        $name = (string) ($field['name'] ?? '');
        if ($name === '' || !array_key_exists($name, $runtime)) continue;
        $encoded[$key] = zeroy_document_acf_encode_field(
            $field,
            $runtime[$name],
            $item_keys,
            '/acf/' . zeroy_localization_pointer_segment($key),
            'zeroy_adoption_reference',
            $path,
            $failures,
        );
    }
    return $encoded;
}

function zeroy_adoption_projection(array $files, ?array $compiled): array
{
    if (!is_array($compiled)) return ['files' => [], 'failures' => []];
    $decode_failures = [];
    $site = zeroy_document_decode_site($files, $decode_failures);
    if (!is_array($site)) return ['files' => [], 'failures' => []];
    $seeds = [];
    $failures = [];
    $referenced_terms = [];
    $referenced_media = [];
    foreach ($site['collections'] as $collection_id => $collection) {
        $definition = $compiled['schema']['schemas'][$collection['schemaId']] ?? null;
        if (!is_array($definition)) continue;
        foreach (zeroy_adoption_unmanaged_posts($collection['postType']) as $post) {
            if (!zeroy_adoption_post_matches_definition($post, $definition)) continue;
            $ref = zeroy_adoption_post_ref($post);
            $route = zeroy_adoption_post_route($post);
            if (is_wp_error($ref) || is_wp_error($route)) continue;
            $path = "content/posts/{$collection_id}/{$ref}.json";
            if (isset($files[$path])) continue;
            $acf = zeroy_adoption_acf_document($post, $definition, $path, $failures);
            zeroy_adoption_collect_references($acf, $referenced_terms, $referenced_media);
            $terms = [];
            foreach (get_object_taxonomies($post->post_type, 'names') as $taxonomy) {
                $assigned = wp_get_object_terms($post->ID, $taxonomy);
                if (is_wp_error($assigned) || $assigned === []) continue;
                $terms[$taxonomy] = [];
                foreach ($assigned as $term) {
                    if (!$term instanceof WP_Term) continue;
                    $terms[$taxonomy][] = zeroy_adoption_term_assignment_reference($term);
                    $referenced_terms[$taxonomy . ':' . $term->slug] = true;
                }
            }
            $document = [
                'route' => $route,
                'post' => ['title' => $post->post_title, 'content' => $post->post_content, 'excerpt' => $post->post_excerpt],
                'acf' => zeroy_runtime_json_map($acf),
                'templateContent' => new stdClass(),
                'terms' => zeroy_runtime_json_map($terms),
            ];
            $seeds[$path] = zeroy_adoption_text_seed(zeroy_checkout_json_bytes($document));
            $failures[] = zeroy_document_failure(
                'adoption_source_unprojected',
                $path,
                '',
                'An existing WordPress post mapped by site.json is not yet owned by a canonical document.',
                'The Connector staged the canonical document from current WordPress and ACF facts. Review it and push another coherent repair slice.',
            );
        }
    }
    foreach (zeroy_adoption_unmanaged_terms(zeroy_adoption_taxonomies($compiled)) as $term) {
        $path = "content/terms/{$term->taxonomy}/{$term->slug}.json";
        if (isset($files[$path])) continue;
        $seeds[$path] = zeroy_adoption_text_seed(zeroy_checkout_json_bytes(['slug' => $term->slug, 'name' => $term->name, 'description' => $term->description]));
        $failures[] = zeroy_document_failure('adoption_term_unprojected', $path, '', 'An existing WordPress term referenced by adopted content is not yet owned by a canonical document.', 'Review the staged term document and push another coherent repair slice.');
    }
    foreach (zeroy_adoption_unmanaged_media(array_keys($referenced_media)) as $ref => $attachment) {
        $path = 'media/' . $ref;
        if (isset($files[$path])) continue;
        $bytes = zeroy_adoption_media_bytes($attachment);
        if (is_wp_error($bytes)) {
            $failures[] = zeroy_document_failure($bytes->get_error_code(), $path, '', $bytes->get_error_message(), 'Restore the attachment source file or remove the broken media reference.');
            continue;
        }
        $seeds[$path] = zeroy_adoption_binary_seed($bytes);
        $failures[] = zeroy_document_failure('adoption_media_unprojected', $path, '', 'An existing WordPress attachment referenced by adopted content is not yet owned by an authored media file.', 'Review the staged media file and push another coherent repair slice.');
    }
    ksort($seeds, SORT_STRING);
    return ['files' => $seeds, 'failures' => $failures];
}

function zeroy_adoption_external_facts(array $post_types): array
{
    $facts = [];
    foreach (array_values(array_unique(array_filter($post_types, 'is_string'))) as $post_type) {
        foreach (zeroy_adoption_unmanaged_posts($post_type) as $post) {
            $projection = zeroy_runtime_existing_post_projection($post);
            $facts[(string) $post->ID] = ['postType' => $post->post_type, 'slug' => $post->post_name, 'sourceHash' => $projection['sourceHash']];
        }
    }
    ksort($facts, SORT_STRING);
    return $facts;
}

function zeroy_adoption_unmanaged_media(array $refs): array
{
    $wanted = array_fill_keys($refs, true);
    $matches = [];
    foreach (get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'posts_per_page' => -1]) as $attachment) {
        if (!$attachment instanceof WP_Post || get_post_meta($attachment->ID, '_zeroy_authored_media_ref', true) !== '') continue;
        $ref = zeroy_adoption_media_ref($attachment);
        if (!is_wp_error($ref) && isset($wanted[$ref])) $matches[$ref] = $attachment;
    }
    return $matches;
}

function zeroy_adoption_find_unmanaged_media(string $ref): WP_Post|null|WP_Error
{
    $matches = zeroy_adoption_unmanaged_media([$ref]);
    return $matches[$ref] ?? null;
}

function zeroy_adoption_find_unmanaged_term(string $taxonomy, string $ref, string $slug): WP_Term|null|WP_Error
{
    $matches = array_values(array_filter(
        zeroy_adoption_unmanaged_terms([$taxonomy]),
        static fn(WP_Term $term): bool => $term->slug === $slug || $term->slug === $ref,
    ));
    if (count($matches) > 1) return zeroy_runtime_error('zeroy_adoption_term_ref_ambiguous', 'Multiple unmanaged WordPress terms project to the same authored identity.', 409, ['taxonomy' => $taxonomy, 'ref' => $ref]);
    return $matches[0] ?? null;
}

function zeroy_adoption_term_external_facts(array $taxonomies): array
{
    $facts = [];
    foreach (zeroy_adoption_unmanaged_terms($taxonomies) as $term) {
        $subject = zeroy_localization_term_subject($term->taxonomy, $term->term_id);
        if (!is_wp_error($subject)) $facts[$term->taxonomy . ':' . $term->slug] = $subject['canonicalRevision'];
    }
    ksort($facts, SORT_STRING);
    return $facts;
}

function zeroy_adoption_media_external_facts(array $post_types): array
{
    $refs = [];
    foreach (array_values(array_unique(array_filter($post_types, 'is_string'))) as $post_type) {
        foreach (zeroy_adoption_unmanaged_posts($post_type) as $post) {
            $failures = [];
            $acf = zeroy_adoption_acf_document($post, [], 'external-facts', $failures);
            $terms = [];
            zeroy_adoption_collect_references($acf, $terms, $refs);
        }
    }
    $facts = [];
    foreach (zeroy_adoption_unmanaged_media(array_keys($refs)) as $ref => $attachment) {
        $bytes = zeroy_adoption_media_bytes($attachment);
        if (!is_wp_error($bytes)) $facts[$ref] = zeroy_checkout_blob_hash($bytes);
    }
    ksort($facts, SORT_STRING);
    return $facts;
}

function zeroy_adoption_find_unmanaged_post(string $post_type, string $ref, array $definition): WP_Post|null|WP_Error
{
    $matches = array_values(array_filter(
        zeroy_adoption_unmanaged_posts($post_type),
        static fn(WP_Post $post): bool => zeroy_adoption_post_matches_definition($post, $definition) && !is_wp_error($candidate = zeroy_adoption_post_ref($post)) && $candidate === $ref,
    ));
    if (count($matches) > 1) return zeroy_runtime_error('zeroy_adoption_ref_ambiguous', 'Multiple unmanaged WordPress posts project to the same stable ref.', 409, ['postType' => $post_type, 'ref' => $ref]);
    return $matches[0] ?? null;
}
