<?php

defined('ABSPATH') || exit;

const ZEROY_CONNECTION_ADMIN_SLUG = 'zeroy-connections';

function zeroy_connection_admin_url(array $arguments = []): string
{
    return add_query_arg(['page' => ZEROY_CONNECTION_ADMIN_SLUG, ...$arguments], admin_url('admin.php'));
}

function zeroy_connection_admin_require_capability(): void
{
    if (!current_user_can(ZEROY_PREVIEW_CAPABILITY)) {
        wp_die('You do not have permission to manage zeroY connections.', 'Forbidden', ['response' => 403]);
    }
}

function zeroy_connection_admin_notice(string $kind, string $message): void
{
    $class = $kind === 'error' ? 'notice-error' : 'notice-success';
    printf('<div class="notice %s"><p>%s</p></div>', esc_attr($class), esc_html($message));
}

function zeroy_connection_admin_revoke(): void
{
    zeroy_connection_admin_require_capability();
    check_admin_referer('zeroy_connection_revoke');
    $grant_id = isset($_POST['grantId']) ? sanitize_text_field(wp_unslash($_POST['grantId'])) : '';
    if (preg_match('/\A[a-f0-9-]{36}\z/', $grant_id) !== 1) {
        wp_safe_redirect(zeroy_connection_admin_url(['zeroy_notice' => 'revoke-error', 'message' => 'Invalid grant.']));
        exit;
    }
    $revoked = zeroy_connection_revoke_grant($grant_id);
    $arguments = is_wp_error($revoked)
        ? ['zeroy_notice' => 'revoke-error', 'message' => $revoked->get_error_message()]
        : ['zeroy_notice' => 'revoked'];
    wp_safe_redirect(zeroy_connection_admin_url($arguments));
    exit;
}

/**
 * WordPress-initiated pairing intent: the admin page shows a short-lived
 * pairing intent the Pipee side can consume through the same exchange
 * endpoint as the Pipee-initiated flow. It must reuse the authorization
 * code exchange; it never creates a second long-lived secret copy flow.
 */
function zeroy_connection_admin_begin_pairing(): void
{
    zeroy_connection_admin_require_capability();
    check_admin_referer('zeroy_connection_pair');
    $client_id = isset($_POST['clientId']) ? sanitize_text_field(wp_unslash($_POST['clientId'])) : 'pipee-local';
    $redirect_uri = isset($_POST['redirectUri']) ? esc_url_raw(wp_unslash($_POST['redirectUri'])) : '';
    $code_verifier = wp_generate_password(48, true, true);
    $code_challenge = hash('sha256', $code_verifier);
    $state = wp_generate_uuid4();
    $intent = [
        'intentId' => wp_generate_uuid4(),
        'siteId' => zeroy_runtime_site_id(),
        'clientId' => $client_id,
        'redirectUri' => $redirect_uri !== '' ? $redirect_uri : 'http://127.0.0.1:30141/zeroy/connect/callback',
        'codeChallenge' => $code_challenge,
        'state' => $state,
        'expiresAt' => gmdate('Y-m-d H:i:s', time() + 600),
    ];
    $stored = zeroy_connection_insert_intent($intent);
    if (is_wp_error($stored)) {
        wp_safe_redirect(zeroy_connection_admin_url(['zeroy_notice' => 'pair-error', 'message' => $stored->get_error_message()]));
        exit;
    }
    // The pairing code is the code_verifier: it is short-lived, single-use,
    // and never a persistent credential. The admin copies it into Pipee.
    wp_safe_redirect(zeroy_connection_admin_url([
        'zeroy_notice' => 'pairing-created',
        'pairingCode' => $code_verifier,
        'intentId' => $intent['intentId'],
        'redirectUri' => $intent['redirectUri'],
        'state' => $state,
    ]));
    exit;
}

function zeroy_connection_admin_page(): void
{
    zeroy_connection_admin_require_capability();
    $notice = isset($_GET['zeroy_notice']) ? sanitize_key((string) $_GET['zeroy_notice']) : '';
    $message = isset($_GET['message']) ? sanitize_text_field(wp_unslash($_GET['message'])) : '';
    if ($notice === 'revoked') zeroy_connection_admin_notice('success', 'The Pipee connection was revoked. Pipee requests from that client are now rejected.');
    if ($notice === 'revoke-error') zeroy_connection_admin_notice('error', $message !== '' ? $message : 'Could not revoke the connection.');
    if ($notice === 'pair-error') zeroy_connection_admin_notice('error', $message !== '' ? $message : 'Could not create the pairing intent.');
    if ($notice === 'pairing-created') {
        $pairing_code = isset($_GET['pairingCode']) ? sanitize_text_field(wp_unslash($_GET['pairingCode'])) : '';
        $intent_id = isset($_GET['intentId']) ? sanitize_text_field(wp_unslash($_GET['intentId'])) : '';
        $redirect_uri = isset($_GET['redirectUri']) ? esc_url_raw(wp_unslash($_GET['redirectUri'])) : '';
        $state = isset($_GET['state']) ? sanitize_text_field(wp_unslash($_GET['state'])) : '';
        zeroy_connection_admin_notice('success', 'Pairing intent created. In Pipee, choose "Pair with code" and enter the code below.');
        printf(
            '<div class="card"><h3>Pairing code (single use, valid 10 minutes)</h3><p><code style="font-size:1.2rem">%s</code></p><p>Pipee callback: %s</p></div>',
            esc_html($pairing_code),
            esc_html($redirect_uri),
        );
        echo '<input type="hidden" id="zeroy-intent-id" value="' . esc_attr($intent_id) . '" />';
        echo '<input type="hidden" id="zeroy-intent-state" value="' . esc_attr($state) . '" />';
        echo '<input type="hidden" id="zeroy-intent-redirect" value="' . esc_attr($redirect_uri) . '" />';
    }
    $grants = zeroy_connection_list_grants();
    ?>
    <div class="wrap">
        <h1>zeroY connections</h1>
        <p>Pipee instances connect to this site with a revocable client grant. Only the irreversible grant hash is stored here; grant secrets live in the Pipee protected secret storage.</p>

        <h2>Connected Pipee clients</h2>
        <?php if ($grants === []): ?>
            <p>No Pipee clients are connected yet.</p>
        <?php else: ?>
            <table class="widefat striped">
                <thead>
                    <tr>
                        <th>Client</th>
                        <th>Created</th>
                        <th>Last used</th>
                        <th>Status</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($grants as $grant): ?>
                        <tr>
                            <td><?php echo esc_html((string) $grant['client_label']); ?></td>
                            <td><?php echo esc_html((string) $grant['created_at']); ?></td>
                            <td><?php echo esc_html((string) ($grant['last_used_at'] ?? 'never')); ?></td>
                            <td><?php echo zeroy_connection_grant_is_revoked($grant) ? 'revoked' : 'active'; ?></td>
                            <td>
                                <?php if (!zeroy_connection_grant_is_revoked($grant)): ?>
                                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="display:inline">
                                        <?php wp_nonce_field('zeroy_connection_revoke'); ?>
                                        <input type="hidden" name="action" value="zeroy_connection_revoke" />
                                        <input type="hidden" name="grantId" value="<?php echo esc_attr((string) $grant['grant_id']); ?>" />
                                        <button type="submit" class="button button-link-delete">Revoke</button>
                                    </form>
                                <?php endif; ?>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>

        <h2>Connect to Pipee</h2>
        <p>Create a short-lived pairing intent. The code is single-use and expires in 10 minutes; it is not a persistent credential.</p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="card">
            <?php wp_nonce_field('zeroy_connection_pair'); ?>
            <input type="hidden" name="action" value="zeroy_connection_pair" />
            <p>
                <label>Pipee callback URL (defaults to the local Pipee callback):</label><br />
                <input type="url" name="redirectUri" value="http://127.0.0.1:30141/zeroy/connect/callback" class="regular-text" />
            </p>
            <button type="submit" class="button button-primary">Create pairing code</button>
        </form>

        <p><a href="<?php echo esc_url(zeroy_review_admin_url()); ?>">Back to zeroY Agent review</a></p>
    </div>
    <?php
}

function zeroy_connection_admin_menu(): void
{
    add_submenu_page(
        ZEROY_SITE_REVIEW_ADMIN_SLUG,
        'zeroY connections',
        'Connections',
        ZEROY_PREVIEW_CAPABILITY,
        ZEROY_CONNECTION_ADMIN_SLUG,
        'zeroy_connection_admin_page',
    );
}

add_action('admin_menu', 'zeroy_connection_admin_menu');
add_action('admin_post_zeroy_connection_revoke', 'zeroy_connection_admin_revoke');
add_action('admin_post_zeroy_connection_pair', 'zeroy_connection_admin_begin_pairing');
