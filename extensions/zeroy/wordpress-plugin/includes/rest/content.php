<?php

defined('ABSPATH') || exit;

function zeroy_runtime_canonical_projection(array $canonical): array
{
    return ['objectId' => $canonical['objectId'], 'postType' => $canonical['post']->post_type, 'postStatus' => $canonical['post']->post_status, 'postTitle' => $canonical['post']->post_title, 'schemaId' => $canonical['schemaId'], 'revision' => $canonical['revision']];
}

function zeroy_runtime_site_config_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    $result = is_wp_error($payload) ? $payload : (is_array($payload['siteConfig'] ?? null) ? zeroy_runtime_update_site_config($payload['siteConfig'], (int) ($payload['expectedRevision'] ?? -1)) : zeroy_runtime_error('zeroy_invalid_site_config', 'siteConfig must be an object.', 400));
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => 'zeroy/site-config@1', 'siteConfig' => $result]);
}

function zeroy_runtime_canonical_write_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = zeroy_runtime_payload($request);
    if (is_wp_error($payload)) {
        return zeroy_runtime_response_error($payload);
    }
    $result = match ((string) ($payload['action'] ?? '')) {
        'create' => zeroy_runtime_create_canonical((string) ($payload['postType'] ?? ''), (string) ($payload['schemaId'] ?? ''), (string) ($payload['postTitle'] ?? '')),
        'adopt' => zeroy_runtime_adopt_canonical((int) ($payload['postId'] ?? 0), (string) ($payload['schemaId'] ?? ''), (string) ($payload['expectedSourceHash'] ?? '')),
        'assignSchema' => zeroy_runtime_assign_canonical_schema((int) ($payload['objectId'] ?? 0), (string) ($payload['schemaId'] ?? ''), (int) ($payload['expectedRevision'] ?? -1)),
        'writeTemplateContent' => zeroy_runtime_write_template_content((int) ($payload['objectId'] ?? 0), $payload['templateContent'] ?? null, (int) ($payload['expectedRevision'] ?? -1)),
        default => zeroy_runtime_error('zeroy_canonical_action_invalid', 'Canonical action must be create, adopt, assignSchema, or writeTemplateContent.', 400),
    };
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => 'zeroy/canonical@1', 'canonical' => zeroy_runtime_canonical_projection($result)]);
}
