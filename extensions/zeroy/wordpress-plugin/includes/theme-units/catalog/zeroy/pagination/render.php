<?php

namespace ZeroY\ThemeUnit\Pagination;

function render(array $pages, string $label): string
{
    $links = '';
    foreach ($pages as $page) {
        if (!is_array($page) || !is_string($page['label'] ?? null) || !is_string($page['url'] ?? null)) continue;
        $current = ($page['current'] ?? false) === true ? ' aria-current="page"' : '';
        $links .= '<li><a href="' . htmlspecialchars($page['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"' . $current . '>' . htmlspecialchars($page['label'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</a></li>';
    }
    return '<nav aria-label="' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"><ul>' . $links . '</ul></nav>';
}
