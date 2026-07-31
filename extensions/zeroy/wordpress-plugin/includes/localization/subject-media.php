<?php

defined('ABSPATH') || exit;

function zeroy_localization_media_subject(int $attachment_id): array|WP_Error
{
    $attachment = get_post($attachment_id);
    if (!$attachment instanceof WP_Post || $attachment->post_type !== 'attachment') {
        return zeroy_runtime_error('zeroy_localization_media_missing', 'Canonical WordPress media attachment does not exist.', 404);
    }
    $alt = (string) get_post_meta($attachment_id, '_wp_attachment_image_alt', true);
    $fields = [
        zeroy_localization_field('/media/alt', 'Media alt text', 'media:alt', $alt, ['media', 'alt']),
        zeroy_localization_field('/media/caption', 'Media caption', 'media:caption', $attachment->post_excerpt, ['media', 'caption']),
    ];
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => ['kind' => 'media', 'id' => $attachment_id],
        'schemaId' => 'media',
        'canonicalRevision' => zeroy_runtime_hash(['postModified' => $attachment->post_modified_gmt, 'fields' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields)]),
        'fields' => $fields,
        'view' => [
            'media' => [
                'attachmentId' => $attachment_id,
                'url' => wp_get_attachment_url($attachment_id) ?: '',
                'alt' => $alt,
                'caption' => $attachment->post_excerpt,
            ],
        ],
    ];
}
