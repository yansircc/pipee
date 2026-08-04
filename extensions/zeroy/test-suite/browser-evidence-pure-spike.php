<?php

define('ABSPATH', __DIR__ . '/');

function zeroy_runtime_is_keyed_map(mixed $value): bool
{
    return is_array($value) && !array_is_list($value);
}

require_once dirname(__DIR__) . '/wordpress-plugin/includes/site-release/browser-evidence.php';

function browser_evidence_spike_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function browser_evidence_spike_result(): array
{
    return [
        'scenario' => 'front-page:en:root',
        'viewport' => 'mobile',
        'status' => 200,
        'routeKind' => 'front-page',
        'stylesheetIdentity' => 'identity',
        'stylesheets' => ['https://example.test/assets/site.css'],
        'documentClientWidth' => 360,
        'documentScrollWidth' => 360,
        'overflowElements' => 0,
        'overflowSamples' => [],
        'mediaOverflowElements' => 0,
        'mediaOverflowSamples' => [],
        'focusVisible' => true,
        'reducedMotion' => true,
        'contrastRatios' => ['surface' => 8.2],
        'visibleTextContrastFailures' => 0,
        'visibleTextContrastSamples' => [],
        'visibleTextContrastIndeterminate' => 0,
        'visibleTextContrastIndeterminateSamples' => [],
        'renderedFields' => ['/acf/field_machine_capacity'],
    ];
}

browser_evidence_spike_assert(zeroy_runtime_browser_result_invalid_fields(browser_evidence_spike_result()) === [], 'Valid browser result did not pass the exact measurement contract.');

$invalid = browser_evidence_spike_result();
$invalid['documentClientWidth'] = 0;
$invalid['visibleTextContrastFailures'] = 2;
$invalid['visibleTextContrastSamples'] = [];
$invalid['contrastRatios'] = ['surface' => -1];
$invalid['renderedFields'] = ['machine_capacity'];
browser_evidence_spike_assert(
    zeroy_runtime_browser_result_invalid_fields($invalid) === ['documentClientWidth', 'contrastRatios', 'visibleTextContrastSamples', 'renderedFields'],
    'Browser measurement diagnostics did not identify the invalid fields deterministically.',
);

fwrite(STDOUT, "zeroY browser evidence measurement spike passed.\n");
