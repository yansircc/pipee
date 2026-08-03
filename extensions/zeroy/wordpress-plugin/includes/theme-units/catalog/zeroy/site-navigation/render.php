<?php

namespace ZeroY\ThemeUnit\SiteNavigation;

function render(array $items, string $label): string
{
    $links = '';
    foreach ($items as $item) {
        if (!is_array($item) || !is_string($item['label'] ?? null) || !is_string($item['url'] ?? null)) continue;
        $current = ($item['current'] ?? false) === true ? ' aria-current="page"' : '';
        $links .= '<li><a href="' . htmlspecialchars($item['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"' . $current . '>' . htmlspecialchars($item['label'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</a></li>';
    }
    return '<nav aria-label="' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"><ul>' . $links . '</ul></nav>';
}
