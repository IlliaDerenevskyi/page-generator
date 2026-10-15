<?php
// Smoke test for the REST API (page-generator/v1): permissions, schema GET/PUT round-trip, validation and export targets.
// Overwrites the content of the page it is pointed at, so use a scratch page that already has a saved schema:
//   WP_LOAD=/srv/http/wordpress/wp-load.php PG_POST=2 php rest-check.php
define('WP_USE_THEMES', false);
require getenv('WP_LOAD') ?: dirname(__DIR__, 4) . '/wp-load.php';
$post = (int) (getenv('PG_POST') ?: 2);
$failed = 0;
$check = function ($label, $ok) use (&$failed) { echo ($ok ? 'ok   ' : 'FAIL '), $label, "\n"; if (!$ok) $failed++; };
$call = function ($method, $route, $body = null, $params = []) {
    $request = new WP_REST_Request($method, $route);
    foreach ($params as $key => $value) $request->set_param($key, $value);
    if ($body !== null) { $request->set_header('content-type', 'application/json'); $request->set_body(wp_json_encode($body)); }
    return rest_do_request($request);
};
$route = "/page-generator/v1/pages/$post/schema";
wp_set_current_user(0);
$check('anonymous GET is refused', $call('GET', $route)->get_status() === 401);
$check('anonymous PUT is refused', $call('PUT', $route, ['schema' => ['sections' => [1]]])->get_status() === 401);
wp_set_current_user(1);
$get = $call('GET', $route);
$check('GET returns the saved schema', $get->get_status() === 200 && !empty($get->get_data()['schema']['sections']));
$schema = $get->get_data()['schema'] ?? [];
$before = md5(get_post($post)->post_content);
$check('PUT of the same schema succeeds', $call('PUT', $route, ['schema' => $schema])->get_status() === 200);
$check('PUT round-trip leaves the content byte-identical', md5(get_post($post)->post_content) === $before);
$check('bare schema body is accepted', $call('PUT', $route, $schema)->get_status() === 200);
$check('empty sections give 400', $call('PUT', $route, ['schema' => ['sections' => []]])->get_status() === 400);
$check('unknown root type gives 422', $call('PUT', $route, ['schema' => ['sections' => [['type' => 'bogus']]]])->get_status() === 422);
foreach (['elementor' => 'models', 'blocks' => 'content', 'html' => 'content'] as $target => $key) {
    $res = $call('GET', "/page-generator/v1/pages/$post/export", null, ['target' => $target]);
    $check("export $target", $res->get_status() === 200 && !empty($res->get_data()[$key]));
}
$check('unknown export target gives 400', $call('GET', "/page-generator/v1/pages/$post/export", null, ['target' => 'pdf'])->get_status() === 400);
exit($failed ? 1 : 0);
