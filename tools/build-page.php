<?php
// Builds a scratch page from a schema file through the REST API code path and prints its id and URL. Development only.
//   php build-page.php schema.json [gutenberg|elementor] [pixel|flow] [wpforms|custom]
// The page is called "pg-scratch" and is created on first use; it is overwritten on every run.
// Command line only: it acts as user 1, so it must never answer a web request.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
define('WP_USE_THEMES', false);
require getenv('WP_LOAD') ?: dirname(__DIR__, 4) . '/wp-load.php';
if (empty($argv[1]) || !is_readable($argv[1])) {
    fwrite(STDERR, "usage: php build-page.php schema.json [gutenberg|elementor] [pixel|flow] [wpforms|custom]\n");
    exit(2);
}
wp_set_current_user(1);
$found = get_posts(['post_type' => 'page', 'title' => 'pg-scratch', 'numberposts' => 1, 'post_status' => 'any']);
$id = $found ? $found[0]->ID : wp_insert_post(['post_type' => 'page', 'post_title' => 'pg-scratch', 'post_status' => 'publish']);
$body = [
    'schema' => json_decode(file_get_contents($argv[1]), true),
    'editorMode' => $argv[2] ?? 'gutenberg',
    'layout' => $argv[3] ?? 'pixel',
    'forms' => $argv[4] ?? 'custom',
];
$request = new WP_REST_Request('PUT', "/page-generator/v1/pages/$id/schema");
$request->set_header('content-type', 'application/json');
$request->set_body(wp_json_encode($body));
$response = rest_do_request($request);
if ($response->get_status() !== 200) {
    fwrite(STDERR, 'PUT failed: ' . wp_json_encode($response->get_data(), JSON_UNESCAPED_UNICODE) . "\n");
    exit(1);
}
echo $id, ' ', get_permalink($id), "\n";
