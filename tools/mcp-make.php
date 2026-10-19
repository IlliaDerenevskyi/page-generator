<?php
// php mcp-make.php <png-or-dir> [schema] : writes tools/.mcp-run.js from mcp-run.js (see there). Command line only.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$arg = realpath($argv[1] ?? '');
$pngs = $arg && is_dir($arg) ? glob($arg . '/*.png') : ($arg ? [$arg] : []);
$png = $pngs ? count($pngs) . ' file(s)' : '';
$template = ($argv[2] ?? '') === 'schema' ? 'mcp-schema.js' : 'mcp-run.js';
if (!$pngs) { fwrite(STDERR, "usage: php mcp-make.php <png>\n"); exit(1); }
$cookies = file_get_contents(__DIR__ . '/.cookies.json');
file_put_contents(__DIR__ . '/.mcp-run.js', str_replace(['__TARGETS__', '__COOKIES__'], [json_encode($pngs), trim($cookies)], file_get_contents(__DIR__ . '/' . $template)));
echo "ok $png\n";
