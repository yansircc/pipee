<?php

defined('ABSPATH') || exit;

function zeroy_runtime_translation_mutation_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $result = match ((string) ($payload['action'] ?? '')) {
        'writeTranslationDraft' => zeroy_localization_write_translation_draft((string) ($payload['jobToken'] ?? ''), $payload['values'] ?? null, (int) ($payload['expectedRevision'] ?? -1)),
        'publishTranslation' => zeroy_localization_publish_translation(is_array($payload['subject'] ?? null) ? $payload['subject'] : [], (string) ($payload['locale'] ?? ''), (int) ($payload['expectedRevision'] ?? -1)),
        'unpublishTranslation' => zeroy_localization_unpublish_translation(is_array($payload['subject'] ?? null) ? $payload['subject'] : [], (string) ($payload['locale'] ?? ''), (int) ($payload['expectedRevision'] ?? -1)),
        default => zeroy_runtime_error('zeroy_translation_action_invalid', 'Translation action must be writeTranslationDraft, publishTranslation, or unpublishTranslation.', 400),
    };
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}
