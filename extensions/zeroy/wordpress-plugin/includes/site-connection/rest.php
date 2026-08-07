<?php

defined('ABSPATH') || exit;

/**
 * Pipee connection authorization REST boundary.
 *
 * Intent creation is unauthenticated by design: it is only a short-lived
 * handshake that grants nothing. The administrator approves the intent on
 * the WordPress connections admin page before any grant can exist, and the
 * code exchange is protected by the one-time intent, exact state, PKCE
 * verifier, and redirect URI. Revocation requires the grant itself (Bearer)
 * or an administrator.
 */

function zeroy_connection_authorize_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $client_id = (string) $request->get_param('client_id');
    $redirect_uri = (string) $request->get_param('redirect_uri');
    $code_challenge = (string) $request->get_param('code_challenge');
    $state = (string) $request->get_param('state');
    $label = (string) $request->get_param('label');
    if ($client_id === '' || $redirect_uri === '' || $code_challenge === '' || $state === '') {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_invalid', 'Authorization intent requires client_id, redirect_uri, code_challenge and state.', 400));
    }
    if (strlen($code_challenge) !== 64 || preg_match('/^[a-f0-9]{64}$/', $code_challenge) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_challenge_invalid', 'code_challenge must be a SHA-256 hex digest.', 400));
    }
    if (strlen($state) > 128 || strlen($client_id) > 96 || strlen($redirect_uri) > 512) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_invalid', 'Authorization intent fields exceed bounds.', 400));
    }
    $intent_id = is_string($request->get_param('intent_id')) ? sanitize_text_field(wp_unslash($request->get_param('intent_id'))) : '';
    if ($intent_id !== '' && preg_match('/\A[a-f0-9-]{36}\z/', $intent_id) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_invalid', 'intent_id must be a UUID.', 400));
    }
    $intent = [
        'intentId' => $intent_id !== '' ? $intent_id : wp_generate_uuid4(),
        'siteId' => zeroy_runtime_site_id(),
        'clientId' => $client_id,
        'redirectUri' => $redirect_uri,
        'codeChallenge' => $code_challenge,
        'state' => $state,
        'expiresAt' => gmdate('Y-m-d H:i:s', time() + 600), // 10 minutes, single use
    ];
    $stored = zeroy_connection_insert_intent($intent);
    if (is_wp_error($stored)) return zeroy_runtime_response_error($stored);
    return new WP_REST_Response([
        'contract' => 'zeroy/connection-authorization-intent@1',
        'intentId' => $intent['intentId'],
        'siteId' => $intent['siteId'],
        'clientId' => $intent['clientId'],
        'expiresAt' => $intent['expiresAt'],
    ], 201);
}

function zeroy_connection_exchange_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $intent_id = (string) $request->get_param('intent_id');
    $code = (string) $request->get_param('code');
    $code_verifier = (string) $request->get_param('code_verifier');
    $state = (string) $request->get_param('state');
    $redirect_uri = (string) $request->get_param('redirect_uri');
    if ($intent_id === '' || $code === '' || $code_verifier === '' || $state === '' || $redirect_uri === '') {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_exchange_invalid', 'Code exchange requires intent_id, code, code_verifier, state and redirect_uri.', 400));
    }
    $result = zeroy_connection_exchange_code($intent_id, $code, $code_verifier, $state, $redirect_uri);
    return is_wp_error($result)
        ? zeroy_runtime_response_error($result)
        : new WP_REST_Response($result);
}

function zeroy_connection_revoke_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $grant_id = (string) $request['grantId'];
    if (preg_match('/\A[a-f0-9-]{36}\z/', $grant_id) !== 1) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_grant_id_invalid', 'grantId is invalid.', 400));
    }
    // An administrator can revoke any grant; a grant holder can revoke only
    // its own grant by presenting the grant secret.
    $authorized = current_user_can(ZEROY_PREVIEW_CAPABILITY);
    if (!$authorized) {
        $bearer = (string) $request->get_header('authorization');
        if (preg_match('/^Bearer\s+(.+)$/i', $bearer, $matches) !== 1) {
            return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_forbidden', 'Revocation requires an administrator or the grant itself.', 403));
        }
        $grant = zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash(trim((string) $matches[1])));
        if (!is_array($grant) || (string) $grant['grant_id'] !== $grant_id) {
            return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_forbidden', 'Revocation grant does not match grantId.', 403));
        }
    }
    $revoked = zeroy_connection_revoke_grant($grant_id);
    if (is_wp_error($revoked)) return zeroy_runtime_response_error($revoked);
    return new WP_REST_Response(['contract' => 'zeroy/connection-revoked@1', 'grantId' => $grant_id, 'revokedAt' => zeroy_connection_now()]);
}

function zeroy_connection_grants_endpoint(): WP_REST_Response
{
    if (!current_user_can(ZEROY_PREVIEW_CAPABILITY)) {
        return zeroy_runtime_response_error(zeroy_runtime_error('zeroy_authorization_forbidden', 'Only an administrator can list Pipee connections.', 403));
    }
    return new WP_REST_Response([
        'contract' => 'zeroy/connection-grant-list@1',
        'grants' => zeroy_connection_list_grants(),
    ]);
}

function zeroy_connection_register_rest_routes(): void
{
    register_rest_route('zeroy/v1', '/connection/authorize', [
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => '__return_true', // admin capability checked in callback
        'callback' => 'zeroy_connection_authorize_endpoint',
    ]);
    register_rest_route('zeroy/v1', '/connection/exchange', [
        'methods' => WP_REST_Server::CREATABLE,
        'permission_callback' => '__return_true', // intent + PKCE + state protect it
        'callback' => 'zeroy_connection_exchange_endpoint',
    ]);
    register_rest_route('zeroy/v1', '/connection/grants', [
        'methods' => WP_REST_Server::READABLE,
        'permission_callback' => '__return_true',
        'callback' => 'zeroy_connection_grants_endpoint',
    ]);
    register_rest_route('zeroy/v1', '/connection/grants/(?P<grantId>[a-f0-9-]{36})', [
        'methods' => WP_REST_Server::DELETABLE,
        'permission_callback' => '__return_true',
        'callback' => 'zeroy_connection_revoke_endpoint',
    ]);
}
add_action('rest_api_init', 'zeroy_connection_register_rest_routes');
