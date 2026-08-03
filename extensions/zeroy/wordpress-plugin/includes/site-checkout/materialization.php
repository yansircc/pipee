<?php

defined('ABSPATH') || exit;

function zeroy_checkout_materialization_subject(array $subject, array $refs, array $term_refs): array|WP_Error
{
    if (($subject['kind'] ?? null) === 'post' && is_string($subject['ref'] ?? null)) {
        $ref = $subject['ref'];
        if (!isset($refs[$ref])) return zeroy_runtime_error('zeroy_site_commit_ref_missing', "Unknown SiteCommit canonical ref {$ref}.", 409, ['ref' => $ref]);
        $subject['id'] = $refs[$ref];
        unset($subject['ref']);
    }
    if (($subject['kind'] ?? null) === 'term' && is_string($subject['ref'] ?? null)) {
        $key = (string) ($subject['taxonomy'] ?? '') . ':' . $subject['ref'];
        if (!isset($term_refs[$key])) return zeroy_runtime_error('zeroy_site_commit_ref_missing', "Unknown SiteCommit term ref {$subject['ref']}.", 409, ['ref' => $subject['ref']]);
        $subject['id'] = $term_refs[$key];
        unset($subject['ref']);
    }
    return $subject;
}

function zeroy_checkout_materialization_subject_definition(array $schema, array $subject): array|WP_Error
{
    if (($subject['kind'] ?? null) === 'post' && is_int($subject['id'] ?? null)) {
        $canonical = zeroy_runtime_canonical($subject['id']);
        if (is_wp_error($canonical)) return $canonical;
        $definition = $schema['schemas'][$canonical['schemaId']] ?? null;
    } else {
        $key = ($subject['kind'] ?? null) === 'site-copy' ? 'siteCopy' : ($subject['kind'] ?? null);
        $definition = is_string($key) ? ($schema['localizationSubjects'][$key] ?? null) : null;
    }
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_localization_definition_missing', 'SiteCommit materialization cannot resolve the LocalizableSubject definition.', 409, ['subject' => $subject]);
}

function zeroy_checkout_materialization_ref_id(mixed $ref, array $refs): int|WP_Error
{
    if (is_int($ref) && $ref > 0) return $ref;
    if (is_string($ref) && isset($refs[$ref])) return (int) $refs[$ref];
    return zeroy_runtime_error('zeroy_site_commit_ref_missing', 'A SiteCommit canonical ref is missing or invalid.', 409, ['ref' => $ref]);
}

function zeroy_checkout_materialization_reference_maps(): array
{
    $posts = [];
    foreach (get_posts(['post_type' => 'any', 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids', 'meta_key' => '_zeroy_authored_ref']) as $post_id) {
        $ref = get_post_meta((int) $post_id, '_zeroy_authored_ref', true);
        if (is_string($ref) && $ref !== '') $posts[$ref] = (int) $post_id;
    }
    $terms = [];
    $term_rows = get_terms(['taxonomy' => get_taxonomies([], 'names'), 'hide_empty' => false, 'meta_key' => '_zeroy_authored_ref']);
    foreach (is_array($term_rows) ? $term_rows : [] as $term) {
        if (!$term instanceof WP_Term) continue;
        $ref = get_term_meta($term->term_id, '_zeroy_authored_ref', true);
        if (is_string($ref) && $ref !== '') $terms[$term->taxonomy . ':' . $ref] = $term->term_id;
    }
    $media = [];
    foreach (get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'posts_per_page' => -1, 'fields' => 'ids', 'meta_key' => '_zeroy_authored_media_ref']) as $attachment_id) {
        $ref = get_post_meta((int) $attachment_id, '_zeroy_authored_media_ref', true);
        if (is_string($ref) && $ref !== '') $media[$ref] = (int) $attachment_id;
    }
    return ['posts' => $posts, 'terms' => $terms, 'media' => $media];
}

function zeroy_checkout_materialization_media(array $payload): array|WP_Error
{
    $ref = $payload['ref'] ?? null;
    $hash = $payload['hash'] ?? null;
    if (!is_string($ref) || $ref === '' || !is_string($hash) || preg_match('/\Asha256:[a-f0-9]{64}\z/', $hash) !== 1) {
        return zeroy_runtime_error('zeroy_site_media_invalid', 'Authored media operation is invalid.', 500);
    }
    $existing = get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'posts_per_page' => 1, 'fields' => 'ids', 'meta_key' => '_zeroy_authored_media_ref', 'meta_value' => $ref]);
    if (isset($existing[0]) && hash_equals((string) get_post_meta((int) $existing[0], '_zeroy_authored_media_hash', true), $hash)) {
        return ['ref' => $ref, 'attachmentId' => (int) $existing[0]];
    }
    $blob = zeroy_checkout_object_row($hash);
    $bytes = is_array($blob) && ($blob['object_type'] ?? null) === 'blob' ? (string) $blob['object_bytes'] : null;
    if (!is_string($bytes) || zeroy_checkout_blob_hash($bytes) !== $hash) return zeroy_runtime_error('zeroy_site_media_hash_mismatch', 'Authored media blob is missing or does not match its immutable identity.', 409, ['ref' => $ref]);
    $filename = basename($ref);
    $uploaded = wp_upload_bits($filename, null, $bytes);
    if (!empty($uploaded['error'])) return zeroy_runtime_error('zeroy_site_media_write_failed', (string) $uploaded['error'], 500, ['ref' => $ref]);
    $type = wp_check_filetype($filename);
    $attachment_id = wp_insert_attachment([
        'post_mime_type' => is_string($type['type'] ?? null) && $type['type'] !== '' ? $type['type'] : 'application/octet-stream',
        'post_title' => pathinfo($filename, PATHINFO_FILENAME),
        'post_status' => 'inherit',
    ], (string) $uploaded['file']);
    if (is_wp_error($attachment_id)) return $attachment_id;
    update_post_meta($attachment_id, '_zeroy_authored_media_ref', $ref);
    update_post_meta($attachment_id, '_zeroy_authored_media_hash', $hash);
    if (str_starts_with((string) ($type['type'] ?? ''), 'image/')) {
        require_once ABSPATH . 'wp-admin/includes/image.php';
        wp_update_attachment_metadata($attachment_id, wp_generate_attachment_metadata($attachment_id, (string) $uploaded['file']));
    }
    return ['ref' => $ref, 'attachmentId' => $attachment_id];
}

function zeroy_checkout_materialization_adopt_media(array $payload): array|WP_Error
{
    $attachment_id = (int) ($payload['attachmentId'] ?? 0);
    $ref = $payload['ref'] ?? null;
    $expected = $payload['expectedSourceHash'] ?? null;
    $attachment = get_post($attachment_id);
    if (!$attachment instanceof WP_Post || $attachment->post_type !== 'attachment' || !is_string($ref) || !is_string($expected)) {
        return zeroy_runtime_error('zeroy_site_media_adoption_invalid', 'Authored media adoption operation is invalid.', 500);
    }
    $bytes = zeroy_adoption_media_bytes($attachment);
    if (is_wp_error($bytes)) return $bytes;
    $actual = zeroy_checkout_blob_hash($bytes);
    if (!hash_equals($expected, $actual)) return zeroy_runtime_error('zeroy_media_source_conflict', 'WordPress attachment changed after checkout.', 409, ['attachmentId' => $attachment_id]);
    update_post_meta($attachment_id, '_zeroy_authored_media_ref', $ref);
    update_post_meta($attachment_id, '_zeroy_authored_media_hash', $actual);
    return ['ref' => $ref, 'attachmentId' => $attachment_id];
}

function zeroy_checkout_materialization_reference(mixed $value, string $kind, array $refs, array $term_refs, array $media_refs): int|null|WP_Error
{
    if ($value === null) return null;
    if (!is_array($value) || ($value['kind'] ?? null) !== $kind || !is_string($value['ref'] ?? null)) return zeroy_runtime_error('zeroy_site_commit_ref_invalid', 'ACF value is not a typed stable reference.', 409, ['reference' => $value, 'kind' => $kind]);
    $key = $kind === 'term' ? (string) ($value['taxonomy'] ?? '') . ':' . $value['ref'] : $value['ref'];
    $map = $kind === 'post' ? $refs : ($kind === 'term' ? $term_refs : $media_refs);
    return isset($map[$key]) ? (int) $map[$key] : zeroy_runtime_error('zeroy_site_commit_ref_missing', "Unknown authored {$kind} ref {$key}.", 409, ['ref' => $key]);
}

function zeroy_checkout_materialization_acf_field(array $field, mixed $value, array $refs, array $term_refs, array $media_refs): mixed
{
    $type = (string) ($field['type'] ?? '');
    if ($type === 'group' && is_array($value)) {
        $result = $value;
        foreach (zeroy_document_acf_children($field, $value) as $child) {
            $name = (string) ($child['name'] ?? '');
            if ($name !== '' && array_key_exists($name, $result)) $result[$name] = zeroy_checkout_materialization_acf_field($child, $result[$name], $refs, $term_refs, $media_refs);
            if (is_wp_error($result[$name] ?? null)) return $result[$name];
        }
        return $result;
    }
    if (in_array($type, ['repeater', 'flexible_content'], true) && is_array($value)) {
        $rows = [];
        foreach ($value as $row) {
            if (!is_array($row)) return zeroy_runtime_error('zeroy_site_commit_acf_invalid', 'ACF collection row is invalid.', 409);
            $decoded = $row;
            foreach (zeroy_document_acf_children($field, $row) as $child) {
                $name = (string) ($child['name'] ?? '');
                if ($name !== '' && array_key_exists($name, $decoded)) $decoded[$name] = zeroy_checkout_materialization_acf_field($child, $decoded[$name], $refs, $term_refs, $media_refs);
                if (is_wp_error($decoded[$name] ?? null)) return $decoded[$name];
            }
            $rows[] = $decoded;
        }
        return $rows;
    }
    $kind = match ($type) {
        'image', 'file', 'gallery' => 'media',
        'post_object', 'relationship' => 'post',
        'taxonomy' => 'term',
        default => null,
    };
    if ($kind === null) return $value;
    $multiple = in_array($type, ['gallery', 'relationship'], true) || !empty($field['multiple']) || ($type === 'taxonomy' && !empty($field['add_term']));
    if (!$multiple) return zeroy_checkout_materialization_reference($value, $kind, $refs, $term_refs, $media_refs);
    if (!is_array($value) || !array_is_list($value)) return zeroy_runtime_error('zeroy_site_commit_ref_invalid', 'Multi-value ACF reference must be a list.', 409);
    $result = [];
    foreach ($value as $reference) {
        $id = zeroy_checkout_materialization_reference($reference, $kind, $refs, $term_refs, $media_refs);
        if (is_wp_error($id)) return $id;
        $result[] = $id;
    }
    return $result;
}

function zeroy_checkout_materialization_acf(string $post_type, array $acf, array $refs, array $term_refs, array $media_refs): array|WP_Error
{
    $fields = zeroy_document_acf_fields($post_type);
    $by_name = [];
    foreach ($fields as $field) if (is_string($field['name'] ?? null) && $field['name'] !== '') $by_name[$field['name']] = $field;
    $result = $acf;
    foreach ($result as $name => $value) {
        if (!isset($by_name[$name])) return zeroy_runtime_error('zeroy_site_commit_acf_invalid', 'Materialization cannot resolve an ACF field definition.', 409, ['field' => $name]);
        $result[$name] = zeroy_checkout_materialization_acf_field($by_name[$name], $value, $refs, $term_refs, $media_refs);
        if (is_wp_error($result[$name])) return $result[$name];
    }
    return $result;
}

function zeroy_checkout_apply_materialization_plan(mixed $operations, array $schema): true|WP_Error
{
    if (!is_array($operations) || !array_is_list($operations)) return zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteCommit materialization plan is invalid.', 409);
    $maps = zeroy_checkout_materialization_reference_maps();
    $refs = $maps['posts'];
    $term_refs = $maps['terms'];
    $media_refs = $maps['media'];
    $prepared = [];
    foreach ($operations as $index => $operation) {
        $kind = $operation['kind'] ?? null;
        $payload = $operation['payload'] ?? null;
        if (!is_string($kind) || !is_array($payload)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'Materialization operation is malformed.', 500);
        if ($kind === 'siteConfig') {
            $result = is_array($payload['siteConfig'] ?? null) ? zeroy_runtime_write_site_config_locked((array) $payload['siteConfig'], (int) ($payload['expectedRevision'] ?? -1)) : zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'siteConfig operation requires siteConfig.', 500);
        } elseif ($kind === 'upsertMedia') {
            $result = zeroy_checkout_materialization_media($payload);
            if (!is_wp_error($result)) $media_refs[(string) $result['ref']] = (int) $result['attachmentId'];
        } elseif ($kind === 'adoptMedia') {
            $result = zeroy_checkout_materialization_adopt_media($payload);
            if (!is_wp_error($result)) $media_refs[(string) $result['ref']] = (int) $result['attachmentId'];
        } elseif ($kind === 'createTerm') {
            $result = wp_insert_term((string) ($payload['name'] ?? ''), (string) ($payload['taxonomy'] ?? ''), ['slug' => (string) ($payload['slug'] ?? ''), 'description' => (string) ($payload['description'] ?? '')]);
            if (!is_wp_error($result)) {
                $term_id = (int) $result['term_id'];
                $term_refs[(string) $payload['taxonomy'] . ':' . (string) $payload['ref']] = $term_id;
                update_term_meta($term_id, '_zeroy_authored_ref', (string) $payload['ref']);
            }
        } elseif ($kind === 'adoptTerm') {
            $term_id = (int) ($payload['termId'] ?? 0);
            $taxonomy = (string) ($payload['taxonomy'] ?? '');
            $current = zeroy_localization_term_subject($taxonomy, $term_id);
            if (is_wp_error($current)) return $current;
            if (!hash_equals((string) $current['canonicalRevision'], (string) ($payload['expectedSourceHash'] ?? ''))) return zeroy_runtime_error('zeroy_term_source_conflict', 'Taxonomy term changed after checkout.', 409, ['termId' => $term_id, 'taxonomy' => $taxonomy]);
            $result = wp_update_term($term_id, $taxonomy, ['name' => (string) ($payload['name'] ?? ''), 'slug' => (string) ($payload['slug'] ?? ''), 'description' => (string) ($payload['description'] ?? '')]);
            if (!is_wp_error($result)) {
                $term_refs[$taxonomy . ':' . (string) $payload['ref']] = $term_id;
                update_term_meta($term_id, '_zeroy_authored_ref', (string) $payload['ref']);
            }
        } elseif ($kind === 'adoptCanonical') {
            $definition = $schema['schemas'][$payload['schemaId'] ?? ''] ?? null;
            $result = is_array($definition)
                ? zeroy_runtime_adopt_canonical((int) ($payload['postId'] ?? 0), (string) ($payload['schemaId'] ?? ''), $definition, (string) ($payload['route'] ?? ''), (string) ($payload['expectedSourceHash'] ?? ''))
                : zeroy_runtime_error('zeroy_schema_not_found', 'adoptCanonical references a missing schema.', 409);
            if (!is_wp_error($result)) {
                $object_id = is_array($result) ? ($result['objectId'] ?? null) : null;
                if (!is_int($object_id) || !is_string($payload['ref'] ?? null)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'adoptCanonical result cannot bind its stable ref.', 500);
                $refs[$payload['ref']] = $object_id;
                update_post_meta($object_id, '_zeroy_authored_ref', $payload['ref']);
            }
        } elseif ($kind === 'createCanonical') {
            $definition = $schema['schemas'][$payload['schemaId'] ?? ''] ?? null;
            $result = is_array($definition) ? zeroy_runtime_create_canonical((string) ($payload['postType'] ?? ''), (string) ($payload['schemaId'] ?? ''), $definition, (string) ($payload['route'] ?? ''), (string) ($payload['postTitle'] ?? ''), (string) ($payload['postContent'] ?? ''), (string) ($payload['postExcerpt'] ?? ''), is_array($payload['templateContent'] ?? null) ? $payload['templateContent'] : []) : zeroy_runtime_error('zeroy_schema_not_found', 'createCanonical references a missing schema.', 409);
            if (!is_wp_error($result)) {
                $object_id = is_array($result) ? ($result['objectId'] ?? null) : null;
                if (!is_int($object_id) || !is_string($payload['ref'] ?? null)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'createCanonical result cannot bind its stable ref.', 500);
                $refs[$payload['ref']] = $object_id;
                update_post_meta($object_id, '_zeroy_authored_ref', $payload['ref']);
            }
        } else continue;
        if (is_wp_error($result)) return $result;
        $prepared[$index] = true;
    }
    foreach ($operations as $index => $operation) {
        if (isset($prepared[$index])) continue;
        $kind = $operation['kind'] ?? null;
        $payload = $operation['payload'] ?? null;
        if (!is_string($kind) || !is_array($payload)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'Materialization operation is malformed.', 500);
        if ($kind === 'updateTerm' || $kind === 'retireTerm') {
            $current = zeroy_localization_term_subject((string) ($payload['taxonomy'] ?? ''), (int) ($payload['termId'] ?? 0));
            if (is_wp_error($current)) return $current;
            if (!hash_equals((string) $current['canonicalRevision'], (string) ($payload['expectedSourceHash'] ?? ''))) return zeroy_runtime_error('zeroy_term_source_conflict', 'Taxonomy term changed after checkout.', 409, ['termId' => $payload['termId'] ?? null]);
            $result = $kind === 'updateTerm'
                ? wp_update_term((int) $payload['termId'], (string) $payload['taxonomy'], ['name' => (string) $payload['name'], 'slug' => (string) $payload['slug'], 'description' => (string) ($payload['description'] ?? '')])
                : wp_delete_term((int) $payload['termId'], (string) $payload['taxonomy']);
            if ($result === false) return zeroy_runtime_error('zeroy_term_retire_failed', 'Taxonomy term could not be retired.', 500, ['termId' => $payload['termId'] ?? null, 'taxonomy' => $payload['taxonomy'] ?? null]);
        } elseif ($kind === 'assignTerms') {
            $object_id = zeroy_checkout_materialization_ref_id($payload['objectRef'] ?? null, $refs);
            if (is_wp_error($object_id)) return $object_id;
            $result = true;
            foreach (is_array($payload['terms'] ?? null) ? $payload['terms'] : [] as $taxonomy => $slugs) {
                $assigned = wp_set_object_terms($object_id, is_array($slugs) ? $slugs : [], (string) $taxonomy, false);
                if (is_wp_error($assigned)) return $assigned;
            }
        } elseif ($kind === 'retireCanonical') {
            $result = zeroy_runtime_retire_canonical((int) ($payload['objectId'] ?? 0), (int) ($payload['expectedRevision'] ?? -1));
        } elseif ($kind === 'assignSchema' || $kind === 'writeTemplateContent' || $kind === 'writeCanonicalContent') {
            $object_id = zeroy_checkout_materialization_ref_id($payload['objectRef'] ?? null, $refs);
            if (is_wp_error($object_id)) return $object_id;
            $canonical = zeroy_runtime_canonical($object_id);
            if (is_wp_error($canonical)) return $canonical;
            $definition_id = $kind === 'assignSchema' ? (string) ($payload['schemaId'] ?? '') : (string) $canonical['schemaId'];
            $definition = $schema['schemas'][$definition_id] ?? null;
            if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'SiteCommit materialization references a missing schema.', 409, ['schemaId' => $definition_id]);
            $resolved_payload = $payload;
            if ($kind === 'writeCanonicalContent' && is_array($payload['acf'] ?? null)) {
                $resolved_acf = zeroy_checkout_materialization_acf($canonical['post']->post_type, $payload['acf'], $refs, $term_refs, $media_refs);
                if (is_wp_error($resolved_acf)) return $resolved_acf;
                $resolved_payload['acf'] = $resolved_acf;
            }
            $result = $kind === 'assignSchema'
                ? zeroy_runtime_assign_canonical_schema($object_id, $definition_id, $definition, (int) ($payload['expectedRevision'] ?? -1))
                : ($kind === 'writeTemplateContent'
                    ? zeroy_runtime_write_template_content($object_id, $definition, $payload['templateContent'] ?? null, (int) ($payload['expectedRevision'] ?? -1))
                    : zeroy_runtime_write_canonical_content($object_id, $resolved_payload));
        } elseif ($kind === 'writeTranslationDraft' || $kind === 'publishTranslation' || $kind === 'unpublishTranslation') {
            if (!is_array($payload['subject'] ?? null)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'Translation subject must be an object.', 500);
            $subject = zeroy_checkout_materialization_subject($payload['subject'], $refs, $term_refs);
            if (is_wp_error($subject)) return $subject;
            $definition = zeroy_checkout_materialization_subject_definition($schema, $subject);
            if (is_wp_error($definition)) return $definition;
            $result = match ($kind) {
                'writeTranslationDraft' => zeroy_localization_write_translation_values($subject, (string) ($payload['locale'] ?? ''), $definition, $payload['values'] ?? null, (int) ($payload['expectedRevision'] ?? -1)),
                'publishTranslation' => zeroy_localization_publish_translation($subject, (string) ($payload['locale'] ?? ''), $definition, (int) ($payload['expectedRevision'] ?? -1)),
                default => zeroy_localization_unpublish_translation($subject, (string) ($payload['locale'] ?? ''), $definition, (int) ($payload['expectedRevision'] ?? -1)),
            };
        } else $result = zeroy_runtime_error('zeroy_site_commit_operation_invalid', "Unsupported materialization operation {$kind}.", 500);
        if (is_wp_error($result)) return $result;
    }
    return true;
}
