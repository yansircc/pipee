<?php

defined('ABSPATH') || exit;

/**
 * Pipee connection authorization storage.
 *
 * Facts owned by the plugin:
 * - siteId and the stable site identity.
 * - Client grants: only the irreversible grant_hash is stored; the grant
 *   secret plaintext lives in Pipee protected secret storage.
 * - Authorization intents: short-lived, single-use, bound to site identity,
 *   the Pipee client_id, the redirect URI, and a PKCE code challenge.
 *
 * The internal runtime connection key remains for site-internal HMAC tokens
 * (candidate/evidence URLs, translation jobs). It is never handed to Pipee.
 */

function zeroy_connection_grant_hash(string $grant_secret): string
{
    return hash('sha256', $grant_secret);
}

function zeroy_connection_random_secret(): string
{
    return wp_generate_password(48, true, true);
}

function zeroy_connection_now(): string
{
    return current_time('mysql', true);
}

function zeroy_connection_insert_grant(string $grant_id, string $grant_hash, string $client_id, string $client_label): true|WP_Error
{
    global $wpdb;
    $inserted = $wpdb->insert(
        zeroy_runtime_table('zeroy_client_grants'),
        [
            'grant_id' => $grant_id,
            'grant_hash' => $grant_hash,
            'client_id' => $client_id,
            'client_label' => $client_label,
            'created_at' => zeroy_connection_now(),
        ],
        ['%s', '%s', '%s', '%s', '%s'],
    );
    return $inserted === false
        ? zeroy_runtime_error('zeroy_client_grant_store_failed', $wpdb->last_error ?: 'Could not store the Pipee client grant.', 500)
        : true;
}

function zeroy_connection_find_grant_by_hash(string $grant_hash): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('zeroy_client_grants') . ' WHERE grant_hash = %s LIMIT 1', $grant_hash),
        ARRAY_A,
    );
    return is_array($row) ? $row : null;
}

function zeroy_connection_grant_is_revoked(?array $grant): bool
{
    $revoked_at = is_array($grant) ? ($grant['revoked_at'] ?? null) : null;
    return $revoked_at !== null && $revoked_at !== '';
}

function zeroy_connection_revoke_grant(string $grant_id): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->update(
        zeroy_runtime_table('zeroy_client_grants'),
        ['revoked_at' => zeroy_connection_now()],
        ['grant_id' => $grant_id],
        ['%s'],
        ['%s'],
    );
    return $updated === false
        ? zeroy_runtime_error('zeroy_client_grant_revoke_failed', $wpdb->last_error ?: 'Could not revoke the Pipee client grant.', 500)
        : true;
}

function zeroy_connection_touch_grant(string $grant_id): void
{
    global $wpdb;
    $wpdb->update(
        zeroy_runtime_table('zeroy_client_grants'),
        ['last_used_at' => zeroy_connection_now()],
        ['grant_id' => $grant_id],
        ['%s'],
        ['%s'],
    );
}

function zeroy_connection_list_grants(): array
{
    global $wpdb;
    $rows = $wpdb->get_results(
        'SELECT grant_id, client_id, client_label, created_at, last_used_at, revoked_at FROM ' . zeroy_runtime_table('zeroy_client_grants') . ' ORDER BY created_at DESC',
        ARRAY_A,
    );
    return is_array($rows) ? $rows : [];
}

function zeroy_connection_insert_intent(array $intent): true|WP_Error
{
    global $wpdb;
    $inserted = $wpdb->insert(
        zeroy_runtime_table('zeroy_authorization_intents'),
        [
            'intent_id' => (string) $intent['intentId'],
            'site_id' => (string) $intent['siteId'],
            'client_id' => (string) $intent['clientId'],
            'redirect_uri' => (string) $intent['redirectUri'],
            'code_challenge' => (string) $intent['codeChallenge'],
            'state' => (string) $intent['state'],
            'expires_at' => (string) $intent['expiresAt'],
            'created_at' => zeroy_connection_now(),
        ],
        ['%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s'],
    );
    return $inserted === false
        ? zeroy_runtime_error('zeroy_authorization_intent_store_failed', $wpdb->last_error ?: 'Could not store the authorization intent.', 500)
        : true;
}

function zeroy_connection_find_intent(string $intent_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('zeroy_authorization_intents') . ' WHERE intent_id = %s LIMIT 1', $intent_id),
        ARRAY_A,
    );
    return is_array($row) ? $row : null;
}

function zeroy_connection_consume_intent(string $intent_id): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->update(
        zeroy_runtime_table('zeroy_authorization_intents'),
        ['consumed_at' => zeroy_connection_now()],
        ['intent_id' => $intent_id, 'consumed_at' => null],
        ['%s'],
        ['%s', '%s'],
    );
    return $updated === false
        ? zeroy_runtime_error('zeroy_authorization_intent_consume_failed', $wpdb->last_error ?: 'Could not consume the authorization intent.', 500)
        : true;
}

function zeroy_connection_intent_is_valid(?array $intent): bool
{
    if (!is_array($intent)) return false;
    $consumed_at = $intent['consumed_at'] ?? null;
    if ($consumed_at !== null && $consumed_at !== '') return false;
    $expires_at = is_string($intent['expires_at'] ?? null) ? strtotime((string) $intent['expires_at']) : 0;
    if ($expires_at === false || $expires_at < time()) return false;
    return true;
}

/**
 * Validate a code exchange. The callback supplies the intent id, the
 * authorization code (the grant secret), the verifier, and the exact state.
 * A single-use intent can only be exchanged once with a matching verifier
 * and redirect URI.
 */
function zeroy_connection_exchange_code(string $intent_id, string $code, string $code_verifier, string $state, string $redirect_uri): array|WP_Error
{
    $intent = zeroy_connection_find_intent($intent_id);
    if (!zeroy_connection_intent_is_valid($intent)) {
        return zeroy_runtime_error('zeroy_authorization_intent_invalid', 'Authorization intent is missing, expired, or already consumed.', 400);
    }
    if (!hash_equals((string) $intent['state'], $state)) {
        return zeroy_runtime_error('zeroy_authorization_state_mismatch', 'Authorization state does not match the intent.', 400);
    }
    if (!hash_equals((string) $intent['redirect_uri'], $redirect_uri)) {
        return zeroy_runtime_error('zeroy_authorization_redirect_mismatch', 'Redirect URI does not match the intent.', 400);
    }
    // PKCE S256: verifier -> challenge. A mismatched verifier must never
    // consume the intent or produce a grant.
    $expected_challenge = hash('sha256', $code_verifier);
    if (!hash_equals((string) $intent['code_challenge'], $expected_challenge)) {
        return zeroy_runtime_error('zeroy_authorization_verifier_mismatch', 'Code verifier does not match the intent challenge.', 400);
    }
    $consumed = zeroy_connection_consume_intent($intent_id);
    if (is_wp_error($consumed)) return $consumed;
    $grant_id = wp_generate_uuid4();
    // The grant secret is minted at exchange time and returned once in the
    // exchange response body. The pairing code / authorization code used to
    // reach this point is a short-lived one-time credential only; it never
    // becomes the long-lived bearer secret, so a pairing code leaked from a
    // URL, history, or log cannot authenticate later requests.
    $grant_secret = zeroy_connection_random_secret();
    $grant_hash = zeroy_connection_grant_hash($grant_secret);
    $stored = zeroy_connection_insert_grant($grant_id, $grant_hash, (string) $intent['client_id'], (string) $intent['client_id']);
    if (is_wp_error($stored)) return $stored;
    return [
        'contract' => 'zeroy/connection-grant@1',
        'grantId' => $grant_id,
        'grantHash' => $grant_hash,
        'grantSecret' => $grant_secret,
        'siteId' => (string) $intent['site_id'],
        'clientId' => (string) $intent['client_id'],
        'label' => (string) $intent['client_id'],
        'createdAt' => zeroy_connection_now(),
        'lastUsedAt' => null,
        'revokedAt' => null,
    ];
}
