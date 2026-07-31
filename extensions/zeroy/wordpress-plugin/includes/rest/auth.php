<?php

defined('ABSPATH') || exit;

function zeroy_runtime_authorized(WP_REST_Request $request): bool
{
    $provided = (string) $request->get_header('x-zeroy-key');
    return $provided !== '' && hash_equals(zeroy_runtime_connection_key(), $provided);
}

function zeroy_runtime_response_error(WP_Error $error): WP_REST_Response
{
    $data = $error->get_error_data();
    $status = is_array($data) && isset($data['status']) ? (int) $data['status'] : 400;
    return new WP_REST_Response([
        'error' => [
            'code' => $error->get_error_code(),
            'message' => $error->get_error_message(),
            'data' => $data,
        ],
    ], $status);
}

function zeroy_runtime_payload(WP_REST_Request $request): array|WP_Error
{
    $payload = $request->get_json_params();
    return zeroy_runtime_is_keyed_map($payload)
        ? $payload
        : zeroy_runtime_error('zeroy_invalid_payload', 'Expected a JSON object payload.', 400);
}
