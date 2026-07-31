<?php

defined('ABSPATH') || exit;

zeroy_register_site_logic_capability('product-selection.evaluate', '1', static function (array $input): array {
    $throughput = (float) $input['throughputKgPerHour'];
    $tier = $throughput <= 500 ? 'compact' : ($throughput <= 2000 ? 'production' : 'industrial');
    return [
        'tier' => $tier,
        'minimumCapacityKgPerHour' => $throughput,
        'material' => sanitize_text_field((string) ($input['material'] ?? '')),
    ];
});
