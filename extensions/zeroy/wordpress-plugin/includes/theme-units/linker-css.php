<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_link_css(array $units, array $order): ?string
{
    $chunks = [];
    foreach ($order as $id) foreach ($units[$id]['styles'] as $path) {
        $files = array_column($units[$id]['files'], null, 'path');
        $chunks[] = "/* ThemeUnit " . $id . ' · ' . $path . " */\n" . rtrim($files[$path]['bytes'], "\r\n") . "\n";
    }
    return $chunks === [] ? null : implode("\n", $chunks);
}
