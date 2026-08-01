<?php

defined("ABSPATH") || exit;

function zeroy_runtime_default_site_config(): array
{
    return [
        'defaultLocale' => 'zh-CN',
        'enabledLocales' => [
            ['locale' => 'zh-CN', 'label' => '中文', 'urlPrefix' => ''],
            ['locale' => 'en', 'label' => 'English', 'urlPrefix' => 'en'],
        ],
        'translationProfile' => zeroy_localization_default_translation_profile(),
        'siteCopy' => [],
    ];
}

function zeroy_runtime_content_ownership(): array
{
    return [
        'contract' => 'zeroy/content-ownership@1',
        'canonical' => [
            'owner' => 'wordpress',
            'facts' => ['post fields', 'ACF values'],
            'rule' => 'zeroY never copies, translates, or overwrites canonical WordPress or ACF facts.',
        ],
        'localeOverlay' => [
            'owner' => 'zeroy-locale-store',
            'facts' => ['immutable LocaleOverlay values, draft and published pointers, locale routes'],
            'rule' => 'ThemeSchema owns field responsibility. LocaleOverlay stores only translated or explicit overridable values; Theme PHP reads the resolved projection.',
        ],
        'adoption' => [
            'mode' => 'identity-only',
            'precondition' => 'expectedSourceHash from existingPost',
            'rule' => 'Adoption attaches zeroY canonical identity without migrating existing WordPress or ACF values.',
        ],
    ];
}

function zeroy_runtime_normalize_locale(string $locale): string|WP_Error
{
    $locale = trim($locale);
    if (!preg_match('/\A[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\z/', $locale)) {
        return zeroy_runtime_error('zeroy_invalid_locale', 'Locale must be a BCP-47-like identifier.', 400);
    }
    return $locale;
}

function zeroy_runtime_normalize_route(string $route): string|WP_Error
{
    $route = trim(rawurldecode($route));
    if (str_contains($route, "\0")) {
        return zeroy_runtime_error('zeroy_invalid_route', 'Route contains a null byte.', 400);
    }
    $front_page = $route === '/';
    $route = trim(wp_normalize_path($route), '/');
    if ($route === '') {
        // The empty stored path is the one explicit representation of FrontPage.
        // It is never inferred from an arbitrary missing route.
        return $front_page
            ? ''
            : zeroy_runtime_error('zeroy_invalid_route', 'Route must be / for the front page or a non-empty path using letters, digits, underscores, hyphens, and slashes.', 400);
    }
    if (!preg_match('/\A[a-z0-9][a-z0-9_\-\/]*\z/i', $route)) {
        return zeroy_runtime_error('zeroy_invalid_route', 'Route must be / for the front page or a non-empty path using letters, digits, underscores, hyphens, and slashes.', 400);
    }
    return strtolower($route);
}

function zeroy_runtime_validate_site_config(array $input): array|WP_Error
{
    $default = zeroy_runtime_normalize_locale((string) ($input['defaultLocale'] ?? ''));
    if (is_wp_error($default)) {
        return $default;
    }
    $raw_locales = $input['enabledLocales'] ?? null;
    if (!is_array($raw_locales) || !array_is_list($raw_locales) || count($raw_locales) === 0) {
        return zeroy_runtime_error('zeroy_invalid_site_config', 'enabledLocales must be a non-empty list.', 400);
    }

    $seen_locale = [];
    $seen_prefix = [];
    $locales = [];
    foreach ($raw_locales as $candidate) {
        if (!is_array($candidate)) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Each enabled locale must be an object.', 400);
        }
        $locale = zeroy_runtime_normalize_locale((string) ($candidate['locale'] ?? ''));
        if (is_wp_error($locale)) {
            return $locale;
        }
        $label = trim((string) ($candidate['label'] ?? ''));
        $prefix = trim(wp_normalize_path((string) ($candidate['urlPrefix'] ?? '')), '/');
        if ($label === '' || strlen($label) > 80) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Every locale needs a short label.', 400);
        }
        if ($prefix !== '' && !preg_match('/\A[a-z0-9][a-z0-9\-]*\z/i', $prefix)) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Locale URL prefixes must be one path-safe segment.', 400);
        }
        if (isset($seen_locale[$locale]) || isset($seen_prefix[$prefix])) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Locale identifiers and URL prefixes must be unique.', 400);
        }
        $seen_locale[$locale] = true;
        $seen_prefix[$prefix] = true;
        $locales[] = ['locale' => $locale, 'label' => $label, 'urlPrefix' => strtolower($prefix)];
    }

    if (!isset($seen_locale[$default])) {
        return zeroy_runtime_error('zeroy_invalid_site_config', 'defaultLocale must be enabled.', 400);
    }
    foreach ($locales as $locale) {
        if ($locale['locale'] === $default && $locale['urlPrefix'] !== '') {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'The default locale must use an empty URL prefix.', 400);
        }
    }
    $profile = zeroy_localization_normalize_translation_profile($input['translationProfile'] ?? zeroy_localization_default_translation_profile());
    if (is_wp_error($profile)) {
        return $profile;
    }
    $site_copy = $input['siteCopy'] ?? [];
    if (!zeroy_runtime_is_keyed_map($site_copy)) {
        return zeroy_runtime_error('zeroy_invalid_site_config', 'siteCopy must be a keyed object of canonical strings.', 400);
    }
    foreach ($site_copy as $key => $value) {
        if (!is_string($key) || $key === '' || !is_string($value) || strlen($value) > 12000) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'siteCopy must contain bounded string values keyed by stable strings.', 400);
        }
    }
    return ['defaultLocale' => $default, 'enabledLocales' => $locales, 'translationProfile' => $profile, 'siteCopy' => $site_copy];
}

function zeroy_runtime_ensure_site_config(): void
{
    global $wpdb;
    $table = zeroy_runtime_table('site_config');
    $existing = $wpdb->get_var("SELECT singleton FROM {$table} WHERE singleton = 1");
    if ($existing !== null) {
        return;
    }
    $wpdb->insert(
        $table,
        ['singleton' => 1, 'config_json' => zeroy_runtime_json(zeroy_runtime_default_site_config()), 'revision' => 1],
        ['%d', '%s', '%d']
    );
}

function zeroy_runtime_site_config(): array|WP_Error
{
    global $wpdb;
    zeroy_runtime_ensure_site_config();
    $row = $wpdb->get_row('SELECT config_json, revision FROM ' . zeroy_runtime_table('site_config') . ' WHERE singleton = 1', ARRAY_A);
    if (!is_array($row)) {
        return zeroy_runtime_error('zeroy_site_config_missing', 'SiteConfig is unavailable.', 500);
    }
    $config = zeroy_runtime_decode_json((string) $row['config_json']);
    if (is_wp_error($config)) {
        return zeroy_runtime_error('zeroy_site_config_invalid', 'Stored SiteConfig is invalid.', 409);
    }
    $config = zeroy_runtime_validate_site_config($config);
    if (is_wp_error($config)) {
        return zeroy_runtime_error('zeroy_site_config_invalid', 'Stored SiteConfig is invalid.', 409);
    }
    $config['revision'] = (int) $row['revision'];
    return $config;
}

function zeroy_runtime_has_published_documents(): bool
{
    global $wpdb;
    return (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE published_version_id IS NOT NULL') > 0;
}

function zeroy_runtime_locale_has_published_documents(string $locale): bool
{
    global $wpdb;
    return (int) $wpdb->get_var(
        $wpdb->prepare(
            'SELECT COUNT(*) FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE locale = %s AND published_version_id IS NOT NULL',
            $locale
        )
    ) > 0;
}

function zeroy_runtime_update_site_config(array $input, int $expected_revision): array|WP_Error
{
    $result = zeroy_runtime_transaction(function () use ($input, $expected_revision) {
        $lease = zeroy_runtime_acquire_content_lease();
        if (is_wp_error($lease)) return $lease;
        $updated = zeroy_runtime_write_site_config_locked($input, $expected_revision);
        if (is_wp_error($updated)) return $updated;
        $schema = zeroy_runtime_theme_schema();
        if (is_wp_error($schema)) return $schema;
        $reconciled = zeroy_localization_reconcile_subject_overlay_heads(['kind' => 'site-copy', 'id' => 'default'], $schema);
        return is_wp_error($reconciled) ? $reconciled : $updated;
    });
    if (!is_wp_error($result)) {
        flush_rewrite_rules(false);
    }
    return $result;
}

/** Persist SiteConfig only. The transaction owner chooses the schema used for reconciliation. */
function zeroy_runtime_write_site_config_locked(array $input, int $expected_revision): array|WP_Error
{
    global $wpdb;
    $next = zeroy_runtime_validate_site_config($input);
    if (is_wp_error($next)) {
        return $next;
    }
    $current = zeroy_runtime_site_config();
    if (is_wp_error($current)) {
        return $current;
    }
    if ($current['revision'] !== $expected_revision) {
        return zeroy_runtime_error('zeroy_site_config_conflict', 'SiteConfig changed after it was read.', 409, ['currentRevision' => $current['revision']]);
    }
    if ($current['defaultLocale'] !== $next['defaultLocale'] && zeroy_runtime_has_published_documents()) {
        return zeroy_runtime_error('zeroy_default_locale_locked', 'The default locale is locked after the first publish.', 409);
    }
    $next_prefixes = [];
    foreach ($next['enabledLocales'] as $locale) {
        $next_prefixes[$locale['locale']] = $locale['urlPrefix'];
    }
    foreach ($current['enabledLocales'] as $locale) {
        $locale_id = $locale['locale'];
        if (isset($next_prefixes[$locale_id]) && $next_prefixes[$locale_id] !== $locale['urlPrefix']) {
            if (zeroy_runtime_locale_has_published_documents($locale_id)) {
                return zeroy_runtime_error('zeroy_locale_prefix_locked', 'A locale URL prefix is locked after its first published LocaleOverlay.', 409);
            }
        }
    }
    $next_revision = $expected_revision + 1;
    $updated = $wpdb->query(
        $wpdb->prepare(
            'UPDATE ' . zeroy_runtime_table('site_config') . ' SET config_json = %s, revision = %d WHERE singleton = 1 AND revision = %d',
            zeroy_runtime_json($next),
            $next_revision,
            $expected_revision
        )
    );
    if ($updated !== 1) {
        $fresh = zeroy_runtime_site_config();
        return zeroy_runtime_error('zeroy_site_config_conflict', 'SiteConfig changed after it was read.', 409, [
            'currentRevision' => is_array($fresh) ? $fresh['revision'] : null,
        ]);
    }
    $next['revision'] = $next_revision;
    return $next;
}

function zeroy_runtime_locale_config(string $locale): ?array
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return null;
    }
    foreach ($config['enabledLocales'] as $candidate) {
        if ($candidate['locale'] === $locale) {
            return $candidate;
        }
    }
    return null;
}

function zeroy_runtime_locale_is_enabled(string $locale): bool
{
    return zeroy_runtime_locale_config($locale) !== null;
}
