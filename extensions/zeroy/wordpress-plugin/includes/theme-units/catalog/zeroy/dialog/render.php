<?php

namespace ZeroY\ThemeUnit\Dialog;

function render(string $id, string $label, string $content, string $close_label): string
{
    $safe_id = preg_replace('/[^A-Za-z0-9_-]/', '-', $id) ?: 'zeroy-dialog';
    return '<span data-zeroy-unit="zeroy/dialog" data-zeroy-behavior="dialog"><button type="button" data-zeroy-trigger aria-haspopup="dialog" aria-controls="' . htmlspecialchars($safe_id, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '">' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</button><dialog id="' . htmlspecialchars($safe_id, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '" data-zeroy-surface aria-label="' . htmlspecialchars($label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"><div>' . $content . '</div><button type="button" data-zeroy-close>' . htmlspecialchars($close_label, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</button></dialog></span>';
}
