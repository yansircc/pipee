<?php

namespace ZeroY\ThemeUnit\Breadcrumb;

function render(array $items, string $label): string
{
    $parts = '';
    $last = count($items) - 1;
    foreach (array_values($items) as $index => $item) {
        if (!is_array($item) || !is_string($item['label'] ?? null)) continue;
        $text = htmlspecialchars($item['label'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $content = $index === $last || !is_string($item['url'] ?? null) ? '<span aria-current="page">' . $text . '</span>' : '<a href="' . htmlspecialchars($item['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">' . $text . '</a>';
        $parts .= '<li>' . $content . '</li>';
    }
    return '<nav aria-label="' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"><ol>' . $parts . '</ol></nav>';
}
