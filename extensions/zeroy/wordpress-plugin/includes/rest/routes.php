<?php

defined('ABSPATH') || exit;

function zeroy_runtime_integrity_endpoint(): WP_REST_Response
{
    return new WP_REST_Response(['contract' => 'zeroy/integrity@1', ...zeroy_runtime_integrity()]);
}

function zeroy_runtime_register_rest_routes(): void
{
    $permission = ['permission_callback' => 'zeroy_runtime_authorized'];
    register_rest_route('zeroy/v1', '/site', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_site_endpoint']);
    register_rest_route('zeroy/v1', '/schema', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_schema_endpoint']);
    register_rest_route('zeroy/v1', '/inventory', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_inventory_endpoint']);
    register_rest_route('zeroy/v1', '/acf', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_acf_endpoint']);
    register_rest_route('zeroy/v1', '/zcss-contract', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_zcss_contract_endpoint']);
    register_rest_route('zeroy/v1', '/adoption-candidates', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_adoption_candidates_endpoint']);
    register_rest_route('zeroy/v1', '/existing-post', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_existing_post_endpoint']);
    register_rest_route('zeroy/v1', '/canonical-content', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_canonical_content_endpoint']);
    register_rest_route('zeroy/v1', '/translation-job', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_translation_job_endpoint']);
    register_rest_route('zeroy/v1', '/integrity', $permission + ['methods' => WP_REST_Server::READABLE, 'callback' => 'zeroy_runtime_integrity_endpoint']);
}
add_action('rest_api_init', 'zeroy_runtime_register_rest_routes');
