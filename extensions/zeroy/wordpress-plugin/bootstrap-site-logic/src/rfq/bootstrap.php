<?php

defined('ABSPATH') || exit;

zeroy_register_site_logic_capability('rfq.submit', '1', static function (array $input): array {
    global $wpdb;
    $written = $wpdb->insert(zeroy_runtime_site_logic_table_name('rfqs'), [
        'name' => sanitize_text_field((string) $input['name']),
        'email' => sanitize_email((string) $input['email']),
        'message' => sanitize_textarea_field((string) $input['message']),
        'status' => 'received',
        'created_at' => current_time('mysql', true),
    ]);
    if ($written !== 1) {
        throw new RuntimeException($wpdb->last_error ?: 'rfq_write_failed');
    }
    return ['rfqId' => (int) $wpdb->insert_id, 'status' => 'received'];
});
