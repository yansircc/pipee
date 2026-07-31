<?php

defined('ABSPATH') || exit;

function zeroy_runtime_begin_site_logic_effect_observation(): array
{
    $observed = [];
    $filter = static function (string $query) use (&$observed): string {
        $verb = strtoupper((string) strtok(ltrim($query), " \t\r\n"));
        if (in_array($verb, ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE'], true)) {
            $observed['write'] = true;
        } elseif (in_array($verb, ['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN'], true)) {
            $observed['read'] = true;
        }
        return $query;
    };
    add_filter('query', $filter, PHP_INT_MAX);
    return ['filter' => $filter, 'observed' => &$observed];
}

function zeroy_runtime_end_site_logic_effect_observation(array $observation): array
{
    remove_filter('query', $observation['filter'], PHP_INT_MAX);
    $effects = array_keys($observation['observed']);
    sort($effects, SORT_STRING);
    return $effects;
}
