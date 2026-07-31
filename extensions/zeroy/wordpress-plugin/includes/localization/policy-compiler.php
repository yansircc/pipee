<?php

defined('ABSPATH') || exit;

function zeroy_localization_compiled_policy(array $definition): array|WP_Error
{
    $policy = $definition['localization'] ?? null;
    if (!is_array($policy) || ($policy['contract'] ?? null) !== zeroy_localization_policy_contract()) {
        return zeroy_runtime_error('zeroy_localization_policy_missing', 'ThemeSchema does not declare a valid localization policy.', 409);
    }
    $rules = [];
    foreach ($policy['rules'] ?? [] as $rule) {
        if (!is_array($rule) || !is_string($rule['fieldPattern'] ?? null)) {
            return zeroy_runtime_error('zeroy_localization_policy_invalid', 'Active localization policy is malformed.', 409);
        }
        $parts = zeroy_localization_policy_pattern($rule['fieldPattern']);
        if (is_wp_error($parts)) {
            return $parts;
        }
        $rules[] = [...$rule, 'parts' => $parts];
    }
    return [
        'contract' => zeroy_localization_policy_contract(),
        'rules' => $rules,
        'repeaterItemKeys' => is_array($policy['repeaterItemKeys'] ?? null) ? $policy['repeaterItemKeys'] : [],
        'hash' => zeroy_runtime_hash([
            'contract' => zeroy_localization_policy_contract(),
            'rules' => array_map(static fn(array $rule): array => [
                'fieldPattern' => $rule['fieldPattern'],
                'mode' => $rule['mode'],
                'required' => (bool) ($rule['required'] ?? false),
                'contextWeight' => $rule['contextWeight'] ?? 'supporting',
            ], $rules),
            'repeaterItemKeys' => $policy['repeaterItemKeys'] ?? [],
            'templateContent' => $definition['templateContent'] ?? [],
        ]),
    ];
}

function zeroy_localization_rule_for_field(array $policy, string $field_id): array|WP_Error
{
    $parts = zeroy_localization_pointer_parts($field_id);
    if (is_wp_error($parts)) {
        return $parts;
    }
    $matches = [];
    foreach ($policy['rules'] as $rule) {
        $recursive = end($rule['parts']) === '**';
        $length = count($rule['parts']) - ($recursive ? 1 : 0);
        if (($recursive && count($parts) < $length) || (!$recursive && count($parts) !== $length)) {
            continue;
        }
        $matches_rule = true;
        foreach (array_slice($parts, 0, $length) as $index => $part) {
            if ($rule['parts'][$index] !== '*' && $rule['parts'][$index] !== $part) {
                $matches_rule = false;
                break;
            }
        }
        if ($matches_rule) {
            $matches[] = $rule;
        }
    }
    if ($matches === []) {
        return zeroy_runtime_error(
            'zeroy_localization_field_unclassified',
            "Canonical field {$field_id} has no LocalizationPolicy rule.",
            409,
            ['fieldId' => $field_id]
        );
    }
    usort($matches, static function (array $left, array $right): int {
        $left_rank = zeroy_localization_policy_specificity($left['parts']);
        $right_rank = zeroy_localization_policy_specificity($right['parts']);
        foreach ($left_rank as $index => $value) {
            if ($value !== $right_rank[$index]) {
                return $right_rank[$index] <=> $value;
            }
        }
        return 0;
    });
    $winner = $matches[0];
    $winner_rank = zeroy_localization_policy_specificity($winner['parts']);
    $ties = array_values(array_filter($matches, static fn(array $rule): bool => zeroy_localization_policy_specificity($rule['parts']) === $winner_rank));
    return count($ties) === 1
        ? $winner
        : zeroy_runtime_error(
            'zeroy_localization_field_ambiguous',
            "Canonical field {$field_id} matches equally-specific LocalizationPolicy rules.",
            409,
            ['fieldId' => $field_id, 'matches' => array_column($ties, 'fieldPattern')]
        );
}


function zeroy_localization_compile_subject_policy(array $subject, array $definition): array|WP_Error
{
    $policy = zeroy_localization_compiled_policy($definition);
    if (is_wp_error($policy)) {
        return $policy;
    }
    $fields = zeroy_localization_field_map($subject);
    if (is_wp_error($fields)) {
        return $fields;
    }
    $violations = [];
    foreach ($fields as $field_id => $field) {
        $field_policy = $field['localization'] ?? null;
        $rule = is_array($field_policy) ? $field_policy : zeroy_localization_rule_for_field($policy, $field_id);
        if (is_wp_error($rule)) {
            $violations[] = [
                'code' => $rule->get_error_code(),
                'fieldId' => $field_id,
                'message' => $rule->get_error_message(),
            ];
            continue;
        }
        if (!is_array($rule)) {
            $violations[] = ['code' => 'zeroy_localization_field_policy_invalid', 'fieldId' => $field_id, 'message' => "Field {$field_id} has no valid LocalizationPolicy."];
            continue;
        }
        $fields[$field_id]['policy'] = [
            'mode' => $rule['mode'],
            'required' => (bool) ($rule['required'] ?? false),
            'contextWeight' => $rule['contextWeight'] ?? 'supporting',
        ];
    }
    if ($violations !== []) {
        return zeroy_runtime_error('zeroy_localization_policy_incomplete', 'LocalizationPolicy does not classify every canonical field.', 409, ['violations' => $violations]);
    }
    return ['policy' => $policy, 'fields' => $fields];
}
