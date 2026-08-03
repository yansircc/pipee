<?php

defined('ABSPATH') || exit;

/**
 * Build a line index once per stylesheet. CSS diagnostics must not turn a
 * bounded stylesheet into quadratic work by recounting from byte zero for
 * every declaration.
 */
function zeroy_zcss_css_line_starts(string $css): array
{
    $starts = [0];
    $offset = 0;
    while (($newline = strpos($css, "\n", $offset)) !== false) {
        $starts[] = $newline + 1;
        $offset = $newline + 1;
    }
    return $starts;
}

function zeroy_zcss_css_line(array $starts, int $offset): int
{
    $low = 0;
    $high = count($starts) - 1;
    $line = 0;
    while ($low <= $high) {
        $middle = intdiv($low + $high, 2);
        if ($starts[$middle] <= $offset) {
            $line = $middle;
            $low = $middle + 1;
        } else $high = $middle - 1;
    }
    return $line + 1;
}

function zeroy_zcss_css_skip_space(string $css, int &$offset, array &$errors, array $line_starts): void
{
    $length = strlen($css);
    while ($offset < $length) {
        if (ctype_space($css[$offset])) {
            $offset++;
            continue;
        }
        if (substr($css, $offset, 2) === '/*') {
            $end = strpos($css, '*/', $offset + 2);
            if ($end === false) {
                $errors[] = ['code' => 'zcss_css_comment_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
                $offset = $length;
                return;
            }
            $offset = $end + 2;
            continue;
        }
        return;
    }
}

function zeroy_zcss_css_read_until(string $css, int &$offset, array $delimiters, array &$errors, array $line_starts): array
{
    $start = $offset;
    $length = strlen($css);
    $quote = null;
    $escaped = false;
    $round = 0;
    $square = 0;
    while ($offset < $length) {
        $character = $css[$offset];
        if ($quote !== null) {
            if ($escaped) $escaped = false;
            elseif ($character === '\\') $escaped = true;
            elseif ($character === $quote) $quote = null;
            $offset++;
            continue;
        }
        if ($character === '"' || $character === "'") {
            $quote = $character;
            $offset++;
            continue;
        }
        if (substr($css, $offset, 2) === '/*') {
            $end = strpos($css, '*/', $offset + 2);
            if ($end === false) {
                $errors[] = ['code' => 'zcss_css_comment_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
                $offset = $length;
                break;
            }
            $offset = $end + 2;
            continue;
        }
        if ($character === '(') $round++;
        elseif ($character === ')') {
            if ($round === 0) $errors[] = ['code' => 'zcss_css_parenthesis_unbalanced', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
            else $round--;
        } elseif ($character === '[') $square++;
        elseif ($character === ']') {
            if ($square === 0) $errors[] = ['code' => 'zcss_css_bracket_unbalanced', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
            else $square--;
        } elseif ($round === 0 && $square === 0 && in_array($character, $delimiters, true)) {
            return ['text' => trim(substr($css, $start, $offset - $start)), 'delimiter' => $character, 'start' => $start];
        }
        $offset++;
    }
    if ($quote !== null) $errors[] = ['code' => 'zcss_css_string_unclosed', 'offset' => $start, 'line' => zeroy_zcss_css_line($line_starts, $start)];
    if ($round !== 0 || $square !== 0) $errors[] = ['code' => 'zcss_css_group_unclosed', 'offset' => $start, 'line' => zeroy_zcss_css_line($line_starts, $start)];
    return ['text' => trim(substr($css, $start)), 'delimiter' => null, 'start' => $start];
}

function zeroy_zcss_css_reserve_declaration(int &$declaration_count, ?int $max_declarations, array &$errors, int $offset, array $line_starts, bool &$limited): bool
{
    $declaration_count++;
    if ($max_declarations === null || $declaration_count <= $max_declarations) return true;
    $errors[] = [
        'code' => 'zcss_css_declaration_limit',
        'offset' => $offset,
        'line' => zeroy_zcss_css_line($line_starts, $offset),
        'limit' => $max_declarations,
    ];
    $limited = true;
    return false;
}

function zeroy_zcss_css_parse_declarations(string $css, int &$offset, array &$errors, array $line_starts, int &$declaration_count, ?int $max_declarations, bool &$limited): array
{
    $declarations = [];
    $length = strlen($css);
    while ($offset < $length) {
        zeroy_zcss_css_skip_space($css, $offset, $errors, $line_starts);
        if ($offset >= $length) break;
        if ($css[$offset] === '}') {
            $offset++;
            return $declarations;
        }
        $property = zeroy_zcss_css_read_until($css, $offset, [':', ';', '}'], $errors, $line_starts);
        if ($property['delimiter'] !== ':') {
            $errors[] = ['code' => 'zcss_css_declaration_invalid', 'offset' => $property['start'], 'line' => zeroy_zcss_css_line($line_starts, $property['start']), 'evidence' => $property['text']];
            if ($property['delimiter'] === '}') {
                $offset++;
                return $declarations;
            }
            if ($offset < $length) $offset++;
            continue;
        }
        $offset++;
        $value = zeroy_zcss_css_read_until($css, $offset, [';', '}'], $errors, $line_starts);
        if ($property['text'] === '' || $value['text'] === '') $errors[] = ['code' => 'zcss_css_declaration_invalid', 'offset' => $property['start'], 'line' => zeroy_zcss_css_line($line_starts, $property['start']), 'evidence' => $property['text']];
        elseif (!zeroy_zcss_css_reserve_declaration($declaration_count, $max_declarations, $errors, $property['start'], $line_starts, $limited)) return $declarations;
        else $declarations[] = ['property' => strtolower($property['text']), 'value' => $value['text'], 'line' => zeroy_zcss_css_line($line_starts, $property['start'])];
        if ($value['delimiter'] === ';') $offset++;
        elseif ($value['delimiter'] === '}') {
            $offset++;
            return $declarations;
        }
    }
    $errors[] = ['code' => 'zcss_css_block_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
    return $declarations;
}

function zeroy_zcss_css_at_rule_has_children(string $prelude): bool
{
    $name = strtolower(strtok(ltrim(substr($prelude, 1)), " \t\r\n("));
    return in_array($name, ['media', 'supports', 'container', 'layer', 'document', 'scope', 'keyframes', '-webkit-keyframes'], true);
}

function zeroy_zcss_css_reserve_node(int &$node_count, ?int $max_nodes, array &$errors, int $offset, array $line_starts, bool &$limited): bool
{
    $node_count++;
    if ($max_nodes === null || $node_count <= $max_nodes) return true;
    $errors[] = [
        'code' => 'zcss_css_node_limit',
        'offset' => $offset,
        'line' => zeroy_zcss_css_line($line_starts, $offset),
        'limit' => $max_nodes,
    ];
    $limited = true;
    return false;
}

function zeroy_zcss_css_parse_nodes(string $css, int &$offset, array &$errors, array $line_starts, int &$node_count, ?int $max_nodes, int &$declaration_count, ?int $max_declarations, ?int $max_depth, bool &$limited, bool $nested = false, int $depth = 0): array
{
    if ($max_depth !== null && $depth > $max_depth) {
        $errors[] = ['code' => 'zcss_css_nesting_limit', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset), 'limit' => $max_depth];
        $limited = true;
        return [];
    }
    $nodes = [];
    $length = strlen($css);
    while ($offset < $length && !$limited) {
        zeroy_zcss_css_skip_space($css, $offset, $errors, $line_starts);
        if ($offset >= $length || $limited) break;
        if ($css[$offset] === '}') {
            if (!$nested) $errors[] = ['code' => 'zcss_css_brace_unexpected', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
            $offset++;
            return $nodes;
        }
        $prelude = zeroy_zcss_css_read_until($css, $offset, ['{', ';', '}'], $errors, $line_starts);
        $line = zeroy_zcss_css_line($line_starts, $prelude['start']);
        if ($prelude['delimiter'] === ';') {
            if (!str_starts_with($prelude['text'], '@')) $errors[] = ['code' => 'zcss_css_rule_invalid', 'offset' => $prelude['start'], 'line' => $line, 'evidence' => $prelude['text']];
            elseif (zeroy_zcss_css_reserve_node($node_count, $max_nodes, $errors, $prelude['start'], $line_starts, $limited)) $nodes[] = ['type' => 'at-rule', 'prelude' => $prelude['text'], 'line' => $line, 'children' => [], 'declarations' => []];
            $offset++;
            continue;
        }
        if ($prelude['delimiter'] !== '{' || $prelude['text'] === '') {
            $errors[] = ['code' => 'zcss_css_rule_invalid', 'offset' => $prelude['start'], 'line' => $line, 'evidence' => $prelude['text']];
            if ($offset < $length) $offset++;
            continue;
        }
        if (!zeroy_zcss_css_reserve_node($node_count, $max_nodes, $errors, $prelude['start'], $line_starts, $limited)) return $nodes;
        $offset++;
        $is_at_rule = str_starts_with($prelude['text'], '@');
        $has_children = $is_at_rule && zeroy_zcss_css_at_rule_has_children($prelude['text']);
        $children = $has_children ? zeroy_zcss_css_parse_nodes($css, $offset, $errors, $line_starts, $node_count, $max_nodes, $declaration_count, $max_declarations, $max_depth, $limited, true, $depth + 1) : [];
        $declarations = $children === [] && !$has_children ? zeroy_zcss_css_parse_declarations($css, $offset, $errors, $line_starts, $declaration_count, $max_declarations, $limited) : [];
        if ($limited) return $nodes;
        $nodes[] = ['type' => $is_at_rule ? 'at-rule' : 'rule', 'prelude' => $prelude['text'], 'line' => $line, 'children' => $children, 'declarations' => $declarations];
    }
    if ($nested && !$limited) $errors[] = ['code' => 'zcss_css_block_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($line_starts, $offset)];
    return $nodes;
}

function zeroy_zcss_parse_css(string $css, ?int $max_nodes = null, ?int $max_depth = null, ?int $max_declarations = null): array
{
    $offset = 0;
    $errors = [];
    $node_count = 0;
    $declaration_count = 0;
    $limited = false;
    $normalized = str_replace(["\r\n", "\r"], "\n", $css);
    $nodes = zeroy_zcss_css_parse_nodes($normalized, $offset, $errors, zeroy_zcss_css_line_starts($normalized), $node_count, $max_nodes, $declaration_count, $max_declarations, $max_depth, $limited);
    return $errors === [] ? ['ok' => true, 'nodes' => $nodes, 'nodeCount' => $node_count, 'declarationCount' => $declaration_count] : ['ok' => false, 'nodes' => $nodes, 'errors' => $errors, 'nodeCount' => $node_count, 'declarationCount' => $declaration_count];
}

function zeroy_zcss_walk_css_nodes(array $nodes, callable $visit): void
{
    foreach ($nodes as $node) {
        $visit($node);
        if (($node['children'] ?? []) !== []) zeroy_zcss_walk_css_nodes($node['children'], $visit);
    }
}

function zeroy_zcss_css_identifiers(string $text, string $marker): array
{
    $found = [];
    $length = strlen($text);
    $marker_length = strlen($marker);
    for ($offset = 0; $offset <= $length - $marker_length; $offset++) {
        if (substr($text, $offset, $marker_length) !== $marker) continue;
        $end = $offset + $marker_length;
        while ($end < $length && preg_match('/[a-zA-Z0-9_-]/', $text[$end]) === 1) $end++;
        if ($end > $offset + $marker_length) $found[substr($text, $offset, $end - $offset)] = true;
        $offset = $end - 1;
    }
    return array_keys($found);
}
