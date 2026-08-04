<?php

define('ABSPATH', __DIR__ . '/');

function wp_strip_all_tags(string $value, bool $remove_breaks = false): string
{
    $result = strip_tags($value);
    return $remove_breaks ? preg_replace('/\\s+/', ' ', $result) : $result;
}

require_once dirname(__DIR__) . '/wordpress-plugin/includes/site-release/candidate-runtime.php';

function candidate_runtime_spike_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$warning = zeroy_runtime_candidate_php_error("<br />\n<b>Warning</b>: Array to string conversion in <b>/Users/example/Local Sites/zeroY/app/public/wp-content/themes/agent/functions.php</b> on line <b>155</b><br />\n");
candidate_runtime_spike_assert(is_array($warning), 'Formatted WordPress warning was not recognized.');
candidate_runtime_spike_assert(($warning['file'] ?? null) === 'functions.php', 'Host path was not reduced to a filename.');
candidate_runtime_spike_assert(($warning['line'] ?? null) === 155, 'PHP warning line was not retained.');
candidate_runtime_spike_assert(($warning['evidence'] ?? null) === 'PHP warning: Array to string conversion at functions.php:155.', 'PHP warning evidence is not bounded and actionable.');
candidate_runtime_spike_assert(!str_contains((string) $warning['evidence'], '/Users/'), 'PHP warning evidence leaked a host path.');

$fatal = zeroy_runtime_candidate_php_error('Fatal error: Uncaught Error: Failed opening required /private/secret/bootstrap.php in /var/www/html/wp-content/themes/agent/front-page.php on line 18');
candidate_runtime_spike_assert(is_array($fatal), 'Fatal PHP error was not recognized.');
candidate_runtime_spike_assert(($fatal['file'] ?? null) === 'front-page.php', 'Fatal PHP error did not retain the authored filename.');
candidate_runtime_spike_assert(($fatal['line'] ?? null) === 18, 'Fatal PHP error did not retain the authored line.');
candidate_runtime_spike_assert(!str_contains((string) $fatal['evidence'], '/private/secret'), 'Embedded absolute path leaked through PHP evidence.');

$plain = zeroy_runtime_candidate_php_error('Warning: Extension feature is unavailable.');
candidate_runtime_spike_assert(is_array($plain), 'Unlocated PHP warning was not recognized.');
candidate_runtime_spike_assert(!isset($plain['file']) && !isset($plain['line']), 'Unlocated PHP warning invented a location.');
candidate_runtime_spike_assert(zeroy_runtime_candidate_php_error('<main><p>Warning signs are posted near equipment.</p></main>') === null, 'Ordinary website copy was mistaken for a PHP error.');

fwrite(STDOUT, "zeroY candidate PHP diagnostic projection spike passed.\n");
