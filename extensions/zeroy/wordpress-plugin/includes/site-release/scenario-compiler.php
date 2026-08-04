<?php

defined('ABSPATH') || exit;

function zeroy_runtime_candidate_scenario_url(string $candidate_kind, string $candidate_id, array $scenario): string
{
    if (!in_array($candidate_kind, ['build', 'release'], true)) {
        throw new InvalidArgumentException('Candidate kind must be build or release.');
    }
    if ($candidate_kind === 'release') {
        return add_query_arg([
            'zeroy_evidence_release' => $candidate_id,
            'token' => zeroy_runtime_evidence_access_token($candidate_id),
            ...($scenario['query'] ?? []),
        ], home_url($scenario['path']));
    }
    $token_subject = $candidate_kind . ':' . $candidate_id;
    return add_query_arg([
        'zeroy_candidate_' . $candidate_kind => $candidate_id,
        'token' => hash_hmac('sha256', $token_subject, zeroy_runtime_connection_key()),
        ...($scenario['query'] ?? []),
    ], home_url($scenario['path']));
}
