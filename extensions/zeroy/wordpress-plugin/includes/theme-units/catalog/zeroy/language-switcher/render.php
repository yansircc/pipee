<?php

namespace ZeroY\ThemeUnit\LanguageSwitcher;

function render(array $alternates, string $label): string
{
    $links = '';
    foreach ($alternates as $alternate) {
        if (!is_array($alternate) || !is_string($alternate['locale'] ?? null) || !is_string($alternate['label'] ?? null) || !is_string($alternate['url'] ?? null)) continue;
        $current = ($alternate['current'] ?? false) === true ? ' aria-current="page"' : '';
        $links .= '<li><a hreflang="' . htmlspecialchars($alternate['locale'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" lang="' . htmlspecialchars($alternate['locale'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" href="' . htmlspecialchars($alternate['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"' . $current . '>' . htmlspecialchars($alternate['label'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</a></li>';
    }
    return '<nav aria-label="' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"><ul>' . $links . '</ul></nav>';
}
