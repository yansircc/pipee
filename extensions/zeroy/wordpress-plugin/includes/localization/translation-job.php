<?php

defined('ABSPATH') || exit;

function zeroy_localization_subject_definition(array $subject, array $localizable_subject): array|WP_Error
{
    if ($subject['kind'] === 'post' && is_string($localizable_subject['schemaId'] ?? null)) {
        return zeroy_runtime_schema_definition($localizable_subject['schemaId']);
    }
    $schema = zeroy_runtime_theme_schema();
    $key = match ($subject['kind']) {
        'site-copy' => 'siteCopy',
        default => $subject['kind'],
    };
    $definition = is_array($schema) ? ($schema['localizationSubjects'][$key] ?? null) : null;
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_translation_subject_unsupported', 'This LocalizableSubject has no ThemeSchema localization definition.', 409);
}

function zeroy_localization_translation_job_token(array $payload): string
{
    $encoded = rtrim(strtr(base64_encode(zeroy_runtime_json($payload)), '+/', '-_'), '=');
    return 'zeroy1.' . $encoded . '.' . hash_hmac('sha256', $encoded, zeroy_runtime_connection_key());
}

function zeroy_localization_decode_job_token(string $token): array|WP_Error
{
    $parts = explode('.', $token);
    if (count($parts) !== 3 || $parts[0] !== 'zeroy1' || !hash_equals(hash_hmac('sha256', $parts[1], zeroy_runtime_connection_key()), $parts[2])) {
        return zeroy_runtime_error('zeroy_translation_job_token_invalid', 'TranslationJob token is invalid.', 409);
    }
    $json = base64_decode(strtr($parts[1], '-_', '+/'), true);
    $payload = is_string($json) ? zeroy_runtime_decode_json($json) : zeroy_runtime_error('zeroy_translation_job_token_invalid', 'TranslationJob token is invalid.', 409);
    if (is_wp_error($payload) || !is_array($payload['subject'] ?? null) || !is_string($payload['locale'] ?? null)) {
        return zeroy_runtime_error('zeroy_translation_job_token_invalid', 'TranslationJob token is invalid.', 409);
    }
    return $payload;
}

function zeroy_localization_post_route(array $subject, array $definition): string|WP_Error
{
    $canonical = zeroy_runtime_canonical((int) $subject['id']);
    return is_wp_error($canonical)
        ? $canonical
        : (is_string($canonical['route'] ?? null) ? $canonical['route'] : zeroy_runtime_error('zeroy_translation_route_missing', 'Canonical post needs an explicit zeroY route.', 409));
}

function zeroy_localization_subject_route(array $subject, array $definition): string|WP_Error
{
    return $subject['kind'] === 'post' ? zeroy_localization_post_route($subject, $definition) : '';
}

function zeroy_localization_translation_status(array $field, array $overlay): array
{
    $stored = $overlay['values'][$field['fieldId']] ?? null;
    if (
        !is_array($stored)
        || !array_key_exists('value', $stored)
        || !is_string($stored['sourceHash'] ?? null)
        || (($field['policy']['required'] ?? false) === true && !zeroy_localization_value_is_present($stored['value']))
    ) {
        return ['status' => 'missing'];
    }
    if (hash_equals($field['sourceHash'], $stored['sourceHash'])) {
        return ['status' => 'current', 'value' => $stored['value']];
    }
    return [
        'status' => $field['policy']['mode'] === 'translated' ? 'stale' : 'review-needed',
        'value' => $stored['value'],
    ];
}

function zeroy_localization_translation_job(array $subject, string $locale, ?array $definition_override = null): array|WP_Error
{
    $subject = zeroy_localization_subject_ref($subject);
    if (is_wp_error($subject)) {
        return $subject;
    }
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 404);
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return $config;
    }
    if ($locale === $config['defaultLocale']) {
        return zeroy_runtime_error('zeroy_translation_default_locale', 'The default locale resolves directly from canonical WordPress and ACF facts; it has no TranslationJob.', 409);
    }
    $localizable = $subject['kind'] === 'post' && is_array($definition_override)
        ? zeroy_localization_post_subject((int) $subject['id'], $definition_override)
        : zeroy_localization_subject($subject);
    if (is_wp_error($localizable)) {
        return $localizable;
    }
    $definition = $definition_override ?? zeroy_localization_subject_definition($subject, $localizable);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    if (is_wp_error($compiled)) {
        return $compiled;
    }
    $head = zeroy_localization_overlay_head($subject, $locale);
    $overlay = zeroy_localization_overlay_for_head(
        $head,
        $head !== null && $head['draft_version_id'] !== null ? 'draft_version_id' : 'published_version_id',
        $subject,
        $locale,
        $compiled['policy']['hash']
    );
    if (is_wp_error($overlay)) {
        return $overlay;
    }
    $profile = zeroy_localization_translation_profile_projection($locale);
    if (is_wp_error($profile)) {
        return $profile;
    }
    $fields = [];
    $context = [];
    $summary = ['missing' => 0, 'stale' => 0, 'reviewNeeded' => 0, 'current' => 0, 'shared' => 0, 'derived' => 0];
    foreach ($compiled['fields'] as $field) {
        $policy = $field['policy'];
        if (in_array($policy['mode'], ['shared', 'derived'], true)) {
            $summary[$policy['mode']]++;
            if ($policy['contextWeight'] !== 'hidden') {
                $context[] = ['fieldId' => $field['fieldId'], 'label' => $field['label'], 'value' => $field['value']];
            }
            continue;
        }
        $state = zeroy_localization_translation_status($field, $overlay);
        $summary[match ($state['status']) {
            'review-needed' => 'reviewNeeded',
            default => $state['status'],
        }]++;
        $fields[] = [
            'fieldId' => $field['fieldId'],
            'label' => $field['label'],
            'mode' => $policy['mode'],
            'sourceValue' => $field['value'],
            'sourceHash' => $field['sourceHash'],
            'required' => $policy['required'],
            'status' => $state['status'],
            ...(array_key_exists('value', $state) ? ['currentValue' => $state['value']] : []),
            ...(isset($field['context']) ? ['context' => $field['context']] : []),
        ];
    }
    $revision = $head === null ? 0 : (int) $head['revision'];
    $token_payload = [
        'contract' => 'zeroy/translation-job-token@1',
        'subject' => $subject,
        'locale' => $locale,
        'canonicalRevision' => $localizable['canonicalRevision'],
        'policyHash' => $compiled['policy']['hash'],
        'localeRevision' => $revision,
        'fieldsHash' => zeroy_runtime_hash(array_map(static fn(array $field): array => [
            'fieldId' => $field['fieldId'],
            'sourceHash' => $field['sourceHash'],
            'status' => $field['status'],
        ], $fields)),
    ];
    return [
        'contract' => 'zeroy/translation-job@1',
        'subject' => $subject,
        'locale' => $locale,
        'policyHash' => $compiled['policy']['hash'],
        'jobToken' => zeroy_localization_translation_job_token($token_payload),
        'expectedRevision' => $revision,
        'profile' => $profile,
        'fields' => $fields,
        'contextFacts' => $context,
        'summary' => $summary,
        'previewUrl' => $head !== null && $head['draft_version_id'] !== null
            ? zeroy_localization_preview_url($subject, $locale, (int) $head['draft_version_id'])
            : null,
    ];
}

function zeroy_localization_write_translation_draft(string $job_token, mixed $values, int $expected_revision, ?array $definition_override = null): array|WP_Error
{
    if (!zeroy_runtime_is_keyed_map($values)) {
        return zeroy_runtime_error('zeroy_translation_values_invalid', 'values must be a keyed object of fieldId to value.', 400);
    }
    $payload = zeroy_localization_decode_job_token($job_token);
    if (is_wp_error($payload)) {
        return $payload;
    }
    $job = zeroy_localization_translation_job($payload['subject'], $payload['locale'], $definition_override);
    if (is_wp_error($job)) {
        return $job;
    }
    if (!hash_equals($job['jobToken'], $job_token)) {
        return zeroy_runtime_error('zeroy_translation_job_stale', 'Canonical facts, policy, or locale revision changed. Refresh TranslationJob before writing.', 409);
    }
    if ($job['expectedRevision'] !== $expected_revision) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'TranslationJob revision changed after it was read.', 409, ['currentRevision' => $job['expectedRevision']]);
    }
    $field_map = [];
    foreach ($job['fields'] as $field) {
        $field_map[$field['fieldId']] = $field;
    }
    $subject = $job['subject'];
    $head = zeroy_localization_overlay_head($subject, $job['locale']);
    $overlay = zeroy_localization_overlay_for_head(
        $head,
        $head !== null && $head['draft_version_id'] !== null ? 'draft_version_id' : 'published_version_id',
        $subject,
        $job['locale'],
        $job['policyHash']
    );
    if (is_wp_error($overlay)) {
        return $overlay;
    }
    foreach ($values as $field_id => $value) {
        $field = is_string($field_id) ? ($field_map[$field_id] ?? null) : null;
        if (!is_array($field)) {
            return zeroy_runtime_error('zeroy_translation_field_invalid', "{$field_id} is not writable by this TranslationJob.", 409, ['fieldId' => $field_id]);
        }
        if ($value === null) {
            if ($field['mode'] !== 'overridable') {
                return zeroy_runtime_error('zeroy_translation_value_invalid', "{$field_id} is translated and cannot be removed.", 409, ['fieldId' => $field_id]);
            }
            unset($overlay['values'][$field_id]);
            continue;
        }
        $overlay['values'][$field_id] = ['sourceHash' => $field['sourceHash'], 'value' => $value];
    }
    $overlay['createdAt'] = current_time('mysql', true);
    $localizable = $subject['kind'] === 'post' && is_array($definition_override)
        ? zeroy_localization_post_subject((int) $subject['id'], $definition_override)
        : zeroy_localization_subject($subject);
    $definition = is_wp_error($localizable) ? $localizable : ($definition_override ?? zeroy_localization_subject_definition($subject, $localizable));
    if (is_wp_error($definition)) {
        return $definition;
    }
    $route = zeroy_localization_subject_route($subject, $definition);
    if (is_wp_error($route)) {
        return $route;
    }
    $stored = zeroy_localization_store_draft($subject, $job['locale'], (string) ($localizable['schemaId'] ?? ''), $route, $overlay, $expected_revision);
    if (is_wp_error($stored)) {
        return $stored;
    }
    $next = zeroy_localization_translation_job($subject, $job['locale'], $definition_override);
    if (is_wp_error($next)) {
        return $next;
    }
    return [
        'contract' => 'zeroy/translation-receipt@1',
        'subject' => $subject,
        'locale' => $job['locale'],
        'state' => 'draft',
        'revision' => (int) $stored['revision'],
        'summary' => $next['summary'],
        'previewUrl' => $next['previewUrl'],
    ];
}

function zeroy_localization_write_translation_values(array $subject, string $locale, array $definition, mixed $values, int $expected_revision): array|WP_Error
{
    $job = zeroy_localization_translation_job($subject, $locale, $definition);
    return is_wp_error($job)
        ? $job
        : zeroy_localization_write_translation_draft((string) $job['jobToken'], $values, $expected_revision, $definition);
}

function zeroy_localization_publish_translation(array $subject, string $locale, array $definition, int $expected_revision): array|WP_Error
{
    $job = zeroy_localization_translation_job($subject, $locale, $definition);
    if (is_wp_error($job)) {
        return $job;
    }
    $violations = [];
    foreach ($job['fields'] as $field) {
        if ($field['status'] === 'stale' || $field['status'] === 'review-needed' || ($field['required'] && $field['status'] === 'missing')) {
            $violations[] = ['fieldId' => $field['fieldId'], 'status' => $field['status'], 'required' => $field['required']];
        }
    }
    if ($violations !== []) {
        return zeroy_runtime_error('zeroy_translation_not_publishable', 'Translation has missing required fields or needs source review.', 409, ['violations' => $violations]);
    }
    $result = zeroy_localization_publish_draft($job['subject'], $locale, $expected_revision);
    if (is_wp_error($result)) {
        return $result;
    }
    if ($job['subject']['kind'] === 'post') {
        $post = get_post((int) $job['subject']['id']);
        if ($post instanceof WP_Post && $post->post_status !== 'publish') {
            wp_update_post(['ID' => $post->ID, 'post_status' => 'publish']);
        }
    }
    return [
        'contract' => 'zeroy/translation-receipt@1',
        'subject' => $job['subject'],
        'locale' => $locale,
        'state' => 'published',
        'revision' => (int) $result['revision'],
        'summary' => $job['summary'],
        'url' => $job['subject']['kind'] === 'post'
            ? zeroy_runtime_route_url($locale, (string) $result['route_path'])
            : null,
    ];
}

function zeroy_localization_unpublish_translation(array $subject, string $locale, array $definition, int $expected_revision): array|WP_Error
{
    $job = zeroy_localization_translation_job($subject, $locale, $definition);
    if (is_wp_error($job)) {
        return $job;
    }
    $result = zeroy_localization_unpublish($job['subject'], $locale, $expected_revision);
    if (is_wp_error($result)) {
        return $result;
    }
    return [
        'contract' => 'zeroy/translation-receipt@1',
        'subject' => $job['subject'],
        'locale' => $locale,
        'state' => 'unpublished',
        'revision' => (int) $result['revision'],
        'summary' => $job['summary'],
    ];
}
