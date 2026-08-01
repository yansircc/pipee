<?php

defined('ABSPATH') || exit;

function zeroy_localization_policy_contract(): string
{
    return 'zeroy/localization-policy@1';
}

function zeroy_localization_field_policy_modes(): array
{
    return ['shared', 'translated', 'overridable', 'derived'];
}

function zeroy_localization_field_policy_context_weights(): array
{
    return ['primary', 'supporting', 'hidden'];
}

function zeroy_localization_policy_pattern(string $pattern): array|WP_Error
{
    if ($pattern === '' || $pattern[0] !== '/') {
        return zeroy_runtime_error('zeroy_localization_policy_invalid', 'fieldPattern must be a JSON-pointer pattern.', 409);
    }
    $parts = zeroy_localization_pointer_parts($pattern);
    if (is_wp_error($parts) || count($parts) < 2 || !in_array($parts[0], ['post', 'acf', 'term', 'menu', 'site-copy', 'media', 'template-content'], true)) {
        return zeroy_runtime_error('zeroy_localization_policy_invalid', "fieldPattern {$pattern} has an unsupported subject root.", 409);
    }
    foreach ($parts as $index => $part) {
        if ($part === '' || ($part !== '*' && $part !== '**' && str_contains($part, '*')) || ($part === '**' && $index !== count($parts) - 1)) {
            return zeroy_runtime_error('zeroy_localization_policy_invalid', "fieldPattern {$pattern} may only use * as a segment or a trailing ** suffix.", 409);
        }
    }
    return $parts;
}

function zeroy_localization_patterns_overlap(array $left, array $right): bool
{
    $left_recursive = end($left) === '**';
    $right_recursive = end($right) === '**';
    $left_count = count($left) - ($left_recursive ? 1 : 0);
    $right_count = count($right) - ($right_recursive ? 1 : 0);
    if (!$left_recursive && !$right_recursive && $left_count !== $right_count) {
        return false;
    }
    if ($left_recursive && $right_count < $left_count || $right_recursive && $left_count < $right_count) {
        return false;
    }
    foreach (range(0, min($left_count, $right_count) - 1) as $index) {
        if ($left[$index] !== '*' && $right[$index] !== '*' && $left[$index] !== $right[$index]) {
            return false;
        }
    }
    return true;
}

/**
 * Broad defaults and narrow exceptions belong to one pattern algebra. Literal
 * segments are more specific than wildcards; a finite path is more specific
 * than a trailing recursive suffix. Equal rank remains ambiguous by design.
 */
function zeroy_localization_policy_specificity(array $parts): array
{
    $literals = count(array_filter($parts, static fn(string $part): bool => $part !== '*' && $part !== '**'));
    $recursive = end($parts) === '**';
    return [$literals, $recursive ? 0 : 1, count($parts)];
}

/**
 * A field policy is the indivisible classification of one localizable fact.
 * Pattern policies reuse this decoder; TemplateContent uses it directly
 * because its fields are declared one-by-one by the authored template.
 */
function zeroy_localization_normalize_field_policy(mixed $input, array &$errors, array $context): ?array
{
    if (!is_array($input) || array_is_list($input)) {
        zeroy_runtime_schema_violation($errors, 'localization_field_policy_invalid', 'Localization field policy must be an object.', $context);
        return null;
    }
    $mode = $input['mode'] ?? null;
    $required = $input['required'] ?? false;
    $weight = $input['contextWeight'] ?? 'supporting';
    if (!in_array($mode, zeroy_localization_field_policy_modes(), true) || !is_bool($required) || !in_array($weight, zeroy_localization_field_policy_context_weights(), true)) {
        zeroy_runtime_schema_violation($errors, 'localization_field_policy_invalid', 'Localization field policy needs mode, boolean required, and contextWeight.', $context);
        return null;
    }
    if ($required && $mode !== 'translated') {
        zeroy_runtime_schema_violation($errors, 'localization_field_policy_required_invalid', 'required is only valid for translated fields.', $context);
        return null;
    }
    return ['mode' => $mode, 'required' => $required, 'contextWeight' => $weight];
}

function zeroy_localization_normalize_policy(mixed $input, array &$errors, array $context): ?array
{
    if (!is_array($input) || array_is_list($input) || ($input['contract'] ?? null) !== zeroy_localization_policy_contract()) {
        zeroy_runtime_schema_violation($errors, 'localization_policy_invalid', 'localization must use zeroy/localization-policy@1.', $context + ['field' => 'localization']);
        return null;
    }
    $rules = $input['rules'] ?? null;
    if (!is_array($rules) || !array_is_list($rules) || count($rules) === 0) {
        zeroy_runtime_schema_violation($errors, 'localization_rules_invalid', 'localization.rules must be a non-empty list.', $context + ['field' => 'localization.rules']);
        return null;
    }
    $normalized_rules = [];
    foreach ($rules as $index => $rule) {
        $rule_context = $context + ['field' => "localization.rules.{$index}"];
        if (!is_array($rule) || array_is_list($rule)) {
            zeroy_runtime_schema_violation($errors, 'localization_rule_invalid', 'Every localization rule must be an object.', $rule_context);
            continue;
        }
        $pattern = is_string($rule['fieldPattern'] ?? null) ? zeroy_localization_policy_pattern($rule['fieldPattern']) : zeroy_runtime_error('zeroy_localization_policy_invalid', 'fieldPattern must be a string.', 409);
        $field_policy = zeroy_localization_normalize_field_policy($rule, $errors, $rule_context);
        if (is_wp_error($pattern) || $field_policy === null) {
            if (is_wp_error($pattern)) {
                zeroy_runtime_schema_violation($errors, 'localization_rule_invalid', 'Localization rules need a valid fieldPattern, mode, optional boolean required, and contextWeight.', $rule_context);
            }
            continue;
        }
        foreach ($normalized_rules as $previous) {
            if (zeroy_localization_patterns_overlap($pattern, $previous['parts']) && zeroy_localization_policy_specificity($pattern) === zeroy_localization_policy_specificity($previous['parts'])) {
                zeroy_runtime_schema_violation($errors, 'localization_rule_ambiguous', "Localization pattern {$rule['fieldPattern']} overlaps equally with {$previous['fieldPattern']}.", $rule_context + ['conflictsWith' => $previous['fieldPattern']]);
            }
        }
        $normalized_rules[] = [
            'fieldPattern' => $rule['fieldPattern'],
            'parts' => $pattern,
            ...$field_policy,
        ];
    }
    $item_keys = $input['repeaterItemKeys'] ?? [];
    if (!zeroy_runtime_is_keyed_map($item_keys)) {
        zeroy_runtime_schema_violation($errors, 'localization_repeater_keys_invalid', 'localization.repeaterItemKeys must be a keyed object.', $context + ['field' => 'localization.repeaterItemKeys']);
        return null;
    }
    $normalized_keys = [];
    foreach ($item_keys as $field_id => $key_field) {
        if (!is_string($field_id) || !is_string($key_field) || $key_field === '' || $field_id === '' || $field_id[0] !== '/') {
            zeroy_runtime_schema_violation($errors, 'localization_repeater_key_invalid', 'Every repeater item key needs a field pointer and an ACF field key.', $context + ['field' => 'localization.repeaterItemKeys']);
            continue;
        }
        $normalized_keys[$field_id] = $key_field;
    }
    return count($normalized_rules) === count($rules)
        ? [
            'contract' => zeroy_localization_policy_contract(),
            'rules' => array_map(static fn(array $rule): array => [
                'fieldPattern' => $rule['fieldPattern'],
                'mode' => $rule['mode'],
                'required' => $rule['required'],
                'contextWeight' => $rule['contextWeight'],
            ], $normalized_rules),
            '_rules' => $normalized_rules,
            'repeaterItemKeys' => $normalized_keys,
        ]
        : null;
}
