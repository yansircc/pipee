<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_REVIEW_ADMIN_SLUG = 'zeroy-agent-review';

function zeroy_review_admin_url(array $arguments = []): string
{
    return add_query_arg(['page' => ZEROY_SITE_REVIEW_ADMIN_SLUG, ...$arguments], admin_url('admin.php'));
}

function zeroy_review_admin_require_capability(): void
{
    if (!current_user_can(ZEROY_PREVIEW_CAPABILITY)) wp_die('You do not have permission to manage zeroY releases.', 'Forbidden', ['response' => 403]);
}

function zeroy_review_admin_notice(string $kind, string $message): void
{
    $class = $kind === 'error' ? 'notice-error' : 'notice-success';
    printf('<div class="notice %s"><p>%s</p></div>', esc_attr($class), esc_html($message));
}

function zeroy_review_admin_save_brief(): void
{
    zeroy_review_admin_require_capability();
    check_admin_referer('zeroy_review_save_brief');
    $stored = zeroy_review_set_brief((string) wp_unslash($_POST['prompt'] ?? ''));
    $arguments = is_wp_error($stored)
        ? ['zeroy_notice' => 'brief-error', 'message' => $stored->get_error_message()]
        : ['zeroy_notice' => 'brief-saved'];
    wp_safe_redirect(zeroy_review_admin_url($arguments));
    exit;
}

function zeroy_review_admin_publish(): void
{
    zeroy_review_admin_require_capability();
    check_admin_referer('zeroy_review_publish');
    $release_id = isset($_POST['releaseId']) ? sanitize_text_field(wp_unslash($_POST['releaseId'])) : '';
    $released = zeroy_runtime_activate_site_release($release_id);
    $arguments = is_wp_error($released)
        ? ['zeroy_notice' => 'publish-error', 'message' => $released->get_error_message()]
        : ['zeroy_notice' => 'published', 'release' => $release_id];
    wp_safe_redirect(zeroy_review_admin_url($arguments));
    exit;
}

function zeroy_review_admin_current(): array
{
    $ref = zeroy_review_latest_ref_for_owner(zeroy_checkout_owner_principal());
    $commit = is_array($ref) ? (string) $ref['commit_hash'] : null;
    $review = is_string($commit) ? zeroy_review_for_commit($commit) : null;
    $preview = is_array($review) && is_string($review['releaseId'] ?? null)
        ? zeroy_runtime_site_release_row($review['releaseId'])
        : null;
    return [
        'brief' => zeroy_review_brief_projection(),
        'ref' => $ref,
        'commit' => $commit,
        'review' => is_wp_error($review) ? null : $review,
        'reviewError' => is_wp_error($review) ? $review->get_error_message() : null,
        'preview' => $preview,
        'active' => zeroy_runtime_active_site_release(),
    ];
}

function zeroy_review_admin_release_label(?array $release): string
{
    if ($release === null) return 'None';
    return sprintf('%s · %s', (string) $release['release_id'], (string) $release['state']);
}

function zeroy_review_admin_page(): void
{
    zeroy_review_admin_require_capability();
    $current = zeroy_review_admin_current();
    $brief = $current['brief'];
    $review = $current['review'];
    $preview = $current['preview'];
    $notice = isset($_GET['zeroy_notice']) ? sanitize_key((string) $_GET['zeroy_notice']) : '';
    $message = isset($_GET['message']) ? sanitize_text_field((string) $_GET['message']) : '';
    ?>
    <div class="wrap">
        <h1>zeroY Agent review</h1>
        <?php
        if ($notice === 'brief-saved') zeroy_review_admin_notice('success', 'Site Brief saved. The latest Commit will be reviewed against this new intent.');
        if ($notice === 'published') zeroy_review_admin_notice('success', 'The proof-ready PreviewRelease is now the public ActiveRelease.');
        if (in_array($notice, ['brief-error', 'publish-error'], true)) zeroy_review_admin_notice('error', $message !== '' ? $message : 'The requested action failed.');
        ?>

        <h2>Administrator Brief</h2>
        <p>The Brief is the publication boundary owned by an administrator. The Agent can read it, but cannot change it.</p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <?php wp_nonce_field('zeroy_review_save_brief'); ?>
            <input type="hidden" name="action" value="zeroy_review_save_brief" />
            <textarea name="prompt" rows="12" class="large-text" required><?php echo esc_textarea(is_array($brief['brief'] ?? null) ? (string) ($brief['brief']['prompt'] ?? '') : ''); ?></textarea>
            <p><button type="submit" class="button button-primary">Save Brief</button>
            <?php if (is_string($brief['briefHash'] ?? null)): ?><code><?php echo esc_html($brief['briefHash']); ?></code><?php endif; ?></p>
        </form>

        <h2>Current Agent result</h2>
        <table class="widefat striped" style="max-width: 1100px">
            <tbody>
                <tr><th scope="row">DraftRef</th><td><?php echo esc_html(is_array($current['ref']) ? (string) $current['ref']['ref_name'] : 'None'); ?></td></tr>
                <tr><th scope="row">Commit</th><td><code><?php echo esc_html((string) ($current['commit'] ?? 'None')); ?></code></td></tr>
                <tr><th scope="row">PreviewRelease</th><td><?php echo esc_html(zeroy_review_admin_release_label($preview)); ?></td></tr>
                <tr><th scope="row">Public ActiveRelease</th><td><?php echo esc_html(zeroy_review_admin_release_label($current['active'])); ?></td></tr>
                <tr><th scope="row">Review</th><td><?php echo esc_html(is_array($review) ? (string) $review['state'] . ' · ' . (string) $review['remainingCount'] . ' blocking actions remaining' : ($current['reviewError'] ?? 'No Agent Commit yet.')); ?></td></tr>
            </tbody>
        </table>

        <?php if ($preview !== null): ?>
            <p><a class="button" target="_blank" rel="noreferrer" href="<?php echo esc_url(zeroy_runtime_admin_preview_url((string) $preview['release_id'])); ?>">View latest private preview</a></p>
        <?php endif; ?>

        <?php if (is_array($review) && is_array($review['next'] ?? null) && $review['next'] !== []): ?>
            <h2>Next evidence-backed gaps</h2>
            <ol>
                <?php foreach ($review['next'] as $action): ?>
                    <li>
                        <strong><?php echo esc_html((string) ($action['summary'] ?? 'review action')); ?></strong><br />
                        <span><?php echo esc_html((string) ($action['evidence'] ?? '')); ?></span><br />
                        <em><?php echo esc_html((string) ($action['repair'] ?? '')); ?></em>
                    </li>
                <?php endforeach; ?>
            </ol>
        <?php endif; ?>

        <h2>Final publication</h2>
        <?php
        $publishable = $preview !== null
            && ($preview['state'] ?? null) === 'proof-ready'
            && zeroy_review_proof_ready_for_release($preview);
        if ($publishable):
        ?>
            <p>This exact PreviewRelease has a current matching Brief, Review and Proof. Publishing is atomic; anonymous visitors will then see it.</p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <?php wp_nonce_field('zeroy_review_publish'); ?>
                <input type="hidden" name="action" value="zeroy_review_publish" />
                <input type="hidden" name="releaseId" value="<?php echo esc_attr((string) $preview['release_id']); ?>" />
                <button type="submit" class="button button-primary">Publish this proof-ready version</button>
            </form>
        <?php else: ?>
            <p>No current PreviewRelease is eligible for public publication. Agent Pushes remain private until the exact version is proof-ready.</p>
        <?php endif; ?>
    </div>
    <?php
}

function zeroy_review_admin_menu(): void
{
    add_menu_page('zeroY Agent review', 'zeroY review', ZEROY_PREVIEW_CAPABILITY, ZEROY_SITE_REVIEW_ADMIN_SLUG, 'zeroy_review_admin_page', 'dashicons-admin-site-alt3', 58);
}

add_action('admin_menu', 'zeroy_review_admin_menu');
add_action('admin_post_zeroy_review_save_brief', 'zeroy_review_admin_save_brief');
add_action('admin_post_zeroy_review_publish', 'zeroy_review_admin_publish');
