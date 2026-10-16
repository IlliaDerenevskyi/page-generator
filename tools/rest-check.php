<?php
// Smoke test for the REST API (page-generator/v1): permissions, schema GET/PUT round-trip, validation and export targets.
// Overwrites the content of the page it is pointed at, so use a scratch page that already has a saved schema:
//   WP_LOAD=/srv/http/wordpress/wp-load.php PG_POST=2 php rest-check.php
// Command line only: this script acts as user 1 and rewrites a page, so it must never answer a web request.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
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

// Mobile layout (variants.mobile): both canvases are written, tagged for CSS, and unknown variants are refused.
$base = $schema;
unset($base['variants']);
$with_mobile = $base;
$with_mobile['variants'] = ['mobile' => ['sections' => $base['sections']]];
$check('a mobile layout is accepted', $call('PUT', $route, ['schema' => $with_mobile])->get_status() === 200);
$content = get_post($post)->post_content;
$check('both canvases are tagged by breakpoint', strpos($content, 'pg-bp-desktop') !== false && strpos($content, 'pg-bp-mobile') !== false);
$check('the mobile layout survives GET', !empty($call('GET', $route)->get_data()['schema']['variants']['mobile']['sections']));
$bad = $base;
$bad['variants'] = ['tablet' => ['sections' => $base['sections']]];
$check('an unknown variant gives 422', $call('PUT', $route, ['schema' => $bad])->get_status() === 422);
$call('PUT', $route, ['schema' => $base]);
$check('without a mobile layout no breakpoint classes are written', strpos(get_post($post)->post_content, 'pg-bp-') === false);

// Flow layout: the same schema as a responsive page (no absolute canvas), and back to pixel mode on request.
$check('layout=flow builds a flow page', $call('PUT', $route, ['schema' => $base, 'layout' => 'flow'])->get_status() === 200);
$flow_content = get_post($post)->post_content;
$check('the flow page has no pixel canvas at its root', strpos($flow_content, 'pg-flow-page') !== false && strpos($flow_content, '"className":"page-generator-canvas"') === false);
$check('the flow page parses into blocks', count(array_filter(parse_blocks($flow_content), function ($b) { return !empty($b['blockName']); })) >= 1);
$call('PUT', $route, ['schema' => $base, 'layout' => 'pixel']);
$check('layout=pixel brings the canvas back', strpos(get_post($post)->post_content, 'pg-flow-page') === false && strpos(get_post($post)->post_content, 'page-generator-canvas') !== false);

// Flow layout in Elementor: native flex containers (no absolute positions), still valid JSON, tagged for the stylesheet.
$check('Elementor + flow builds', $call('PUT', $route, ['schema' => $base, 'layout' => 'flow', 'editorMode' => 'elementor'])->get_status() === 200);
$el_json = get_post_meta($post, '_elementor_data', true);
$el_data = json_decode($el_json, true);
$check('the Elementor flow tree is valid JSON with a flow root', is_array($el_data) && strpos($el_json, 'pg-el-flow') !== false);
$call('PUT', $route, ['schema' => $base, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$check('layout=pixel brings the Elementor canvas back', strpos(get_post_meta($post, '_elementor_data', true), 'pg-el-flow') === false);
$call('PUT', $route, ['schema' => $base, 'layout' => 'pixel', 'editorMode' => 'gutenberg']);

// WPForms export: one form per detected form, reused on the next build instead of piling up duplicates.
if (post_type_exists('wpforms')) {
    $has_form = false;
    $scan = function ($nodes) use (&$scan, &$has_form) { foreach ((array) $nodes as $n) { if (is_array($n) && ($n['type'] ?? '') === 'form') $has_form = true; if (is_array($n)) $scan($n['children'] ?? ($n['elements'] ?? [])); } };
    $scan($schema['sections'] ?? []);
    if ($has_form) {
        $ids = function () use ($post) { $m = get_post_meta($post, '_page_generator_wpforms', true); return is_array($m) ? $m : []; };
        $check('forms=wpforms builds a WPForms form', $call('PUT', $route, ['schema' => $schema, 'forms' => 'wpforms'])->get_status() === 200 && count($ids()) >= 1);
        $first = $ids();
        $check('the page embeds the form shortcode', strpos(get_post($post)->post_content, '[wpforms id="' . ($first[0] ?? 0) . '"]') !== false);
        $call('PUT', $route, ['schema' => $schema, 'forms' => 'wpforms']);
        $check('a rebuild reuses the same form', $ids() === $first);
        $call('PUT', $route, ['schema' => $schema, 'forms' => 'custom']);
        $check('forms=custom brings back the built-in form', strpos(get_post($post)->post_content, '[wpforms') === false);
    } else {
        echo "skip WPForms checks: the page has no form\n";
    }
}
exit($failed ? 1 : 0);
