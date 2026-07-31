<?php

defined('ABSPATH') || exit;

function zeroy_localization_default_translation_profile(): array
{
    return [
        'contract' => 'zeroy/translation-profile@1',
        'companySummary' => '',
        'targetAudience' => '',
        'brandVoice' => '',
        'localeGuidance' => [],
        'glossary' => [],
        'protectedTerms' => [],
    ];
}

function zeroy_localization_normalize_translation_profile(mixed $input): array|WP_Error
{
    if (!is_array($input) || array_is_list($input) || ($input['contract'] ?? null) !== 'zeroy/translation-profile@1') {
        return zeroy_runtime_error('zeroy_translation_profile_invalid', 'translationProfile must use zeroy/translation-profile@1.', 400);
    }
    $text = [];
    foreach (['companySummary', 'targetAudience', 'brandVoice'] as $field) {
        $value = $input[$field] ?? null;
        if (!is_string($value) || strlen($value) > 12000) {
            return zeroy_runtime_error('zeroy_translation_profile_invalid', "translationProfile.{$field} must be a string up to 12000 bytes.", 400);
        }
        $text[$field] = $value;
    }
    $guidance = $input['localeGuidance'] ?? null;
    if (!zeroy_runtime_is_keyed_map($guidance)) {
        return zeroy_runtime_error('zeroy_translation_profile_invalid', 'translationProfile.localeGuidance must be a keyed object.', 400);
    }
    foreach ($guidance as $locale => $value) {
        if (!is_string($locale) || !is_string($value) || strlen($value) > 12000) {
            return zeroy_runtime_error('zeroy_translation_profile_invalid', 'Every localeGuidance value must be a bounded string.', 400);
        }
    }
    $glossary = $input['glossary'] ?? null;
    if (!is_array($glossary) || !array_is_list($glossary) || count($glossary) > 500) {
        return zeroy_runtime_error('zeroy_translation_profile_invalid', 'translationProfile.glossary must be a list of at most 500 terms.', 400);
    }
    foreach ($glossary as $entry) {
        if (!is_array($entry) || !is_string($entry['source'] ?? null) || !zeroy_runtime_is_keyed_map($entry['translations'] ?? null) || (isset($entry['note']) && !is_string($entry['note']))) {
            return zeroy_runtime_error('zeroy_translation_profile_invalid', 'Every glossary entry needs source and keyed translations.', 400);
        }
    }
    $protected = $input['protectedTerms'] ?? null;
    if (!is_array($protected) || !array_is_list($protected) || count($protected) > 500 || array_filter($protected, static fn(mixed $term): bool => !is_string($term))) {
        return zeroy_runtime_error('zeroy_translation_profile_invalid', 'translationProfile.protectedTerms must be a list of strings.', 400);
    }
    return ['contract' => 'zeroy/translation-profile@1', ...$text, 'localeGuidance' => $guidance, 'glossary' => $glossary, 'protectedTerms' => $protected];
}

function zeroy_localization_translation_profile(): array|WP_Error
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return $config;
    }
    return zeroy_localization_normalize_translation_profile($config['translationProfile'] ?? zeroy_localization_default_translation_profile());
}

function zeroy_localization_translation_profile_projection(string $locale): array|WP_Error
{
    $profile = zeroy_localization_translation_profile();
    if (is_wp_error($profile)) {
        return $profile;
    }
    $glossary = [];
    foreach ($profile['glossary'] as $entry) {
        if (array_key_exists($locale, $entry['translations'])) {
            $glossary[] = [
                'source' => $entry['source'],
                'translation' => $entry['translations'][$locale],
                ...(!isset($entry['note']) ? [] : ['note' => $entry['note']]),
            ];
        }
    }
    return [
        'companySummary' => $profile['companySummary'],
        'targetAudience' => $profile['targetAudience'],
        'brandVoice' => $profile['brandVoice'],
        'localeGuidance' => $profile['localeGuidance'][$locale] ?? '',
        'glossary' => $glossary,
        'protectedTerms' => $profile['protectedTerms'],
    ];
}
