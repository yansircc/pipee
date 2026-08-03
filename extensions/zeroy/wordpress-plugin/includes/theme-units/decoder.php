<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_diagnostic(string $code, string $path, string $message, string $repair): array
{
    return ['code' => $code, 'path' => $path, 'message' => $message, 'repair' => $repair];
}

function zeroy_theme_units_exact_keys(array $value, array $required, array $optional = []): bool
{
    if (array_is_list($value)) return false;
    $keys = array_keys($value);
    sort($keys, SORT_STRING);
    $allowed = [...$required, ...$optional];
    sort($allowed, SORT_STRING);
    foreach ($required as $key) if (!array_key_exists($key, $value)) return false;
    return array_diff($keys, $allowed) === [];
}

function zeroy_theme_units_safe_relative_path(mixed $value, string $extension): bool
{
    if (!is_string($value) || $value === '' || str_contains($value, "\0") || str_contains($value, '\\') || str_starts_with($value, '/')) return false;
    foreach (explode('/', $value) as $segment) if ($segment === '' || $segment === '.' || $segment === '..') return false;
    return str_ends_with(strtolower($value), $extension) && !str_starts_with($value, ZEROY_THEME_UNIT_GENERATED_ROOT . '/');
}

function zeroy_theme_units_decode_program(mixed $input): array
{
    $diagnostics = [];
    if (!is_array($input) || !zeroy_theme_units_exact_keys($input, ['contract', 'units']) || ($input['contract'] ?? null) !== ZEROY_THEME_PROGRAM_CONTRACT || !is_array($input['units']) || !array_is_list($input['units'])) {
        return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_program_invalid', '/', 'zeroy.units.json must be an exact ThemeProgram v1 object.', 'Use only contract and units, with contract zeroy/theme-program@1.')]];
    }
    if (count($input['units']) > zeroy_theme_units_policy()['maxUnits']) $diagnostics[] = zeroy_theme_units_diagnostic('theme_program_limit', '/units', 'ThemeProgram exceeds the unit limit.', 'Reduce the declared unit graph.');
    $units = [];
    $sources = [];
    foreach ($input['units'] as $index => $source) {
        $path = '/units/' . $index;
        if (!is_array($source) || array_is_list($source) || !is_string($source['kind'] ?? null)) {
            $diagnostics[] = zeroy_theme_units_diagnostic('theme_unit_source_invalid', $path, 'ThemeUnit source must be a discriminated object.', 'Use one exact local or catalog source object.');
            continue;
        }
        if ($source['kind'] === 'local') {
            if (!zeroy_theme_units_exact_keys($source, ['kind', 'manifest']) || !zeroy_theme_units_safe_relative_path($source['manifest'] ?? null, '.json') || !str_ends_with($source['manifest'], '/unit.json')) {
                $diagnostics[] = zeroy_theme_units_diagnostic('theme_unit_source_invalid', $path, 'Local source requires one safe manifest path ending in /unit.json.', 'Stage the unit under components/<name>/unit.json and reference that exact path.');
                continue;
            }
            $identity = 'local:' . $source['manifest'];
        } elseif ($source['kind'] === 'catalog') {
            if (!zeroy_theme_units_exact_keys($source, ['kind', 'id', 'integrity']) || preg_match('/\A[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}\z/', (string) ($source['id'] ?? '')) !== 1 || preg_match('/\Asha256-[0-9a-f]{64}\z/', (string) ($source['integrity'] ?? '')) !== 1) {
                $diagnostics[] = zeroy_theme_units_diagnostic('theme_unit_source_invalid', $path, 'Catalog source requires an exact unit ID and sha256 integrity.', 'Copy the id and integrity from themeUnitContract.catalog exactly.');
                continue;
            }
            $identity = 'catalog:' . $source['id'];
        } else {
            $diagnostics[] = zeroy_theme_units_diagnostic('theme_unit_source_invalid', $path . '/kind', 'Unknown ThemeUnit source kind.', 'Use local or catalog.');
            continue;
        }
        if (isset($sources[$identity])) {
            $diagnostics[] = zeroy_theme_units_diagnostic('theme_unit_source_duplicate', $path, 'ThemeProgram declares the same source more than once.', 'Keep one exact source declaration.');
            continue;
        }
        $sources[$identity] = true;
        $units[] = $source;
    }
    return $diagnostics === [] ? ['ok' => true, 'value' => ['contract' => ZEROY_THEME_PROGRAM_CONTRACT, 'units' => $units]] : ['ok' => false, 'diagnostics' => $diagnostics];
}

function zeroy_theme_units_decode_string_list(mixed $value, string $path, string $extension = ''): array
{
    if (!is_array($value) || !array_is_list($value)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_field_invalid', $path, 'Expected an ordered list.', 'Use a JSON array with unique values.')]];
    $seen = [];
    foreach ($value as $index => $item) {
        $valid = is_string($item) && $item !== '' && ($extension === '' ? strlen($item) <= 256 : zeroy_theme_units_safe_relative_path($item, $extension));
        if (!$valid || isset($seen[$item])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_field_invalid', $path . '/' . $index, 'List value is invalid or duplicated.', 'Use one unique safe value of the required kind.')]];
        $seen[$item] = true;
    }
    return ['ok' => true, 'value' => $value];
}

function zeroy_theme_units_decode_unit(mixed $input): array
{
    if (!is_array($input) || !zeroy_theme_units_exact_keys($input, ['contract', 'id'], ['php', 'styles', 'scripts', 'dependencies', 'interface', 'behaviors', 'sourceHash']) || ($input['contract'] ?? null) !== ZEROY_THEME_UNIT_CONTRACT || preg_match('/\A[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}\z/', (string) ($input['id'] ?? '')) !== 1) {
        return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_invalid', '/', 'unit.json must be an exact ThemeUnit v1 object with a valid namespace/name ID.', 'Use contract zeroy/theme-unit@1 and a lowercase namespace/name ID.')]];
    }
    if (array_key_exists('sourceHash', $input)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_source_hash_forbidden', '/sourceHash', 'sourceHash is compiler-owned and cannot appear in source.', 'Remove sourceHash; inspect themeUnitSurface after compilation.')]];
    $unit = ['contract' => ZEROY_THEME_UNIT_CONTRACT, 'id' => $input['id'], 'php' => null, 'styles' => [], 'scripts' => [], 'dependencies' => [], 'interface' => null, 'behaviors' => []];
    foreach ([['styles', '.css'], ['scripts', '.js'], ['dependencies', ''], ['behaviors', '']] as [$field, $extension]) {
        if (!array_key_exists($field, $input)) continue;
        $decoded = zeroy_theme_units_decode_string_list($input[$field], '/' . $field, $extension);
        if (!$decoded['ok']) return $decoded;
        $unit[$field] = $decoded['value'];
    }
    foreach ($unit['dependencies'] as $index => $dependency) if (preg_match('/\A[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9-]{0,63}\z/', $dependency) !== 1) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_dependency_invalid', '/dependencies/' . $index, 'Dependency is not a valid ThemeUnit ID.', 'Use an exact namespace/name ID from this ThemeProgram.')]];
    foreach ($unit['behaviors'] as $index => $behavior) if (!in_array($behavior, zeroy_theme_units_policy()['behaviors'], true)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_behavior_unknown', '/behaviors/' . $index, 'Behavior is not a published verifier profile.', 'Use a behavior listed by themeUnitContract.')]];
    if (array_key_exists('php', $input)) {
        $php = $input['php'];
        if (!is_array($php) || !zeroy_theme_units_exact_keys($php, ['entrypoints', 'exports'])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_php_invalid', '/php', 'php must contain exact entrypoints and exports fields.', 'Declare ordered .php entrypoints and public export descriptors.')]];
        $entrypoints = zeroy_theme_units_decode_string_list($php['entrypoints'], '/php/entrypoints', '.php');
        if (!$entrypoints['ok']) return $entrypoints;
        if (!is_array($php['exports']) || !array_is_list($php['exports']) || count($php['exports']) > zeroy_theme_units_policy()['maxExportsPerUnit']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_export_invalid', '/php/exports', 'exports must be a bounded list.', 'Declare each public function once.')]];
        $exports = [];
        $names = [];
        $symbols = [];
        foreach ($php['exports'] as $index => $export) {
            if (!is_array($export) || !zeroy_theme_units_exact_keys($export, ['name', 'symbol']) || preg_match('/\A[a-z][a-zA-Z0-9_]{0,63}\z/', (string) ($export['name'] ?? '')) !== 1 || preg_match('/\A(?:[A-Za-z_][A-Za-z0-9_]*\\\\)+[A-Za-z_][A-Za-z0-9_]*\z/', (string) ($export['symbol'] ?? '')) !== 1 || isset($names[$export['name']]) || isset($symbols[$export['symbol']])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_export_invalid', '/php/exports/' . $index, 'Export name or fully-qualified function symbol is invalid or duplicated.', 'Use one stable name and a namespaced PHP function symbol.')]];
            $names[$export['name']] = true;
            $symbols[$export['symbol']] = true;
            $exports[] = $export;
        }
        $unit['php'] = ['entrypoints' => $entrypoints['value'], 'exports' => $exports];
    }
    if (array_key_exists('interface', $input)) {
        $interface = $input['interface'];
        if (!is_array($interface) || !zeroy_theme_units_exact_keys($interface, ['props', 'slots']) || !is_array($interface['props']) || array_is_list($interface['props']) || !is_array($interface['slots']) || !array_is_list($interface['slots'])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_interface_invalid', '/interface', 'interface must contain a props map and slots list.', 'Use exact discoverability descriptors; they do not create a runtime dispatcher.')]];
        if (count($interface['props']) > zeroy_theme_units_policy()['maxPropsPerUnit'] || count($interface['slots']) > zeroy_theme_units_policy()['maxSlotsPerUnit']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_interface_limit', '/interface', 'interface exceeds its bounded surface.', 'Reduce public props or slots.')]];
        foreach ($interface['props'] as $name => $descriptor) if (preg_match('/\A[a-z][a-zA-Z0-9_]{0,63}\z/', (string) $name) !== 1 || !is_array($descriptor) || !zeroy_theme_units_exact_keys($descriptor, ['description', 'required']) || !is_string($descriptor['description']) || $descriptor['description'] === '' || strlen($descriptor['description']) > zeroy_theme_units_policy()['maxTextLength'] || !is_bool($descriptor['required'])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_interface_invalid', '/interface/props/' . $name, 'Prop descriptor is invalid.', 'Use {description, required} with a stable prop name.')]];
        $slot_names = [];
        foreach ($interface['slots'] as $index => $descriptor) if (!is_array($descriptor) || !zeroy_theme_units_exact_keys($descriptor, ['name', 'description', 'required']) || preg_match('/\A[a-z][a-zA-Z0-9_]{0,63}\z/', (string) ($descriptor['name'] ?? '')) !== 1 || isset($slot_names[$descriptor['name']]) || !is_string($descriptor['description'] ?? null) || $descriptor['description'] === '' || strlen($descriptor['description']) > zeroy_theme_units_policy()['maxTextLength'] || !is_bool($descriptor['required'] ?? null)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_interface_invalid', '/interface/slots/' . $index, 'Slot descriptor is invalid or duplicated.', 'Use unique {name, description, required} descriptors.')]]; else $slot_names[$descriptor['name']] = true;
        ksort($interface['props'], SORT_STRING);
        $unit['interface'] = $interface;
    }
    return ['ok' => true, 'value' => $unit];
}
