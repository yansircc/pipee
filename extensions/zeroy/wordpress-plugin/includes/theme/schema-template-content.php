<?php

defined('ABSPATH') || exit;

/**
 * TemplateContent is declared data consumed by hand-authored PHP templates.
 * It is not a page builder: the schema declares names and policy only; values
 * remain WordPress/LocaleStore facts and a template chooses whether to read
 * any particular field.
 */
function zeroy_runtime_template_content_key_valid(string $key): bool
{
    return preg_match('/\A[a-z][a-z0-9_]{0,95}\z/', $key) === 1;
}

function zeroy_runtime_normalize_template_content(mixed $input, array $context, array &$errors): ?array
{
    if ($input === null) {
        return [];
    }
    if (!zeroy_runtime_is_keyed_map($input)) {
        zeroy_runtime_schema_violation($errors, 'template_content_invalid', 'templateContent must be a keyed object.', $context + ['field' => 'templateContent']);
        return null;
    }

    $normalized = [];
    foreach ($input as $key => $field) {
        $field_context = $context + ['field' => 'templateContent', 'key' => is_string($key) ? $key : null];
        if (!is_string($key) || !zeroy_runtime_template_content_key_valid($key) || !zeroy_runtime_is_keyed_map($field)) {
            zeroy_runtime_schema_violation($errors, 'template_content_field_invalid', 'Every TemplateContent field needs a stable lower-case key and an object declaration.', $field_context);
            continue;
        }
        if (($field['kind'] ?? null) !== 'text' || !is_bool($field['searchable'] ?? null)) {
            zeroy_runtime_schema_violation($errors, 'template_content_field_invalid', 'TemplateContent fields currently require kind text and boolean searchable.', $field_context);
            continue;
        }
        $policy = zeroy_localization_normalize_field_policy($field['localization'] ?? null, $errors, $field_context + ['field' => "templateContent.{$key}.localization"]);
        if ($policy === null) {
            continue;
        }
        $normalized[$key] = ['kind' => 'text', 'searchable' => $field['searchable'], 'localization' => $policy];
    }
    return count($normalized) === count($input) ? $normalized : null;
}
