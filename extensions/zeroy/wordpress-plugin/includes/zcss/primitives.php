<?php

defined('ABSPATH') || exit;

function zeroy_zcss_declarations(array $declarations, string $indent = '  '): string
{
    $lines = [];
    foreach ($declarations as $property => $value) $lines[] = $indent . $property . ': ' . $value . ';';
    return implode("\n", $lines);
}

function zeroy_zcss_primitive_definitions(): array
{
    return [
        [
            'className' => 'z-container',
            'purpose' => 'Centers content with a bounded inline size and fluid gutters.',
            'configurableProperties' => ['--z-container-width', '--z-container-gutter'],
            'rules' => [['selector' => '.z-container', 'declarations' => ['inline-size' => 'min(100% - 2 * var(--z-container-gutter, var(--z-gutter)), var(--z-container-width, var(--z-content-width)))', 'margin-inline' => 'auto']]],
        ],
        [
            'className' => 'z-section',
            'purpose' => 'Applies consistent block spacing to a page section.',
            'configurableProperties' => ['--z-section-padding'],
            'rules' => [['selector' => '.z-section', 'declarations' => ['padding-block' => 'var(--z-section-padding, var(--z-section-space))']]],
        ],
        [
            'className' => 'z-stack',
            'purpose' => 'Stacks children vertically with a configurable gap.',
            'configurableProperties' => ['--z-stack-space'],
            'rules' => [['selector' => '.z-stack', 'declarations' => ['display' => 'flex', 'flex-direction' => 'column', 'gap' => 'var(--z-stack-space, var(--z-space-m))']]],
        ],
        [
            'className' => 'z-cluster',
            'purpose' => 'Wraps inline groups with alignment and gap controls.',
            'configurableProperties' => ['--z-cluster-space', '--z-cluster-align', '--z-cluster-justify'],
            'rules' => [['selector' => '.z-cluster', 'declarations' => ['align-items' => 'var(--z-cluster-align, center)', 'display' => 'flex', 'flex-wrap' => 'wrap', 'gap' => 'var(--z-cluster-space, var(--z-space-s))', 'justify-content' => 'var(--z-cluster-justify, flex-start)']]],
        ],
        [
            'className' => 'z-grid',
            'purpose' => 'Builds an intrinsic responsive grid.',
            'configurableProperties' => ['--z-grid-min', '--z-grid-space'],
            'rules' => [['selector' => '.z-grid', 'declarations' => ['display' => 'grid', 'gap' => 'var(--z-grid-space, var(--z-space-l))', 'grid-template-columns' => 'repeat(auto-fit, minmax(min(100%, var(--z-grid-min, 16rem)), 1fr))']]],
        ],
        [
            'className' => 'z-sidebar',
            'purpose' => 'Creates a wrapping main and sidebar relationship.',
            'configurableProperties' => ['--z-sidebar-width', '--z-sidebar-space', '--z-sidebar-content-min'],
            'rules' => [
                ['selector' => '.z-sidebar', 'declarations' => ['display' => 'flex', 'flex-wrap' => 'wrap', 'gap' => 'var(--z-sidebar-space, var(--z-space-l))']],
                ['selector' => '.z-sidebar > :first-child', 'declarations' => ['flex-basis' => 'var(--z-sidebar-width, 20rem)', 'flex-grow' => '1']],
                ['selector' => '.z-sidebar > :last-child', 'declarations' => ['flex-basis' => '0', 'flex-grow' => '999', 'min-inline-size' => 'min(100%, var(--z-sidebar-content-min, 50%))']],
            ],
        ],
        [
            'className' => 'z-switcher',
            'purpose' => 'Switches from horizontal to stacked layout by available width.',
            'configurableProperties' => ['--z-switcher-threshold', '--z-switcher-space'],
            'rules' => [
                ['selector' => '.z-switcher', 'declarations' => ['display' => 'flex', 'flex-wrap' => 'wrap', 'gap' => 'var(--z-switcher-space, var(--z-space-m))']],
                ['selector' => '.z-switcher > *', 'declarations' => ['flex-basis' => 'calc((var(--z-switcher-threshold, 40rem) - 100%) * 999)', 'flex-grow' => '1']],
            ],
        ],
        [
            'className' => 'z-content-grid',
            'purpose' => 'Provides full-width and readable-content grid tracks.',
            'configurableProperties' => ['--z-content-width', '--z-content-text-width', '--z-content-gutter'],
            'rules' => [
                ['selector' => '.z-content-grid', 'declarations' => ['display' => 'grid', 'grid-template-columns' => '[full-start] minmax(var(--z-content-gutter, var(--z-gutter)), 1fr) [content-start] minmax(0, calc((var(--z-content-width) - var(--z-content-text-width, var(--z-text-width))) / 2)) [text-start] minmax(0, var(--z-content-text-width, var(--z-text-width))) [text-end] minmax(0, calc((var(--z-content-width) - var(--z-content-text-width, var(--z-text-width))) / 2)) [content-end] minmax(var(--z-content-gutter, var(--z-gutter)), 1fr) [full-end]']],
                ['selector' => '.z-content-grid > *', 'declarations' => ['grid-column' => 'text']],
                ['selector' => '.z-content-grid > [data-z-width="wide"]', 'declarations' => ['grid-column' => 'content']],
                ['selector' => '.z-content-grid > [data-z-width="full"]', 'declarations' => ['grid-column' => 'full']],
            ],
        ],
        [
            'className' => 'z-reel',
            'purpose' => 'Creates a keyboard-scrollable horizontal content rail.',
            'configurableProperties' => ['--z-reel-space', '--z-reel-item-width'],
            'rules' => [
                ['selector' => '.z-reel', 'declarations' => ['display' => 'flex', 'gap' => 'var(--z-reel-space, var(--z-space-m))', 'max-inline-size' => '100%', 'overflow-x' => 'auto', 'overscroll-behavior-inline' => 'contain', 'padding-block-end' => 'var(--z-space-xs)', 'scrollbar-gutter' => 'stable']],
                ['selector' => '.z-reel > *', 'declarations' => ['flex' => '0 0 var(--z-reel-item-width, auto)']],
            ],
        ],
        [
            'className' => 'z-visually-hidden',
            'purpose' => 'Hides content visually while preserving assistive access.',
            'configurableProperties' => [],
            'rules' => [['selector' => '.z-visually-hidden', 'declarations' => ['block-size' => '1px !important', 'clip-path' => 'inset(50%) !important', 'inline-size' => '1px !important', 'overflow' => 'hidden !important', 'position' => 'absolute !important', 'white-space' => 'nowrap !important']]],
        ],
    ];
}

function zeroy_zcss_rule_css(array $rule): string
{
    return $rule['selector'] . " {\n" . zeroy_zcss_declarations($rule['declarations']) . "\n}";
}

function zeroy_zcss_primitives_css(): string
{
    $foundation = <<<'CSS'
*, *::before, *::after {
  box-sizing: border-box;
}
html {
  color-scheme: light dark;
  overflow-wrap: break-word;
  text-size-adjust: 100%;
}
body {
  margin: 0;
  background: var(--z-color-surface);
  color: var(--z-color-on-surface);
  font-family: var(--z-font-body);
  font-size: var(--z-text-m);
  line-height: var(--z-line-body);
}
h1, h2, h3, h4, h5, h6 {
  font-family: var(--z-font-heading);
  line-height: var(--z-line-heading);
  text-wrap: balance;
}
h1 { font-size: var(--z-heading-1); }
h2 { font-size: var(--z-heading-2); }
h3 { font-size: var(--z-heading-3); }
h4 { font-size: var(--z-heading-4); }
h5 { font-size: var(--z-heading-5); }
h6 { font-size: var(--z-heading-6); }
p, li { text-wrap: pretty; }
img, picture, video, canvas, svg {
  block-size: auto;
  display: block;
  max-inline-size: 100%;
}
input, button, textarea, select {
  color: inherit;
  font: inherit;
}
:focus-visible {
  outline: max(2px, var(--z-border-width)) solid var(--z-color-focus);
  outline-offset: 3px;
}
CSS;
    $rules = [];
    foreach (zeroy_zcss_primitive_definitions() as $definition) foreach ($definition['rules'] as $rule) $rules[] = zeroy_zcss_rule_css($rule);
    $reduced_motion = <<<'CSS'
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
CSS;
    return $foundation . "\n" . implode("\n", $rules) . "\n" . $reduced_motion;
}
