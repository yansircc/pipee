<?php

defined('ABSPATH') || exit;

function zeroy_fixture_product_selection_evaluate(array $input): array
{
    $throughput = (float) $input['throughputKgPerHour'];
    return [
        'tier' => $throughput <= 500 ? 'compact' : ($throughput <= 2000 ? 'production' : 'industrial'),
        'minimumCapacityKgPerHour' => $throughput,
        'material' => sanitize_text_field((string) ($input['material'] ?? '')),
    ];
}

function zeroy_fixture_rfq_submit(array $input): array
{
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_site_logic_table_name('rfqs'), [
        'name' => sanitize_text_field((string) $input['name']),
        'email' => sanitize_email((string) $input['email']),
        'message' => sanitize_textarea_field((string) $input['message']),
        'status' => 'received',
        'created_at' => current_time('mysql', true),
    ]);
    if ($written !== 1) throw new RuntimeException($wpdb->last_error ?: 'rfq_write_failed');
    return ['rfqId' => (int) $wpdb->insert_id, 'status' => 'received'];
}

zeroy_register_site_logic_capability('product-selection.evaluate', '1', 'zeroy_fixture_product_selection_evaluate');
zeroy_register_site_logic_capability('rfq.submit', '1', 'zeroy_fixture_rfq_submit');
