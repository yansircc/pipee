<?php

defined('ABSPATH') || exit;

function zeroy_localization_resolve(array $subject, string $locale, string $pointer = 'published_version_id'): array|WP_Error
{
    if (!in_array($pointer, ['draft_version_id', 'published_version_id'], true)) {
        return zeroy_runtime_error('zeroy_localization_pointer_invalid', 'LocaleOverlay pointer is invalid.', 500);
    }
    $subject = zeroy_localization_subject_ref($subject);
    if (is_wp_error($subject)) {
        return $subject;
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config) || !zeroy_runtime_locale_is_enabled($locale)) {
        return is_wp_error($config) ? $config : zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 404);
    }
    $localizable = zeroy_localization_subject($subject);
    if (is_wp_error($localizable)) {
        return $localizable;
    }
    $definition = zeroy_localization_subject_definition($subject, $localizable);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    if (is_wp_error($compiled)) {
        return $compiled;
    }
    $head = null;
    $overlay = zeroy_localization_empty_overlay($subject, $locale, $compiled['policy']['hash']);
    if ($locale !== $config['defaultLocale']) {
        $head = zeroy_localization_overlay_head($subject, $locale);
        if ($head === null || $head[$pointer] === null) {
            return zeroy_runtime_error('zeroy_locale_not_published', 'LocaleOverlay is not published for this subject.', 404);
        }
        $overlay = zeroy_localization_overlay_for_head($head, $pointer, $subject, $locale, $compiled['policy']['hash']);
        // Candidate preview never writes LocaleHead state. It projects the
        // same deterministic reconciliation activation will commit, so a
        // preview observes one candidate Artifact plus matching Overlay facts.
        if (is_wp_error($overlay) && $overlay->get_error_code() === 'zeroy_localization_policy_changed' && zeroy_runtime_request_is_candidate_site_release()) {
            $overlay = zeroy_localization_candidate_overlay_for_head($head, $pointer, $subject, $locale, $compiled);
        }
        if (is_wp_error($overlay)) {
            return $overlay;
        }
    }
    $view = $localizable['view'];
    foreach ($overlay['values'] as $field_id => $stored) {
        $field = $compiled['fields'][$field_id] ?? null;
        if (!is_array($field) || !is_array($stored) || !array_key_exists('value', $stored) || !is_string($stored['sourceHash'] ?? null)) {
            return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay contains an unknown or malformed field.', 409, ['fieldId' => $field_id]);
        }
        if (!in_array($field['policy']['mode'], ['translated', 'overridable'], true)) {
            return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay attempts to own a shared or derived canonical fact.', 409, ['fieldId' => $field_id]);
        }
        zeroy_localization_set_view_value($view, $field['viewPath'], $stored['value']);
    }
    if ($subject['kind'] === 'menu') {
        $view = zeroy_localization_menu_resolved_view($view, $locale);
    }
    return [
        'contract' => 'zeroy/locale-resolved@1',
        'subject' => $subject,
        'locale' => $locale,
        'schemaId' => $localizable['schemaId'],
        'canonicalRevision' => $localizable['canonicalRevision'],
        'overlayVersionId' => $head === null || $head[$pointer] === null ? null : (int) $head[$pointer],
        'revision' => $head === null ? 0 : (int) $head['revision'],
        ...$view,
    ];
}

function zeroy_localization_post_content(int $post_id, string $locale, string $schema_id, string $pointer = 'published_version_id'): array|WP_Error
{
    $resolved = zeroy_localization_resolve(['kind' => 'post', 'id' => $post_id], $locale, $pointer);
    if (is_wp_error($resolved)) {
        return $resolved;
    }
    return (string) $resolved['schemaId'] === $schema_id
        ? $resolved
        : zeroy_runtime_error('zeroy_schema_not_found', 'Canonical post no longer has the requested ThemeSchema.', 409);
}

function zeroy_localization_site_copy(string $locale): array|WP_Error
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    if (is_array($context) && ($context['locale'] ?? null) === $locale && is_array($context['resolvedContent']['siteCopy'] ?? null)) {
        return ['contract' => 'zeroy/locale-resolved@1', 'subject' => ['kind' => 'site-copy', 'id' => 'default'], 'locale' => $locale, 'siteCopy' => $context['resolvedContent']['siteCopy']];
    }
    return zeroy_localization_resolve(['kind' => 'site-copy', 'id' => 'default'], $locale);
}

function zeroy_localization_term_content(string $taxonomy, int $term_id, string $locale): array|WP_Error
{
    return zeroy_localization_resolve(['kind' => 'term', 'taxonomy' => $taxonomy, 'id' => $term_id], $locale);
}

function zeroy_locale_menu(int $menu_id, string $locale): array|WP_Error
{
    return zeroy_localization_resolve(['kind' => 'menu', 'id' => $menu_id], $locale);
}

function zeroy_locale_media(int $attachment_id, string $locale): array|WP_Error
{
    return zeroy_localization_resolve(['kind' => 'media', 'id' => $attachment_id], $locale);
}

function zeroy_localization_preview_url(array $subject, string $locale, int $version_id): string
{
    return add_query_arg([
        'zeroy_translation_preview' => '1',
        'subject' => rawurlencode(rtrim(strtr(base64_encode(zeroy_runtime_json($subject)), '+/', '-_'), '=')),
        'locale' => $locale,
        'versionId' => $version_id,
        'token' => hash_hmac('sha256', zeroy_localization_subject_key($subject) . '|' . $locale . '|' . $version_id, zeroy_runtime_connection_key()),
    ], home_url('/'));
}

function zeroy_localization_preview_subject_from_request(): array|WP_Error
{
    $raw = isset($_GET['subject']) && is_string($_GET['subject']) ? $_GET['subject'] : '';
    $json = $raw === '' ? false : base64_decode(strtr($raw, '-_', '+/'), true);
    $subject = is_string($json) ? zeroy_runtime_decode_json($json) : zeroy_runtime_error('zeroy_translation_preview_invalid', 'Translation preview subject is invalid.', 404);
    return is_wp_error($subject) ? zeroy_runtime_error('zeroy_translation_preview_invalid', 'Translation preview subject is invalid.', 404) : zeroy_localization_subject_ref($subject);
}
