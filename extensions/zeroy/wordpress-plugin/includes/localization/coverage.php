<?php

defined('ABSPATH') || exit;

/**
 * Read-only language coverage projection for operator surfaces. It derives
 * directly from TranslationJob and LocaleOverlay heads; it owns no content or
 * workflow state of its own.
 */
function zeroy_localization_translation_coverage(array $subject, string $locale, bool $canonical_published): array
{
    $config = zeroy_runtime_site_config();
    $empty = ['missing' => 0, 'stale' => 0, 'reviewNeeded' => 0, 'current' => 0, 'shared' => 0, 'derived' => 0];
    if (is_wp_error($config)) {
        return ['state' => 'unavailable', 'summary' => $empty, 'publishedAt' => null, 'code' => $config->get_error_code()];
    }
    if ($locale === $config['defaultLocale']) {
        return ['state' => $canonical_published ? 'published' : 'not-started', 'summary' => $empty, 'publishedAt' => null];
    }
    $job = zeroy_localization_translation_job($subject, $locale);
    if (is_wp_error($job)) {
        return ['state' => 'unavailable', 'summary' => $empty, 'publishedAt' => null, 'code' => $job->get_error_code()];
    }
    $head = zeroy_localization_overlay_head($subject, $locale);
    $published = $head !== null && $head['published_version_id'] !== null;
    return [
        'state' => $published ? 'published' : ($head !== null && $head['draft_version_id'] !== null ? 'draft' : 'not-started'),
        'summary' => $job['summary'],
        'publishedAt' => $published && is_string($head['published_at'] ?? null) ? $head['published_at'] : null,
        'revision' => $job['expectedRevision'],
    ];
}
