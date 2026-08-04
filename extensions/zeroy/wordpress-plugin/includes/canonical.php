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
    $route = get_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_ROUTE_META, true);
    if ($schema_id === '' || $revision < 1 || !is_string($route)) {
        return zeroy_runtime_error('zeroy_canonical_unassigned', "WordPress object {$object_id} is not a zeroY canonical object.", 409);
    }
    return ['objectId' => $object_id, 'post' => $post, 'schemaId' => $schema_id, 'route' => $route, 'revision' => $revision];
}

function zeroy_runtime_create_canonical(string $post_type, string $schema_id, array $definition, string $route, string $post_title, string $post_content = '', string $post_excerpt = '', array $template_content = []): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_type, $schema_id, $definition, $route, $post_title, $post_content, $post_excerpt, $template_content) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        if (!in_array($post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', "Post type {$post_type} is not allowed by ThemeSchema {$schema_id}.", 400);
        }
        $route = zeroy_runtime_normalize_route($route);
        if (is_wp_error($route)) return $route;
        $object_id = wp_insert_post([
            'post_type' => $post_type,
            // SiteCheckout is the only draft layer. This write runs inside
            // SiteRelease activation, so a newly materialized canonical is
            // published exactly when its immutable snapshot becomes active.
            'post_status' => 'publish',
            'post_title' => $post_title !== '' ? $post_title : 'zeroY canonical object',
            'post_content' => $post_content,
            'post_excerpt' => $post_excerpt,
        ], true);
        if (is_wp_error($object_id)) {
            return zeroy_runtime_error('zeroy_canonical_create_failed', $object_id->get_error_message(), 500);
        }
        update_post_meta((int) $object_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
        update_post_meta((int) $object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1);
        update_post_meta((int) $object_id, ZEROY_RUNTIME_CANONICAL_ROUTE_META, $route);
        if ($template_content !== []) {
            $written = zeroy_localization_replace_template_content((int) $object_id, $template_content, $definition);
            if (is_wp_error($written)) return $written;
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

function zeroy_runtime_existing_post_field_projection(WP_Post $post, string $schema_id, ?array $definition_override = null): array|WP_Error
{
    $definition = $definition_override ?? zeroy_runtime_schema_definition($schema_id);
    if (is_wp_error($definition)) return $definition;
    $facts = zeroy_runtime_existing_post_facts($post);
    $stable_acf = zeroy_localization_acf_stable_top_view(is_array($facts['acf']) ? $facts['acf'] : [], ['post_id' => (int) $post->ID]);
    if (is_wp_error($stable_acf)) return $stable_acf;
    $localizable = zeroy_localization_post_subject_from_view(
        ['kind' => 'post', 'id' => (int) $post->ID],
        $schema_id,
        $definition,
        $post->post_type,
        [
            'post' => [
                'title' => $facts['post']['postTitle'],
                'content' => $facts['post']['postContent'],
                'excerpt' => $facts['post']['postExcerpt'],
            ],
            'acf' => $stable_acf,
            'templateContent' => [],
        ],
        1,
        ['post_id' => (int) $post->ID],
    );
    if (is_wp_error($localizable)) return $localizable;
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    if (is_wp_error($compiled)) return $compiled;
    return [
        'contract' => 'zeroy/field-projection@1',
        'subject' => ['kind' => 'post', 'id' => (int) $post->ID],
        'schemaId' => $schema_id,
        'canonicalRevision' => $localizable['canonicalRevision'],
        'fields' => array_values($compiled['fields']),
    ];
}

function zeroy_runtime_existing_unmanaged_post(int $post_id, ?string $schema_id = null, ?array $definition_override = null): array|WP_Error
{
    $post = get_post($post_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_existing_post_missing', "WordPress post {$post_id} does not exist.", 404);
    }
    if ((string) get_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, true) !== '') {
        return zeroy_runtime_error('zeroy_existing_post_adopted', "WordPress post {$post_id} is already a zeroY canonical object.", 409);
    }
    $projection = zeroy_runtime_existing_post_projection($post);
    if ($schema_id === null || $schema_id === '') return $projection;
    $field_projection = zeroy_runtime_existing_post_field_projection($post, $schema_id, $definition_override);
    return is_wp_error($field_projection) ? $field_projection : [...$projection, 'fieldProjection' => $field_projection];
}

function zeroy_runtime_adopt_canonical(int $post_id, string $schema_id, array $definition, string $route, string $expected_source_hash): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_id, $schema_id, $definition, $route, $expected_source_hash) {
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
        $post = get_post($post_id);
        if (!$post instanceof WP_Post || !in_array($post->post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', 'The selected ThemeSchema does not allow this WordPress post type.', 400);
        }
        $route = zeroy_runtime_normalize_route($route);
        if (is_wp_error($route)) return $route;
        if (!add_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id, true)) {
            return zeroy_runtime_error('zeroy_canonical_already_adopted', 'WordPress post became a zeroY canonical object before adoption completed.', 409);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1, true)) {
            delete_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
            return zeroy_runtime_error('zeroy_canonical_adoption_failed', 'Could not initialize canonical revision during adoption.', 500);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_CANONICAL_ROUTE_META, $route, true)) {
            delete_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
            delete_post_meta($post_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1);
            return zeroy_runtime_error('zeroy_canonical_adoption_failed', 'Could not persist the explicit canonical route during adoption.', 500);
        }
        return zeroy_runtime_canonical($post_id);
    });
}

function zeroy_runtime_retire_canonical(int $object_id, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $expected_revision) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) return $lease;
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) return $canonical;
        if ((int) $canonical['revision'] !== $expected_revision) return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, ['currentRevision' => $canonical['revision']]);
        $subject_key = zeroy_localization_subject_key(['kind' => 'post', 'id' => $object_id]);
        if ($wpdb->delete(zeroy_runtime_table('locale_overlay_versions'), ['subject_key' => $subject_key], ['%s']) === false) return zeroy_runtime_error('zeroy_canonical_retirement_failed', $wpdb->last_error ?: 'Could not retire canonical LocaleOverlay versions.', 500);
        if ($wpdb->delete(zeroy_runtime_table('locale_overlay_heads'), ['subject_key' => $subject_key], ['%s']) === false) return zeroy_runtime_error('zeroy_canonical_retirement_failed', $wpdb->last_error ?: 'Could not retire canonical LocaleOverlay heads.', 500);
        foreach ([ZEROY_RUNTIME_SCHEMA_META, ZEROY_RUNTIME_CANONICAL_REVISION_META, ZEROY_RUNTIME_CANONICAL_ROUTE_META, ZEROY_RUNTIME_TEMPLATE_CONTENT_META] as $meta_key) delete_post_meta($object_id, $meta_key);
        return ['objectId' => $object_id, 'state' => 'retired'];
    });
}

function zeroy_runtime_assign_canonical_schema(int $object_id, string $schema_id, array $definition, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $schema_id, $definition, $expected_revision) {
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

function zeroy_runtime_write_template_content(int $object_id, array $definition, mixed $values, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $definition, $values, $expected_revision) {
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
        $required_violations = zeroy_localization_template_content_required_violations($next_values, $definition);
        if ($required_violations !== []) {
            return zeroy_runtime_error('zeroy_template_content_required_missing', 'TemplateContent has empty required fields.', 409, ['violations' => $required_violations]);
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

function zeroy_runtime_acf_comparable_value(array $field, mixed $value): mixed
{
    $type = (string) ($field['type'] ?? '');
    if ($value === null) return null;
    if ($type === 'group' && is_array($value)) {
        $result = [];
        foreach (is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [] as $child) {
            $name = (string) ($child['name'] ?? '');
            if ($name !== '' && array_key_exists($name, $value)) $result[$name] = zeroy_runtime_acf_comparable_value($child, $value[$name]);
        }
        return $result;
    }
    if (in_array($type, ['repeater', 'flexible_content'], true) && is_array($value)) {
        $layouts = [];
        foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) {
            if (is_string($layout['name'] ?? null)) $layouts[$layout['name']] = is_array($layout['sub_fields'] ?? null) ? $layout['sub_fields'] : [];
        }
        $default_children = is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];
        return array_map(static function (mixed $row) use ($type, $layouts, $default_children): mixed {
            if (!is_array($row)) return $row;
            $children = $type === 'flexible_content' ? ($layouts[(string) ($row['acf_fc_layout'] ?? '')] ?? []) : $default_children;
            $result = [];
            if ($type === 'flexible_content' && is_string($row['acf_fc_layout'] ?? null)) $result['acf_fc_layout'] = $row['acf_fc_layout'];
            foreach ($children as $child) {
                $name = (string) ($child['name'] ?? '');
                if ($name !== '' && array_key_exists($name, $row)) $result[$name] = zeroy_runtime_acf_comparable_value($child, $row[$name]);
            }
            return $result;
        }, $value);
    }
    $reference = in_array($type, ['image', 'file', 'post_object', 'taxonomy'], true);
    $reference_list = in_array($type, ['gallery', 'relationship'], true) || ($reference && !empty($field['multiple']));
    if ($reference_list && is_array($value)) return array_map(static fn(mixed $item): mixed => is_numeric($item) ? (int) $item : $item, array_values($value));
    if ($reference && is_numeric($value)) return (int) $value;
    if (in_array($type, ['number', 'range'], true) && is_numeric($value)) return (float) $value;
    if ($type === 'true_false') return (bool) $value;
    return $value;
}

function zeroy_runtime_acf_values_equal(int $object_id, string $name, mixed $value): bool
{
    if (!function_exists('get_field')) return hash_equals(zeroy_runtime_hash(get_post_meta($object_id, $name, true)), zeroy_runtime_hash($value));
    $field = function_exists('acf_maybe_get_field') ? acf_maybe_get_field($name, $object_id, false) : get_field_object($name, $object_id, false, false);
    $observed = get_field($name, $object_id, false);
    if (!is_array($field)) return hash_equals(zeroy_runtime_hash($observed), zeroy_runtime_hash($value));
    return hash_equals(
        zeroy_runtime_hash(zeroy_runtime_acf_comparable_value($field, $observed)),
        zeroy_runtime_hash(zeroy_runtime_acf_comparable_value($field, $value)),
    );
}

function zeroy_runtime_write_canonical_acf_field(int $object_id, string $name, mixed $value): true|WP_Error
{
    if (zeroy_runtime_acf_values_equal($object_id, $name, $value)) return true;
    $written = function_exists('update_field')
        ? update_field($name, $value, $object_id)
        : update_post_meta($object_id, $name, $value);
    if ($written === false && !zeroy_runtime_acf_values_equal($object_id, $name, $value)) {
        return zeroy_runtime_error('zeroy_canonical_content_write_failed', "ACF field {$name} could not be updated.", 500, ['fieldId' => '/acf/' . $name]);
    }
    return true;
}

function zeroy_runtime_write_canonical_content(int $object_id, array $payload): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $payload) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) return $lease;
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) return $canonical;
        $expected = (int) ($payload['expectedRevision'] ?? -1);
        if ($canonical['revision'] !== $expected) {
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, ['currentRevision' => $canonical['revision']]);
        }
        $post = ['ID' => $object_id];
        foreach (['postTitle' => 'post_title', 'postContent' => 'post_content', 'postExcerpt' => 'post_excerpt'] as $input => $column) {
            if (array_key_exists($input, $payload)) {
                if (!is_string($payload[$input])) return zeroy_runtime_error('zeroy_canonical_content_invalid', "{$input} must be text.", 400);
                $post[$column] = $payload[$input];
            }
        }
        if (count($post) > 1 && is_wp_error(wp_update_post(wp_slash($post), true))) {
            return zeroy_runtime_error('zeroy_canonical_content_write_failed', 'WordPress post content could not be updated.', 500);
        }
        if (array_key_exists('acf', $payload)) {
            if (!zeroy_runtime_is_keyed_map($payload['acf'])) return zeroy_runtime_error('zeroy_canonical_content_invalid', 'acf must be a keyed object.', 400);
            foreach ($payload['acf'] as $name => $value) {
                if (!is_string($name) || $name === '') return zeroy_runtime_error('zeroy_canonical_content_invalid', 'ACF field names must be non-empty strings.', 400);
                $written = zeroy_runtime_write_canonical_acf_field($object_id, $name, $value);
                if (is_wp_error($written)) return $written;
            }
        }
        if (array_key_exists('route', $payload)) {
            if (!is_string($payload['route'])) return zeroy_runtime_error('zeroy_canonical_content_invalid', 'route must be text.', 400);
            $route = zeroy_runtime_normalize_route($payload['route']);
            if (is_wp_error($route)) return $route;
            update_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_ROUTE_META, $route);
        }
        $next_revision = $expected + 1;
        if (update_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, $next_revision, $expected) === false) {
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed while writing content.', 409);
        }
        return zeroy_runtime_canonical($object_id);
    });
}
