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

function zeroy_checkout_apply_materialization_plan(mixed $operations, array $schema): true|WP_Error
{
    if (!is_array($operations) || !array_is_list($operations)) return zeroy_runtime_error('zeroy_site_release_snapshot_invalid', 'SiteCommit materialization plan is invalid.', 409);
    $refs = [];
    $term_refs = [];
    foreach ($operations as $operation) {
        $kind = $operation['kind'] ?? null;
        $payload = $operation['payload'] ?? null;
        if (!is_string($kind) || !is_array($payload)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'Materialization operation is malformed.', 500);
        if ($kind === 'createTerm') {
            $result = wp_insert_term((string) ($payload['name'] ?? ''), (string) ($payload['taxonomy'] ?? ''), ['slug' => (string) ($payload['slug'] ?? ''), 'description' => (string) ($payload['description'] ?? '')]);
            if (!is_wp_error($result)) $term_refs[(string) $payload['taxonomy'] . ':' . (string) $payload['ref']] = (int) $result['term_id'];
        } elseif ($kind === 'updateTerm' || $kind === 'retireTerm') {
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
            $result = $kind === 'assignSchema'
                ? zeroy_runtime_assign_canonical_schema($object_id, $definition_id, $definition, (int) ($payload['expectedRevision'] ?? -1))
                : ($kind === 'writeTemplateContent'
                    ? zeroy_runtime_write_template_content($object_id, $definition, $payload['templateContent'] ?? null, (int) ($payload['expectedRevision'] ?? -1))
                    : zeroy_runtime_write_canonical_content($object_id, $payload));
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
        } else {
            $result = match ($kind) {
                'siteConfig' => is_array($payload['siteConfig'] ?? null) ? zeroy_runtime_write_site_config_locked((array) $payload['siteConfig'], (int) ($payload['expectedRevision'] ?? -1)) : zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'siteConfig operation requires siteConfig.', 500),
                'createCanonical' => is_array($schema['schemas'][$payload['schemaId'] ?? ''] ?? null) ? zeroy_runtime_create_canonical((string) ($payload['postType'] ?? ''), (string) ($payload['schemaId'] ?? ''), $schema['schemas'][$payload['schemaId']], (string) ($payload['route'] ?? ''), (string) ($payload['postTitle'] ?? ''), (string) ($payload['postContent'] ?? ''), (string) ($payload['postExcerpt'] ?? ''), is_array($payload['templateContent'] ?? null) ? $payload['templateContent'] : []) : zeroy_runtime_error('zeroy_schema_not_found', 'createCanonical references a missing schema.', 409),
                'adoptCanonical' => is_array($schema['schemas'][$payload['schemaId'] ?? ''] ?? null) ? zeroy_runtime_adopt_canonical((int) ($payload['postId'] ?? 0), (string) ($payload['schemaId'] ?? ''), $schema['schemas'][$payload['schemaId']], (string) ($payload['route'] ?? ''), (string) ($payload['expectedSourceHash'] ?? '')) : zeroy_runtime_error('zeroy_schema_not_found', 'adoptCanonical references a missing schema.', 409),
                default => zeroy_runtime_error('zeroy_site_commit_operation_invalid', "Unsupported materialization operation {$kind}.", 500),
            };
        }
        if (is_wp_error($result)) return $result;
        if ($kind === 'createCanonical') {
            $ref = $payload['ref'] ?? null;
            $object_id = is_array($result) ? ($result['objectId'] ?? null) : null;
            if (!is_string($ref) || !is_int($object_id)) return zeroy_runtime_error('zeroy_site_commit_operation_invalid', 'createCanonical result cannot bind its stable ref.', 500);
            $refs[$ref] = $object_id;
        }
    }
    return true;
}
