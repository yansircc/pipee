<?php

defined('ABSPATH') || exit;

/** The web SAPI binary may be php-fpm; Artifact linting requires PHP CLI. */
function zeroy_runtime_php_cli_binary(): ?string
{
    static $resolved = false;
    static $binary = null;
    if ($resolved) {
        return $binary;
    }
    $resolved = true;
    $candidates = array_values(array_unique([
        preg_match('/^php(?:\\.exe)?$/i', basename(PHP_BINARY)) === 1 ? PHP_BINARY : '',
        PHP_BINDIR . '/php',
        dirname(PHP_BINDIR) . '/bin/php',
        'php',
    ]));
    foreach ($candidates as $candidate) {
        if ($candidate === '') {
            continue;
        }
        $process = @proc_open([$candidate, '-v'], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            continue;
        }
        fclose($pipes[0]);
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        if (proc_close($process) === 0) {
            $binary = $candidate;
            return $binary;
        }
    }
    return null;
}

function zeroy_runtime_php_lint(string $path): ?array
{
    $binary = zeroy_runtime_php_cli_binary();
    if ($binary === null) {
        return ['code' => 'php_lint_unavailable', 'message' => 'Connector could not find a PHP CLI binary for syntax validation.'];
    }
    $process = proc_open([$binary, '-l', $path], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
    if (!is_resource($process)) {
        return ['code' => 'php_lint_unavailable', 'message' => 'Connector could not run PHP syntax validation.'];
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return proc_close($process) === 0
        ? null
        : ['code' => 'php_syntax_invalid', 'message' => trim($stderr !== '' ? $stderr : $stdout)];
}
