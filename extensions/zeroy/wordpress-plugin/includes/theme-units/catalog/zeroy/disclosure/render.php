<?php

namespace ZeroY\ThemeUnit\Disclosure;

function render(string $summary, string $content, bool $open = false): string
{
    return '<details data-zeroy-unit="zeroy/disclosure" data-zeroy-behavior="disclosure" data-zeroy-surface' . ($open ? ' open' : '') . '><summary data-zeroy-trigger>' . htmlspecialchars($summary, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</summary><div>' . $content . '</div></details>';
}
