<?php

define('ABSPATH', __DIR__ . '/');

final class WP_Error
{
    public function __construct(public readonly string $code, public readonly string $message) {}
}

function is_wp_error(mixed $value): bool
{
    return $value instanceof WP_Error;
}

function zeroy_runtime_error(string $code, string $message): WP_Error
{
    return new WP_Error($code, $message);
}

function wp_json_encode(mixed $value, int $flags = 0): string|false
{
    return json_encode($value, $flags);
}

require_once dirname(__DIR__) . '/wordpress-plugin/includes/site-checkout/canonical.php';

function zeroy_site_object_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$fixture = json_decode((string) file_get_contents(__DIR__ . '/fixtures/site-objects.json'), true, 512, JSON_THROW_ON_ERROR);
zeroy_site_object_assert(zeroy_checkout_blob_hash($fixture['blobText']) === $fixture['blobHash'], 'PHP blob hash diverged from the shared fixture.');
zeroy_site_object_assert(zeroy_checkout_tree_hash($fixture['treeEntries']) === $fixture['treeHash'], 'PHP tree hash diverged from the shared fixture.');
zeroy_site_object_assert(zeroy_checkout_commit_hash($fixture['commit']) === $fixture['commitHash'], 'PHP commit hash diverged from the shared fixture.');
zeroy_site_object_assert(zeroy_checkout_push_request_hash($fixture['pushRequest']) === $fixture['pushRequestHash'], 'PHP push request hash diverged from the shared fixture.');
fwrite(STDOUT, "zeroY SiteObject TS/PHP canonical vectors passed.\n");
