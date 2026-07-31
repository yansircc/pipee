<?php

defined('ABSPATH') || exit;

function zeroy_runtime_schema_violation(array &$errors, string $code, string $message, array $context = []): void
{
    $errors[] = ['code' => $code, 'message' => $message, ...$context];
}
