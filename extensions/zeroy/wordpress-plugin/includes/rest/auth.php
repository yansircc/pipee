<?php

defined('ABSPATH') || exit;

/**
 * Connector REST authentication.
 *
 * Production Pipee instances authenticate with their client grant via
 * `Authorization: Bearer <grant secret>`. The plugin stores only the
 * irreversible grant hash and rejects revoked grants.
 *
 * The legacy `x-zeroy-key = zeroy_runtime_connection_key` header remains
 * accepted only as the EnvironmentInjected headless/CI source. Production
 * must not use it; the internal runtime key is never handed to Pipee.
 */
function zeroy_runtime_authorized(WP_REST_Request $request): bool
{
    $bearer = (string) $request->get_header('authorization');
    if ($bearer !== '' && preg_match('/^Bearer\s+(.+)$/i', $bearer, $matches) === 1) {
        $grant = zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash(trim((string) $matches[1])));
        if ($grant === null) return false;
        if (zeroy_connection_grant_is_revoked($grant)) return false;
        zeroy_connection_touch_grant((string) $grant['grant_id']);
        return true;
    }
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
