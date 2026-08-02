<?php

/**
 * Plugin Name: zeroY ZCSS Agent acceptance facts
 * Description: Disposable WordPress/ACF facts for the remote-only Agent dogfood.
 * Version: 1.0.0
 */

defined('ABSPATH') || exit;

add_action('init', static function (): void {
    register_post_type('machine', [
        'label' => 'Machines',
        'public' => true,
        'show_in_rest' => true,
        'has_archive' => true,
        'rewrite' => ['slug' => 'machines'],
        'supports' => ['title', 'editor', 'excerpt'],
    ]);
    register_taxonomy('machine_family', ['machine'], [
        'label' => 'Machine families',
        'public' => true,
        'show_in_rest' => true,
        'rewrite' => ['slug' => 'machine-family'],
    ]);
});

add_action('acf/include_fields', static function (): void {
    if (!function_exists('acf_add_local_field_group')) return;
    acf_add_local_field_group([
        'key' => 'group_zeroy_zcss_agent_machine',
        'title' => 'Machine facts',
        'fields' => [
            [
                'key' => 'field_zeroy_machine_summary',
                'label' => 'Summary',
                'name' => 'machine_summary',
                'type' => 'textarea',
                'required' => 0,
            ],
            [
                'key' => 'field_zeroy_machine_capacity',
                'label' => 'Capacity',
                'name' => 'machine_capacity',
                'type' => 'text',
                'required' => 0,
            ],
        ],
        'location' => [[[
            'param' => 'post_type',
            'operator' => '==',
            'value' => 'machine',
        ]]],
    ]);
});
