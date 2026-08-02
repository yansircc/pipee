<?php

defined('ABSPATH') || exit;

function zeroy_zcss_css_line(string $css, int $offset): int
{
    return substr_count(substr($css, 0, $offset), "\n") + 1;
}

function zeroy_zcss_css_skip_space(string $css, int &$offset, array &$errors): void
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
                $errors[] = ['code' => 'zcss_css_comment_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
                $offset = $length;
                return;
            }
            $offset = $end + 2;
            continue;
        }
        return;
    }
}

function zeroy_zcss_css_read_until(string $css, int &$offset, array $delimiters, array &$errors): array
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
                $errors[] = ['code' => 'zcss_css_comment_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
                $offset = $length;
                break;
            }
            $offset = $end + 2;
            continue;
        }
        if ($character === '(') $round++;
        elseif ($character === ')') {
            if ($round === 0) $errors[] = ['code' => 'zcss_css_parenthesis_unbalanced', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
            else $round--;
        } elseif ($character === '[') $square++;
        elseif ($character === ']') {
            if ($square === 0) $errors[] = ['code' => 'zcss_css_bracket_unbalanced', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
            else $square--;
        } elseif ($round === 0 && $square === 0 && in_array($character, $delimiters, true)) {
            return ['text' => trim(substr($css, $start, $offset - $start)), 'delimiter' => $character, 'start' => $start];
        }
        $offset++;
    }
    if ($quote !== null) $errors[] = ['code' => 'zcss_css_string_unclosed', 'offset' => $start, 'line' => zeroy_zcss_css_line($css, $start)];
    if ($round !== 0 || $square !== 0) $errors[] = ['code' => 'zcss_css_group_unclosed', 'offset' => $start, 'line' => zeroy_zcss_css_line($css, $start)];
    return ['text' => trim(substr($css, $start)), 'delimiter' => null, 'start' => $start];
}

function zeroy_zcss_css_parse_declarations(string $css, int &$offset, array &$errors): array
{
    $declarations = [];
    $length = strlen($css);
    while ($offset < $length) {
        zeroy_zcss_css_skip_space($css, $offset, $errors);
        if ($offset >= $length) break;
        if ($css[$offset] === '}') {
            $offset++;
            return $declarations;
        }
        $property = zeroy_zcss_css_read_until($css, $offset, [':', ';', '}'], $errors);
        if ($property['delimiter'] !== ':') {
            $errors[] = ['code' => 'zcss_css_declaration_invalid', 'offset' => $property['start'], 'line' => zeroy_zcss_css_line($css, $property['start']), 'evidence' => $property['text']];
            if ($property['delimiter'] === '}') {
                $offset++;
                return $declarations;
            }
            if ($offset < $length) $offset++;
            continue;
        }
        $offset++;
        $value = zeroy_zcss_css_read_until($css, $offset, [';', '}'], $errors);
        if ($property['text'] === '' || $value['text'] === '') $errors[] = ['code' => 'zcss_css_declaration_invalid', 'offset' => $property['start'], 'line' => zeroy_zcss_css_line($css, $property['start']), 'evidence' => $property['text']];
        else $declarations[] = ['property' => strtolower($property['text']), 'value' => $value['text'], 'line' => zeroy_zcss_css_line($css, $property['start'])];
        if ($value['delimiter'] === ';') $offset++;
        elseif ($value['delimiter'] === '}') {
            $offset++;
            return $declarations;
        }
    }
    $errors[] = ['code' => 'zcss_css_block_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
    return $declarations;
}

function zeroy_zcss_css_at_rule_has_children(string $prelude): bool
{
    $name = strtolower(strtok(ltrim(substr($prelude, 1)), " \t\r\n("));
    return in_array($name, ['media', 'supports', 'container', 'layer', 'document', 'scope', 'keyframes', '-webkit-keyframes'], true);
}

function zeroy_zcss_css_parse_nodes(string $css, int &$offset, array &$errors, bool $nested = false): array
{
    $nodes = [];
    $length = strlen($css);
    while ($offset < $length) {
        zeroy_zcss_css_skip_space($css, $offset, $errors);
        if ($offset >= $length) break;
        if ($css[$offset] === '}') {
            if (!$nested) $errors[] = ['code' => 'zcss_css_brace_unexpected', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
            $offset++;
            return $nodes;
        }
        $prelude = zeroy_zcss_css_read_until($css, $offset, ['{', ';', '}'], $errors);
        if ($prelude['delimiter'] === ';') {
            if (!str_starts_with($prelude['text'], '@')) $errors[] = ['code' => 'zcss_css_rule_invalid', 'offset' => $prelude['start'], 'line' => zeroy_zcss_css_line($css, $prelude['start']), 'evidence' => $prelude['text']];
            else $nodes[] = ['type' => 'at-rule', 'prelude' => $prelude['text'], 'line' => zeroy_zcss_css_line($css, $prelude['start']), 'children' => [], 'declarations' => []];
            $offset++;
            continue;
        }
        if ($prelude['delimiter'] !== '{' || $prelude['text'] === '') {
            $errors[] = ['code' => 'zcss_css_rule_invalid', 'offset' => $prelude['start'], 'line' => zeroy_zcss_css_line($css, $prelude['start']), 'evidence' => $prelude['text']];
            if ($offset < $length) $offset++;
            continue;
        }
        $offset++;
        $is_at_rule = str_starts_with($prelude['text'], '@');
        $children = $is_at_rule && zeroy_zcss_css_at_rule_has_children($prelude['text']) ? zeroy_zcss_css_parse_nodes($css, $offset, $errors, true) : [];
        $declarations = $children === [] && (!$is_at_rule || !zeroy_zcss_css_at_rule_has_children($prelude['text'])) ? zeroy_zcss_css_parse_declarations($css, $offset, $errors) : [];
        $nodes[] = ['type' => $is_at_rule ? 'at-rule' : 'rule', 'prelude' => $prelude['text'], 'line' => zeroy_zcss_css_line($css, $prelude['start']), 'children' => $children, 'declarations' => $declarations];
    }
    if ($nested) $errors[] = ['code' => 'zcss_css_block_unclosed', 'offset' => $offset, 'line' => zeroy_zcss_css_line($css, $offset)];
    return $nodes;
}

function zeroy_zcss_parse_css(string $css): array
{
    $offset = 0;
    $errors = [];
    $nodes = zeroy_zcss_css_parse_nodes(str_replace(["\r\n", "\r"], "\n", $css), $offset, $errors);
    return $errors === [] ? ['ok' => true, 'nodes' => $nodes] : ['ok' => false, 'nodes' => $nodes, 'errors' => $errors];
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
