<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_vendor_segment(string $id): string
{
    return str_replace('/', '--', $id);
}

function zeroy_theme_units_link_php(array $units, array $order): ?string
{
    $lines = ["<?php", '', "defined('ABSPATH') || exit;", ''];
    $count = 0;
    foreach ($order as $id) foreach (($units[$id]['php']['entrypoints'] ?? []) as $path) {
        $relative = 'vendor/' . zeroy_theme_units_vendor_segment($id) . '/' . $path;
        $lines[] = "require_once __DIR__ . '/" . str_replace("'", "\\'", $relative) . "';";
        $count++;
    }
    return $count === 0 ? null : implode("\n", $lines) . "\n";
}
