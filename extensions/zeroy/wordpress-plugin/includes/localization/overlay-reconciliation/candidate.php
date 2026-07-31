<?php

defined('ABSPATH') || exit;

/** Candidate requests use the same pure reconciliation as activation, but do not write heads. */
function zeroy_localization_candidate_overlay_for_head(
    array $head,
    string $pointer,
    array $subject,
    string $locale,
    array $compiled
): array|WP_Error {
    if ($head[$pointer] === null) {
        return zeroy_localization_empty_overlay($subject, $locale, $compiled['policy']['hash']);
    }
    $version = zeroy_localization_overlay_version((int) $head[$pointer]);
    $overlay = $version === null
        ? zeroy_runtime_error('zeroy_locale_overlay_corrupt', "LocaleOverlay {$pointer} points to a missing immutable version.", 409)
        : zeroy_localization_decode_overlay($version);
    if (is_wp_error($overlay)) {
        return $overlay;
    }
    $reconciled = zeroy_localization_reconcile_overlay($overlay, $compiled['fields'], $subject, $locale, $compiled['policy']['hash']);
    return is_wp_error($reconciled) ? $reconciled : $reconciled['overlay'];
}
