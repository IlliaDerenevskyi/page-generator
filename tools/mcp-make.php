<?php
// php mcp-make.php <png-or-dir> [schema|elementor] [describe] : writes tools/.mcp-run.js from mcp-run.js (see there). Command line only.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$arg = realpath($argv[1] ?? '');
$pngs = $arg && is_dir($arg) ? glob($arg . '/*.png') : ($arg ? [$arg] : []);
$png = $pngs ? count($pngs) . ' file(s)' : '';
$template = in_array('schema', $argv, true) ? 'mcp-schema.js' : (in_array('elementor-editor', $argv, true) ? 'mcp-elementor.js' : 'mcp-run.js');
$mode = in_array('elementor', $argv, true) ? 'elementor' : 'gutenberg';
if (!$pngs) { fwrite(STDERR, "usage: php mcp-make.php <png>\n"); exit(1); }
$cookies = file_get_contents(__DIR__ . '/.cookies.json');
// "describe": every screenshot gets its description from references/descriptions.json (a plain run measures without any).
$descriptions = in_array('describe', $argv, true) && is_file(__DIR__ . '/references/descriptions.json') ? trim(file_get_contents(__DIR__ . '/references/descriptions.json')) : '{}';
file_put_contents(__DIR__ . '/.mcp-run.js', str_replace(['__TARGETS__', '__COOKIES__', '__MODE__', '__DESCRIPTIONS__'], [json_encode($pngs), trim($cookies), $mode, $descriptions], file_get_contents(__DIR__ . '/' . $template)));
echo "ok $png\n";
