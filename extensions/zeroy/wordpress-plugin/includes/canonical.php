<?php

defined("ABSPATH") || exit;

function zeroy_runtime_canonical(int $object_id): array|WP_Error
{
    $post = get_post($object_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_canonical_missing', "Canonical WordPress object {$object_id} does not exist.", 404);
    }
    $schema_id = (string) get_post_meta($object_id, ZEROY_RUNTIME_SCHEMA_META, true);
    $revision = (int) get_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, true);
    if ($schema_id === '' || $revision < 1) {
        return zeroy_runtime_error('zeroy_canonical_unassigned', "WordPress object {$object_id} is not a zeroY canonical object.", 409);
    }
    return ['objectId' => $object_id, 'post' => $post, 'schemaId' => $schema_id, 'revision' => $revision];
}

function zeroy_runtime_canonical_route_slug(WP_Post $post): string
{
    $candidate = sanitize_title($post->post_name);
    return $candidate !== '' ? $candidate : 'zeroy-' . $post->ID;
}

function zeroy_runtime_ensure_canonical_route_slug(int $object_id): true|WP_Error
{
    $post = get_post($object_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_canonical_missing', "WordPress object {$object_id} does not exist.", 404);
    }
    $current = zeroy_runtime_normalize_route((string) $post->post_name);
    if (!is_wp_error($current)) {
        return true;
    }
    $slug = zeroy_runtime_canonical_route_slug($post);
    $updated = wp_update_post(['ID' => $post->ID, 'post_name' => $slug], true);
    if (is_wp_error($updated)) {
        return zeroy_runtime_error('zeroy_canonical_route_write_failed', $updated->get_error_message(), 500, ['objectId' => $object_id]);
    }
    $next = get_post($object_id);
    return $next instanceof WP_Post && !is_wp_error(zeroy_runtime_normalize_route((string) $next->post_name))
        ? true
        : zeroy_runtime_error('zeroy_canonical_route_write_failed', 'Could not establish a path-safe canonical route slug.', 409, ['objectId' => $object_id]);
}

function zeroy_runtime_migrate_canonical_route_slugs(): true|WP_Error
{
    global $wpdb;
    $ids = $wpdb->get_col($wpdb->prepare('SELECT post_id FROM ' . $wpdb->postmeta . ' WHERE meta_key = %s', ZEROY_RUNTIME_SCHEMA_META));
    foreach (is_array($ids) ? $ids : [] as $object_id) {
        $result = zeroy_runtime_ensure_canonical_route_slug((int) $object_id);
        if (is_wp_error($result)) {
            return $result;
        }
    }
    return true;
}

function zeroy_runtime_create_canonical(string $post_type, string $schema_id, string $post_title): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_type, $schema_id, $post_title) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        if (!in_array($post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', "Post type {$post_type} is not allowed by ThemeSchema {$schema_id}.", 400);
        }
        $object_id = wp_insert_post([
            'post_type' => $post_type,
            'post_status' => 'draft',
            'post_title' => $post_title !== '' ? $post_title : 'zeroY canonical object',
        ], true);
        if (is_wp_error($object_id)) {
            return zeroy_runtime_error('zeroy_canonical_create_failed', $object_id->get_error_message(), 500);
        }
        update_post_meta((int) $object_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
        update_post_meta((int) $object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1);
        $route = zeroy_runtime_ensure_canonical_route_slug((int) $object_id);
        if (is_wp_error($route)) {
            return $route;
        }
        return zeroy_runtime_canonical((int) $object_id);
    });
}

function zeroy_runtime_existing_post_facts(WP_Post $post): array
{
    // existingPost is the Agent's template-authoring projection. Its keys and
    // values must match ACF's runtime get_field()/get_fields() view, not the
    // internal database/field-key representation used for storage.
    $acf = function_exists('get_fields') ? get_fields($post->ID, true) : [];
    return [
        'post' => [
            'postId' => (int) $post->ID,
            'postType' => $post->post_type,
            'postStatus' => $post->post_status,
            'postTitle' => $post->post_title,
            'postName' => $post->post_name,
            'postContent' => $post->post_content,
            'postExcerpt' => $post->post_excerpt,
            'modifiedGmt' => $post->post_modified_gmt,
            'permalink' => get_permalink($post) ?: null,
        ],
        'acf' => is_array($acf) ? $acf : [],
    ];
}

function zeroy_runtime_existing_post_projection(WP_Post $post): array
{
    $facts = zeroy_runtime_existing_post_facts($post);
    return [
        ...$facts,
        'sourceHash' => zeroy_runtime_hash($facts),
    ];
}

function zeroy_runtime_adoption_candidate_projection(WP_Post $post): array
{
    $facts = zeroy_runtime_existing_post_facts($post);
    return [
        'postId' => $facts['post']['postId'],
        'postType' => $facts['post']['postType'],
        'postStatus' => $facts['post']['postStatus'],
        'postTitle' => $facts['post']['postTitle'],
        'permalink' => $facts['post']['permalink'],
        'modifiedGmt' => $facts['post']['modifiedGmt'],
        'acfFieldNames' => array_keys($facts['acf']),
        'sourceHash' => zeroy_runtime_hash($facts),
    ];
}

function zeroy_runtime_adoption_candidates(?string $post_type, ?string $schema_id, int $page = 1, int $per_page = 50): array|WP_Error
{
    global $wpdb;
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $where = 'schema_meta.post_id IS NULL AND p.post_status NOT IN (\'auto-draft\', \'trash\', \'inherit\') AND p.post_type NOT IN (\'revision\', \'attachment\', \'nav_menu_item\', \'custom_css\', \'customize_changeset\')';
    $arguments = [ZEROY_RUNTIME_SCHEMA_META];
    if ($post_type !== null && $post_type !== '') {
        if (!post_type_exists($post_type)) {
            return zeroy_runtime_error('zeroy_adoption_post_type_invalid', "Unknown WordPress post type {$post_type}.", 400);
        }
        $where .= ' AND p.post_type = %s';
        $arguments[] = $post_type;
    }
    if ($schema_id !== null && $schema_id !== '') {
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        $allowed = $definition['canonicalPostTypes'];
        $placeholders = implode(', ', array_fill(0, count($allowed), '%s'));
        $where .= " AND p.post_type IN ({$placeholders})";
        array_push($arguments, ...$allowed);
    }
    $from = ' FROM ' . $wpdb->posts . ' p LEFT JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s';
    $count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*)' . $from . ' WHERE ' . $where, ...$arguments));
    $offset = ($page - 1) * $per_page;
    $rows = $wpdb->get_results(
        $wpdb->prepare('SELECT p.ID FROM ' . $wpdb->posts . ' p LEFT JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s WHERE ' . $where . ' ORDER BY p.ID DESC LIMIT %d OFFSET %d', ...[...$arguments, $per_page, $offset]),
        ARRAY_A
    );
    $items = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $post = get_post((int) $row['ID']);
        if ($post instanceof WP_Post) {
            $items[] = zeroy_runtime_adoption_candidate_projection($post);
        }
    }
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $count];
}

function zeroy_runtime_existing_unmanaged_post(int $post_id): array|WP_Error
{
    $post = get_post($post_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_existing_post_missing', "WordPress post {$post_id} does not exist.", 404);
    }
    if ((string) get_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, true) !== '') {
        return zeroy_runtime_error('zeroy_existing_post_adopted', "WordPress post {$post_id} is already a zeroY canonical object.", 409);
    }
    return zeroy_runtime_existing_post_projection($post);
}

function zeroy_runtime_adopt_canonical(int $post_id, string $schema_id, string $expected_source_hash): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_id, $schema_id, $expected_source_hash) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $projection = zeroy_runtime_existing_unmanaged_post($post_id);
        if (is_wp_error($projection)) {
            return $projection;
        }
        $current_hash = $projection['sourceHash'];
        if (!hash_equals($current_hash, $expected_source_hash)) {
            return zeroy_runtime_error(
                'zeroy_adoption_source_conflict',
                'WordPress or ACF facts changed after this post was read.',
                409,
                ['currentSourceHash' => $current_hash]
            );
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        $post = get_post($post_id);
        if (!$post instanceof WP_Post || !in_array($post->post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', 'The selected ThemeSchema does not allow this WordPress post type.', 400);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id, true)) {
            return zeroy_runtime_error('zeroy_canonical_already_adopted', 'WordPress post became a zeroY canonical object before adoption completed.', 409);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1, true)) {
            delete_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
            return zeroy_runtime_error('zeroy_canonical_adoption_failed', 'Could not initialize canonical revision during adoption.', 500);
        }
        return zeroy_runtime_canonical($post_id);
    });
}

function zeroy_runtime_assign_canonical_schema(int $object_id, string $schema_id, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $schema_id, $expected_revision) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) {
            return $canonical;
        }
        if ($canonical['revision'] !== $expected_revision) {
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, ['currentRevision' => $canonical['revision']]);
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        if (!in_array($canonical['post']->post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', 'The selected ThemeSchema does not allow this canonical object type.', 400);
        }
        global $wpdb;
        $heads = (int) $wpdb->get_var($wpdb->prepare(
            'SELECT COUNT(*) FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE subject_key = %s',
            zeroy_localization_subject_key(['kind' => 'post', 'id' => $object_id])
        ));
        if ($heads > 0) {
            return zeroy_runtime_error('zeroy_schema_assignment_locked', 'A canonical object with locale documents cannot change ThemeSchema.', 409);
        }
        $next_revision = $expected_revision + 1;
        $updated = update_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, $next_revision, $expected_revision);
        if ($updated === false) {
            $fresh = zeroy_runtime_canonical($object_id);
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, [
                'currentRevision' => is_array($fresh) ? $fresh['revision'] : null,
            ]);
        }
        update_post_meta($object_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
        return zeroy_runtime_canonical($object_id);
    });
}

function zeroy_runtime_write_template_content(int $object_id, mixed $values, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $values, $expected_revision) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        if (!zeroy_runtime_is_keyed_map($values)) {
            return zeroy_runtime_error('zeroy_template_content_invalid', 'TemplateContent values must be a keyed object of declared text fields.', 400);
        }
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) {
            return $canonical;
        }
        if ($canonical['revision'] !== $expected_revision) {
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, ['currentRevision' => $canonical['revision']]);
        }
        $definition = zeroy_runtime_schema_definition($canonical['schemaId']);
        if (is_wp_error($definition)) {
            return $definition;
        }
        $next_values = zeroy_localization_template_content_values($object_id, $definition);
        if (is_wp_error($next_values)) {
            return $next_values;
        }
        foreach ($values as $key => $value) {
            if (!is_string($key) || !is_string($value)) {
                return zeroy_runtime_error('zeroy_template_content_invalid', 'TemplateContent writes require string keys and string values.', 400);
            }
            $next_values[$key] = $value;
        }
        $next_revision = $expected_revision + 1;
        if (update_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, $next_revision, $expected_revision) === false) {
            $fresh = zeroy_runtime_canonical($object_id);
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed while writing TemplateContent.', 409, ['currentRevision' => is_array($fresh) ? $fresh['revision'] : null]);
        }
        $written = zeroy_localization_replace_template_content($object_id, $next_values, $definition);
        if (is_wp_error($written)) {
            return $written;
        }
        return zeroy_runtime_canonical($object_id);
    });
}
