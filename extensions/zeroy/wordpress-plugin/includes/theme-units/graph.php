<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_compile_graph(array $units): array
{
    $edges = 0;
    $dependents = [];
    $indegree = [];
    $depth = [];
    $exports = [];
    foreach ($units as $id => $unit) {
        $indegree[$id] = count($unit['dependencies']);
        $edges += count($unit['dependencies']);
        foreach ($unit['dependencies'] as $dependency) {
            if (!isset($units[$dependency])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_dependency_missing', '/units/' . $id . '/dependencies', 'ThemeUnit dependency is absent from this ThemeProgram.', 'Declare the exact dependency source in zeroy.units.json.')]];
            $dependents[$dependency][] = $id;
        }
        foreach (($unit['php']['exports'] ?? []) as $export) {
            if (isset($exports[$export['symbol']])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_export_collision', '/units/' . $id . '/php/exports', 'Two ThemeUnits export the same PHP symbol.', 'Use one unique namespaced function symbol per program.')]];
            $exports[$export['symbol']] = $id;
        }
    }
    if ($edges > zeroy_theme_units_policy()['maxDependencies']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_program_edge_limit', '/units', 'ThemeProgram exceeds its dependency edge limit.', 'Reduce the dependency graph.')]];
    $ready = [];
    foreach ($indegree as $id => $count) if ($count === 0) $ready[] = $id;
    sort($ready, SORT_STRING);
    $order = [];
    while ($ready !== []) {
        $id = array_shift($ready);
        $order[] = $id;
        $unit_depth = 1;
        foreach ($units[$id]['dependencies'] as $dependency) $unit_depth = max($unit_depth, ($depth[$dependency] ?? 0) + 1);
        $depth[$id] = $unit_depth;
        foreach ($dependents[$id] ?? [] as $dependent) {
            $indegree[$dependent]--;
            if ($indegree[$dependent] === 0) {
                $ready[] = $dependent;
                sort($ready, SORT_STRING);
            }
        }
    }
    if (count($order) !== count($units)) {
        $cycle = array_keys(array_filter($indegree, static fn(int $count): bool => $count > 0));
        sort($cycle, SORT_STRING);
        return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_dependency_cycle', '/units', 'ThemeProgram dependency graph contains a cycle: ' . implode(', ', $cycle) . '.', 'Remove the cycle; every dependency graph must be acyclic.')]];
    }
    if (($depth === [] ? 0 : max($depth)) > zeroy_theme_units_policy()['maxGraphDepth']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_program_depth_limit', '/units', 'ThemeProgram dependency graph exceeds its depth limit.', 'Flatten the dependency graph.')]];
    $identity = array_map(static fn(string $id): array => ['id' => $id, 'sourceHash' => $units[$id]['sourceHash'], 'dependencies' => $units[$id]['dependencies']], $order);
    return ['ok' => true, 'value' => ['order' => $order, 'depth' => $depth, 'edgeCount' => $edges, 'graphHash' => zeroy_theme_units_hash($identity)]];
}
