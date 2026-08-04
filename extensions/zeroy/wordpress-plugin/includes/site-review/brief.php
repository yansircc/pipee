<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_BRIEF_OPTION = 'zeroy_site_brief';
const ZEROY_SITE_BRIEF_CONTRACT = 'zeroy/site-brief@1';
const ZEROY_SITE_REVIEW_EVALUATOR_VERSION = 'zeroy/review@1';

/**
 * The Brief is administrator-owned intent. It is deliberately not a checkout
 * document: an Agent must not be able to weaken its own completion boundary.
 */
function zeroy_review_decode_brief(mixed $value): array|WP_Error
{
    if (!zeroy_runtime_is_keyed_map($value) || array_keys($value) !== ['contract', 'prompt']) {
        return zeroy_runtime_error('zeroy_site_brief_invalid', 'Site Brief must contain exactly contract and prompt.', 400);
    }
    if (($value['contract'] ?? null) !== ZEROY_SITE_BRIEF_CONTRACT || !is_string($value['prompt'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_brief_invalid', 'Site Brief contract or prompt is invalid.', 400);
    }
    $prompt = trim($value['prompt']);
    if ($prompt === '' || strlen($prompt) > 16000) {
        return zeroy_runtime_error('zeroy_site_brief_invalid', 'Site Brief prompt must contain 1 to 16000 bytes.', 400);
    }
    return ['contract' => ZEROY_SITE_BRIEF_CONTRACT, 'prompt' => $prompt];
}

function zeroy_review_brief(): ?array
{
    $stored = get_option(ZEROY_SITE_BRIEF_OPTION, null);
    $brief = zeroy_review_decode_brief($stored);
    return is_wp_error($brief) ? null : $brief;
}

function zeroy_review_brief_hash(array $brief): string
{
    return zeroy_runtime_hash($brief);
}

function zeroy_review_brief_projection(): array
{
    $brief = zeroy_review_brief();
    if ($brief === null) {
        return [
            'contract' => 'zeroy/site-brief-projection@1',
            'state' => 'missing',
            'brief' => null,
            'briefHash' => null,
            'evaluatorVersion' => ZEROY_SITE_REVIEW_EVALUATOR_VERSION,
        ];
    }
    return [
        'contract' => 'zeroy/site-brief-projection@1',
        'state' => 'present',
        'brief' => $brief,
        'briefHash' => zeroy_review_brief_hash($brief),
        'evaluatorVersion' => ZEROY_SITE_REVIEW_EVALUATOR_VERSION,
    ];
}

function zeroy_review_set_brief(string $prompt): array|WP_Error
{
    $brief = zeroy_review_decode_brief(['contract' => ZEROY_SITE_BRIEF_CONTRACT, 'prompt' => $prompt]);
    if (is_wp_error($brief)) return $brief;
    if (!update_option(ZEROY_SITE_BRIEF_OPTION, $brief, false)) {
        $existing = zeroy_review_brief();
        if ($existing === null || !hash_equals(zeroy_review_brief_hash($existing), zeroy_review_brief_hash($brief))) {
            return zeroy_runtime_error('zeroy_site_brief_store_failed', 'Could not store Site Brief.', 500);
        }
    }
    return zeroy_review_brief_projection();
}
