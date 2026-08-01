<?php

defined('ABSPATH') || exit;

function zeroy_runtime_candidate_scenario_url(string $release_id, array $scenario): string
{
    $token = hash_hmac('sha256', $release_id, zeroy_runtime_connection_key());
    return add_query_arg([
        'zeroy_candidate_release' => $release_id,
        'token' => $token,
        ...($scenario['query'] ?? []),
    ], home_url($scenario['path']));
}
