<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_link_js(array $units, array $order): ?string
{
    $imports = [];
    foreach ($order as $id) foreach ($units[$id]['scripts'] as $path) $imports[] = "import './vendor/" . zeroy_theme_units_vendor_segment($id) . '/' . str_replace("'", "\\'", $path) . "';";
    return $imports === [] ? null : implode("\n", $imports) . "\n";
}
