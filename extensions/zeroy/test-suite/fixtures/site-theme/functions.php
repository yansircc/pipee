<?php
/**
 * zeroY MVP theme bootstrap.
 */

defined('ABSPATH') || exit;

function zeroy_site_release_fixture_assets(): void
{
    wp_enqueue_style(
        'zeroy-site-release-acceptance-fixture',
        get_stylesheet_uri(),
        [],
        (string) filemtime(get_stylesheet_directory() . '/style.css')
    );
}
add_action('wp_enqueue_scripts', 'zeroy_site_release_fixture_assets');

add_action('after_setup_theme', static function (): void {
    add_theme_support('title-tag');
});
