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

// Gradients: a detected linear gradient reaches both exporters (CSS for blocks, native gradient settings for Elementor).
$with_gradient = $base;
$with_gradient['sections'][0]['style'] = array_merge((array) ($with_gradient['sections'][0]['style'] ?? []), ['gradient' => ['type' => 'linear', 'angle' => 135, 'stops' => [['pos' => 0, 'color' => '#6a11cb'], ['pos' => 100, 'color' => '#2575fc']]]]);
$check('a gradient is accepted', $call('PUT', $route, ['schema' => $with_gradient])->get_status() === 200);
$check('blocks carry the gradient as CSS', strpos(get_post($post)->post_content, 'linear-gradient(135deg,#6a11cb 0%,#2575fc 100%)') !== false);
$call('PUT', $route, ['schema' => $with_gradient, 'editorMode' => 'elementor']);
$check('Elementor gets a native gradient background', strpos(get_post_meta($post, '_elementor_data', true), 'background_gradient_type') !== false);

// Backdrop picture: a soft mesh/radial background cut from the screenshot is a background image in every output.
$with_backdrop = $base;
$with_backdrop['sections'][0]['style'] = array_merge((array) ($with_backdrop['sections'][0]['style'] ?? []), ['backgroundImage' => ['url' => 'http://localhost/wp-content/uploads/backdrop-test.jpg', 'attachmentId' => 0]]);
unset($with_backdrop['sections'][0]['style']['gradient']); // a gradient wins over a picture, so the scratch page's own ramp must not hide it
$check('a backdrop picture is accepted', $call('PUT', $route, ['schema' => $with_backdrop])->get_status() === 200);
$check('blocks carry the backdrop as a background image', strpos(get_post($post)->post_content, 'backdrop-test.jpg') !== false && strpos(get_post($post)->post_content, '"backgroundSize":"cover"') !== false);
$call('PUT', $route, ['schema' => $with_backdrop, 'editorMode' => 'elementor']);
$check('Elementor gets the backdrop as a background image', strpos(get_post_meta($post, '_elementor_data', true), 'backdrop-test.jpg') !== false);
$call('PUT', $route, ['schema' => $base, 'editorMode' => 'gutenberg']);

// Required fields: the flag reaches the built-in form (HTML required + a red asterisk), and Elementor's HTML widget.
// A schema of its own, so the check does not depend on what the scratch page happens to hold.
$required_schema = ['version' => 2, 'title' => 'Required', 'sections' => [['id' => 'rs0', 'type' => 'section', 'settings' => ['sourceWidth' => 1000, 'sourceHeight' => 400, 'direction' => 'column', 'gap' => 16], 'bbox' => ['x' => 0, 'y' => 0, 'width' => 1000, 'height' => 400], 'style' => ['background' => '#ffffff'], 'children' => [], 'elements' => []]]];
$field = function ($label, $required, $y) { return ['id' => 'f' . $y, 'type' => 'form-field', 'fieldType' => 'text', 'label' => $label, 'placeholder' => '', 'required' => $required, 'bbox' => ['x' => 40, 'y' => $y, 'width' => 300, 'height' => 40], 'settings' => ['x' => 40, 'y' => $y, 'width' => 300, 'height' => 40], 'children' => [], 'elements' => []]; };
$required_schema['sections'][0]['children'] = [['id' => 'frm', 'type' => 'form', 'bbox' => ['x' => 0, 'y' => 0, 'width' => 400, 'height' => 200], 'settings' => ['x' => 0, 'y' => 0, 'width' => 400, 'height' => 200], 'children' => [$field('Email', true, 40), $field('Name', false, 110)], 'elements' => []]];
$required_schema['sections'][0]['elements'] = $required_schema['sections'][0]['children'];
$check('a form with a required field is accepted', $call('PUT', $route, ['schema' => $required_schema, 'forms' => 'custom'])->get_status() === 200);
$html = do_blocks(get_post($post)->post_content);
$check('the required field is marked in the built-in form', substr_count($html, ' required aria-required="true"') === 1 && strpos($html, 'page-generator-required') !== false);
$call('PUT', $route, ['schema' => $required_schema, 'forms' => 'custom', 'editorMode' => 'elementor']);
$check('Elementor keeps the required field', substr_count(get_post_meta($post, '_elementor_data', true), 'aria-required') === 1);
$call('PUT', $route, ['schema' => $schema]);

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

// Two-way bridge: edits made to the saved blocks come back into the schema.
$text = function ($id, $label, $y, $extra = []) { return ['id' => $id, 'type' => 'text', 'text' => $label, 'content' => $label, 'bbox' => ['x' => 40, 'y' => $y, 'width' => 300, 'height' => 30], 'settings' => ['x' => 40, 'y' => $y, 'width' => 300, 'height' => 30, 'fontSize' => 20], 'style' => ['fontSize' => 20, 'color' => '#111111'] + $extra, 'children' => [], 'elements' => []]; };
$kids = [
    $text('t1', 'Hello', 40),
    $text('t2', 'Delete me', 90),
    ['id' => 'b1', 'type' => 'button', 'text' => 'Buy', 'content' => 'Buy', 'bbox' => ['x' => 40, 'y' => 140, 'width' => 120, 'height' => 44], 'settings' => ['x' => 40, 'y' => 140, 'width' => 120, 'height' => 44], 'style' => ['background' => '#2563eb', 'color' => '#ffffff', 'borderRadius' => 8], 'behavior' => ['type' => 'link', 'url' => 'https://example.com/'], 'children' => [], 'elements' => []],
];
$sync_schema = ['version' => 2, 'title' => 'Sync', 'sections' => [['id' => 's1', 'type' => 'section', 'settings' => ['sourceWidth' => 1000, 'sourceHeight' => 400, 'direction' => 'column', 'gap' => 16], 'bbox' => ['x' => 0, 'y' => 0, 'width' => 1000, 'height' => 400], 'style' => ['background' => '#ffffff'], 'children' => $kids, 'elements' => $kids]]];
$call('PUT', $route, ['schema' => $sync_schema, 'layout' => 'pixel', 'editorMode' => 'gutenberg']);
$content = get_post($post)->post_content;
$check('every block carries its node id', strpos($content, '"pgId":"t1"') !== false && strpos($content, '"pgId":"b1"') !== false && strpos($content, '"pgId":"s1"') !== false);
$node = function ($id) use ($call, $route) {
    $found = null;
    $walk = function ($nodes) use (&$walk, &$found, $id) { foreach ((array) $nodes as $n) { if (is_array($n) && ($n['id'] ?? '') === $id) $found = $n; if (is_array($n)) $walk($n['children'] ?? []); } };
    $walk($call('GET', $route)->get_data()['schema']['sections']);
    return $found;
};
$edited = str_replace('>Hello<', '>Hello world<', $content);
$edited = preg_replace('/("pgId":"t1","pgBox":\{"x":)40/', '${1}95', $edited, 1, $moved);
$edited = str_replace('#111111', '#ff0000', $edited);
$edited = str_replace('>Buy<', '>Buy now<', $edited);
$edited = preg_replace('#<!-- wp:paragraph \{[^}]*"pgId":"t2".*?<!-- /wp:paragraph -->\s*#s', '', $edited, 1, $deleted);
$edited = preg_replace('#(</div>\s*<!-- /wp:group -->\s*</div>\s*<!-- /wp:group -->)#', "<!-- wp:paragraph -->\n<p>Brand new</p>\n<!-- /wp:paragraph -->\n\n\$1", $edited, 1, $added);
$check('the test edits were applied to the content', $moved === 1 && $deleted === 1 && $added === 1);
wp_update_post(['ID' => $post, 'post_content' => wp_slash($edited)]);
$t1 = $node('t1');
$check('edited text reaches the schema', ($t1['text'] ?? '') === 'Hello world' && ($t1['content'] ?? '') === 'Hello world');
$check('a moved block updates its box', (int) ($t1['bbox']['x'] ?? 0) === 95 && (int) ($t1['settings']['x'] ?? 0) === 95);
$check('a recoloured block updates its colour', ($t1['style']['color'] ?? '') === '#ff0000');
$check('an untouched property is kept', (int) ($t1['style']['fontSize'] ?? 0) === 20 && (int) ($t1['bbox']['y'] ?? 0) === 40);
$check('button text is read from the inner button', ($node('b1')['text'] ?? '') === 'Buy now' && ($node('b1')['behavior']['url'] ?? '') === 'https://example.com/');
$check('a deleted block removes its node', $node('t2') === null);
$new = null;
foreach ($call('GET', $route)->get_data()['schema']['sections'][0]['children'] as $child) if (($child['text'] ?? '') === 'Brand new') $new = $child;
$check('a new block becomes a node', $new !== null && ($new['type'] ?? '') === 'text');
$check('the new block received its id in the content', $new !== null && strpos(get_post($post)->post_content, '"pgId":"' . $new['id'] . '"') !== false);
$call('PUT', $route, ['schema' => $call('GET', $route)->get_data()['schema'], 'layout' => 'pixel']);
$rebuilt = get_post($post)->post_content;
$check('rebuilding from the merged schema keeps the edits', strpos($rebuilt, 'Hello world') !== false && strpos($rebuilt, 'Delete me') === false && strpos($rebuilt, 'Brand new') !== false);
$before_hash = md5(get_post_meta($post, '_page_generator_schema', true));
wp_update_post(['ID' => $post, 'post_content' => wp_slash($rebuilt)]);
$check('saving unchanged blocks leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $before_hash);

// Two-way bridge for Elementor: what Elementor saves comes back into the schema (ids of elements are the ids of nodes).
$call('PUT', $route, ['schema' => $sync_schema, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$check('Elementor elements carry the node ids', is_array($tree) && json_encode($tree) !== false && strpos(json_encode($tree), '"id":"t1"') !== false && strpos(json_encode($tree), '"id":"b1"') !== false);
$check('the exported element ids are remembered', in_array('t1', (array) json_decode(get_post_meta($post, '_page_generator_el_ids', true), true), true));
$el_sync = null;
foreach ((array) ($GLOBALS['wp_filter']['elementor/document/after_save']->callbacks ?? []) as $callbacks) foreach ($callbacks as $callback) if (is_array($callback['function']) && ($callback['function'][1] ?? '') === 'sync_elementor_to_schema') $el_sync = $callback['function'];
$check('the Elementor sync is hooked on save', $el_sync !== null);
$stub = new class($post) { private $id; public function __construct($id) { $this->id = $id; } public function get_main_id() { return $this->id; } };
$edit = function (&$nodes, $id, $fn) use (&$edit) { foreach ($nodes as &$n) { if (($n['id'] ?? '') === $id) $fn($n); if (!empty($n['elements'])) $edit($n['elements'], $id, $fn); } unset($n); };
$drop = function ($nodes, $id) use (&$drop) { $out = []; foreach ($nodes as $n) { if (($n['id'] ?? '') === $id) continue; if (!empty($n['elements'])) $n['elements'] = $drop($n['elements'], $id); $out[] = $n; } return $out; };
$edited_tree = $tree;
$edit($edited_tree, 't1', function (&$n) { $n['settings']['editor'] = '<p>Hello Elementor</p>'; $n['settings']['_offset_x']['size'] = 95; $n['settings']['text_color'] = '#00aa00'; $n['settings']['typography_font_size']['size'] = 26; });
$edit($edited_tree, 'b1', function (&$n) { $n['settings']['text'] = 'Buy later'; $n['settings']['link']['url'] = 'https://example.org/'; });
$edit($edited_tree, 's1', function (&$n) { $n['elements'][] = ['id' => 'abc1234', 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => ['title' => 'Added in Elementor', '_position' => 'absolute', '_offset_x' => ['size' => 30], '_offset_y' => ['size' => 250], '_element_custom_width' => ['size' => 280]], 'elements' => []]; });
$edited_tree = $drop($edited_tree, 't2');
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($edited_tree)));
call_user_func($el_sync, $stub, ['elements' => $edited_tree]);
$t1 = $node('t1');
$check('Elementor text reaches the schema', ($t1['text'] ?? '') === 'Hello Elementor');
$check('Elementor position reaches the schema', (int) ($t1['bbox']['x'] ?? 0) === 95 && (int) ($t1['bbox']['y'] ?? 0) === 40);
$check('Elementor colour and size reach the schema', ($t1['style']['color'] ?? '') === '#00aa00' && (int) ($t1['style']['fontSize'] ?? 0) === 26);
$check('Elementor button text and link reach the schema', ($node('b1')['text'] ?? '') === 'Buy later' && ($node('b1')['behavior']['url'] ?? '') === 'https://example.org/');
$check('a widget deleted in Elementor removes its node', $node('t2') === null);
$added = $node('abc1234');
$check('a widget added in Elementor becomes a node', ($added['text'] ?? '') === 'Added in Elementor' && ($added['type'] ?? '') === 'heading' && (int) ($added['bbox']['y'] ?? 0) === 250);
$hash = md5(get_post_meta($post, '_page_generator_schema', true));
call_user_func($el_sync, $stub, ['elements' => $edited_tree]);
$check('saving unchanged Elementor data leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $hash);
$call('PUT', $route, ['schema' => $call('GET', $route)->get_data()['schema'], 'layout' => 'pixel', 'editorMode' => 'elementor']);
$check('rebuilding Elementor from the merged schema keeps the edits', strpos(get_post_meta($post, '_elementor_data', true), 'Hello Elementor') !== false && strpos(get_post_meta($post, '_elementor_data', true), 'Delete me') === false && strpos(get_post_meta($post, '_elementor_data', true), 'Added in Elementor') !== false);

// Forms in both bridges: captions, placeholders, required flags and the submit text edited in the editors come back into the schema.
$field = function ($id, $label, $placeholder, $y, $required = false, $type = 'text') { return ['id' => $id, 'type' => 'form-field', 'fieldType' => $type, 'label' => $label, 'placeholder' => $placeholder, 'required' => $required, 'bbox' => ['x' => 30, 'y' => $y, 'width' => 300, 'height' => 40], 'settings' => ['x' => 30, 'y' => $y, 'width' => 300, 'height' => 40], 'labelBox' => ['height' => 14], 'style' => ['background' => '#ffffff'], 'children' => [], 'elements' => []]; };
$form_kids = [
    $field('ff1', 'Name', 'Your name', 40),
    $field('ff2', 'Email', 'you@example.com', 110, true, 'email'),
    ['id' => 'fb1', 'type' => 'button', 'text' => 'Send', 'content' => 'Send', 'bbox' => ['x' => 30, 'y' => 180, 'width' => 120, 'height' => 40], 'settings' => ['x' => 30, 'y' => 180, 'width' => 120, 'height' => 40], 'style' => ['background' => '#2563eb', 'color' => '#ffffff'], 'children' => [], 'elements' => []],
];
$form_node = ['id' => 'fm1', 'type' => 'form', 'bbox' => ['x' => 40, 'y' => 40, 'width' => 400, 'height' => 260], 'settings' => ['x' => 40, 'y' => 40, 'width' => 400, 'height' => 260], 'style' => ['background' => '#f8fafc'], 'children' => $form_kids, 'elements' => $form_kids];
$form_schema = ['version' => 2, 'title' => 'Forms', 'sections' => [['id' => 'fs1', 'type' => 'section', 'settings' => ['sourceWidth' => 600, 'sourceHeight' => 400, 'direction' => 'column', 'gap' => 16], 'bbox' => ['x' => 0, 'y' => 0, 'width' => 600, 'height' => 400], 'style' => ['background' => '#ffffff'], 'children' => [$form_node], 'elements' => [$form_node]]]];
$form_field = function ($id) use ($call, $route) {
    $found = null;
    $walk = function ($nodes) use (&$walk, &$found, $id) { foreach ((array) $nodes as $n) { if (is_array($n) && ($n['id'] ?? '') === $id) $found = $n; if (is_array($n)) $walk($n['children'] ?? []); } };
    $walk($call('GET', $route)->get_data()['schema']['sections']);
    return $found;
};
$call('PUT', $route, ['schema' => $form_schema, 'layout' => 'pixel', 'editorMode' => 'gutenberg', 'forms' => 'custom']);
$form_content = get_post($post)->post_content;
$check('a form is exported as a component block with its node tree', strpos($form_content, 'wp:page-generator/component') !== false && strpos($form_content, '"id":"ff2"') !== false);
$edit_blocks = function ($blocks) use (&$edit_blocks) {
    foreach ($blocks as &$block) {
        if (($block['blockName'] ?? '') === 'page-generator/component' && is_array($block['attrs']['node'] ?? null)) {
            $mut = function (&$n) use (&$mut) {
                if (($n['id'] ?? '') === 'ff1') $n['label'] = 'Full name';
                if (($n['id'] ?? '') === 'ff2') { $n['required'] = false; $n['placeholder'] = 'mail@example.org'; }
                if (($n['id'] ?? '') === 'fb1') { $n['text'] = 'Submit'; $n['content'] = 'Submit'; }
                foreach (['children', 'elements'] as $k) if (!empty($n[$k])) foreach ($n[$k] as &$c) $mut($c);
            };
            $mut($block['attrs']['node']);
        }
        if (!empty($block['innerBlocks'])) $block['innerBlocks'] = $edit_blocks($block['innerBlocks']);
    }
    return $blocks;
};
wp_update_post(['ID' => $post, 'post_content' => wp_slash(serialize_blocks($edit_blocks(parse_blocks($form_content))))]);
$check('a field caption edited in the block reaches the schema', ($form_field('ff1')['label'] ?? '') === 'Full name');
$check('a field placeholder and required flag edited in the block reach the schema', ($form_field('ff2')['placeholder'] ?? '') === 'mail@example.org' && empty($form_field('ff2')['required']));
$check('the submit text edited in the block reaches the schema', ($form_field('fb1')['text'] ?? '') === 'Submit');
$check('form geometry and untouched fields stay as they were', (int) ($form_field('fm1')['bbox']['width'] ?? 0) === 400 && ($form_field('ff1')['placeholder'] ?? '') === 'Your name');
$form_hash = md5(get_post_meta($post, '_page_generator_schema', true));
wp_update_post(['ID' => $post, 'post_content' => wp_slash(get_post($post)->post_content)]);
$check('saving unchanged form blocks leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $form_hash);

$call('PUT', $route, ['schema' => $form_schema, 'layout' => 'pixel', 'editorMode' => 'elementor', 'forms' => 'custom']);
$form_tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$form_json = json_encode($form_tree);
$check('the built-in form is an HTML widget whose fields carry their node ids', strpos($form_json, 'data-block-id=\\"ff1\\"') !== false && strpos($form_json, 'data-block-id=\\"fb1\\"') !== false);
$edit_html = function (&$nodes) use (&$edit_html) {
    foreach ($nodes as &$n) {
        if (($n['widgetType'] ?? '') === 'html' && strpos($n['settings']['html'] ?? '', 'data-block-id="ff1"') !== false) {
            $h = $n['settings']['html'];
            $h = str_replace('placeholder="Your name"', 'placeholder="Your full name"', $h);
            $h = preg_replace('#(data-block-id="ff2".*?)\srequired(?: aria-required="true")?#s', '$1', $h, 1);
            $h = str_replace('>Send</button>', '>Submit</button>', $h);
            $n['settings']['html'] = $h;
        }
        if (!empty($n['elements'])) $edit_html($n['elements']);
    }
    unset($n);
};
$form_edit_tree = $form_tree;
$edit_html($form_edit_tree);
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($form_edit_tree)));
call_user_func($el_sync, $stub, ['elements' => $form_edit_tree]);
$check('an edited placeholder in the Elementor form reaches the schema', ($form_field('ff1')['placeholder'] ?? '') === 'Your full name');
$check('a removed required attribute in the Elementor form reaches the schema', empty($form_field('ff2')['required']) && ($form_field('ff2')['label'] ?? '') === 'Email');
$check('an edited submit text in the Elementor form reaches the schema', ($form_field('fb1')['text'] ?? '') === 'Submit');
$form_hash = md5(get_post_meta($post, '_page_generator_schema', true));
call_user_func($el_sync, $stub, ['elements' => $form_edit_tree]);
$check('saving an unchanged Elementor form leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $form_hash);


// The order of the blocks (and of the Elementor elements) is the order of the nodes: moving a block in the editor moves its node.
$child_ids = function ($section_id) use ($call, $route) {
    $ids = [];
    $find = function ($nodes) use (&$find, &$ids, $section_id) { foreach ((array) $nodes as $n) { if (!is_array($n)) continue; if (($n['id'] ?? '') === $section_id) $ids = array_map(function ($c) { return $c['id'] ?? ''; }, $n['children'] ?? []); $find($n['children'] ?? []); } };
    $find($call('GET', $route)->get_data()['schema']['sections']);
    return $ids;
};
$call('PUT', $route, ['schema' => $sync_schema, 'layout' => 'pixel', 'editorMode' => 'gutenberg']);
$before_order = $child_ids('s1');
$reverse_section = function ($blocks) use (&$reverse_section) {
    foreach ($blocks as &$block) {
        if (($block['attrs']['pgId'] ?? '') === 's1' && !empty($block['innerBlocks'])) {
            $inner = array_values(array_filter($block['innerBlocks'], function ($b) { return !empty($b['blockName']); }));
            $block['innerBlocks'] = array_reverse($inner);
            $block['innerContent'] = array_merge([$block['innerContent'][0] ?? ''], array_fill(0, count($inner), null), [end($block['innerContent']) ?: '']);
        } elseif (!empty($block['innerBlocks'])) {
            $block['innerBlocks'] = $reverse_section($block['innerBlocks']);
        }
    }
    return $blocks;
};
wp_update_post(['ID' => $post, 'post_content' => wp_slash(serialize_blocks($reverse_section(parse_blocks(get_post($post)->post_content))))]);
$after_order = $child_ids('s1');
$check('the starting order of the section is t1, t2, b1', $before_order === ['t1', 't2', 'b1']);
$check('blocks moved in the editor reorder their nodes', $after_order === ['b1', 't2', 't1']);
$order_hash = md5(get_post_meta($post, '_page_generator_schema', true));
wp_update_post(['ID' => $post, 'post_content' => wp_slash(get_post($post)->post_content)]);
$check('saving blocks in the same order leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $order_hash);

$call('PUT', $route, ['schema' => $sync_schema, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$order_tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$reverse_elements = function (&$nodes) use (&$reverse_elements) {
    foreach ($nodes as &$n) {
        if (($n['id'] ?? '') === 's1' && !empty($n['elements'])) $n['elements'] = array_reverse($n['elements']);
        elseif (!empty($n['elements'])) $reverse_elements($n['elements']);
    }
    unset($n);
};
$reversed_tree = $order_tree;
$reverse_elements($reversed_tree);
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($reversed_tree)));
call_user_func($el_sync, $stub, ['elements' => $reversed_tree]);
$check('elements moved in Elementor reorder their nodes', $child_ids('s1') === ['b1', 't2', 't1']);


// Pictures behind a container (a backdrop, or the picture of a ramp with more than three stops) come back from Elementor.
$pic_schema = $sync_schema;
$pic_schema['sections'][0]['style'] = ['background' => '#ffffff', 'backgroundImage' => ['url' => 'http://localhost/wp-content/uploads/pic-a.jpg', 'attachmentId' => 0]];
$call('PUT', $route, ['schema' => $pic_schema, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$pic_tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$set_picture = function (&$nodes, $url) use (&$set_picture) {
    foreach ($nodes as &$n) {
        if (($n['id'] ?? '') === 's1') $n['settings']['background_image'] = $url === '' ? ['url' => '', 'id' => ''] : ['url' => $url, 'id' => 7];
        elseif (!empty($n['elements'])) $set_picture($n['elements'], $url);
    }
    unset($n);
};
$picture_section = function () use ($call, $route) { foreach ($call('GET', $route)->get_data()['schema']['sections'] as $sec) if (($sec['id'] ?? '') === 's1') return $sec; return []; };
$check('a backdrop picture is exported as the container background', ($pic_tree[0]['settings']['background_image']['url'] ?? '') === 'http://localhost/wp-content/uploads/pic-a.jpg' || strpos(json_encode($pic_tree), 'pic-a.jpg') !== false);
$swapped = $pic_tree;
$set_picture($swapped, 'http://localhost/wp-content/uploads/pic-b.jpg');
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($swapped)));
call_user_func($el_sync, $stub, ['elements' => $swapped]);
$check('a backdrop picture changed in Elementor reaches the schema', ($picture_section()['style']['backgroundImage']['url'] ?? '') === 'http://localhost/wp-content/uploads/pic-b.jpg' && (int) ($picture_section()['style']['backgroundImage']['attachmentId'] ?? 0) === 7);
$cleared = $pic_tree;
$set_picture($cleared, '');
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($cleared)));
call_user_func($el_sync, $stub, ['elements' => $cleared]);
$check('a backdrop picture removed in Elementor leaves the schema', empty($picture_section()['style']['backgroundImage']));
$ramp_schema = $sync_schema;
$ramp_schema['sections'][0]['style'] = ['background' => '#e11d48', 'gradient' => ['type' => 'linear', 'angle' => 90, 'stops' => [['pos' => 0, 'color' => '#e11d48'], ['pos' => 33, 'color' => '#f59e0b'], ['pos' => 66, 'color' => '#10b981'], ['pos' => 100, 'color' => '#2563eb']]], 'gradientImage' => ['url' => 'http://localhost/wp-content/uploads/ramp-a.png', 'attachmentId' => 0]];
$call('PUT', $route, ['schema' => $ramp_schema, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$ramp_tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$check('a ramp of four stops is exported as a picture in Elementor', strpos(json_encode($ramp_tree), 'ramp-a.png') !== false);
$ramp_swapped = $ramp_tree;
$set_picture($ramp_swapped, 'http://localhost/wp-content/uploads/ramp-b.png');
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($ramp_swapped)));
call_user_func($el_sync, $stub, ['elements' => $ramp_swapped]);
$check('the picture of a ramp changed in Elementor reaches gradientImage, not backgroundImage', ($picture_section()['style']['gradientImage']['url'] ?? '') === 'http://localhost/wp-content/uploads/ramp-b.png' && empty($picture_section()['style']['backgroundImage']) && count($picture_section()['style']['gradient']['stops'] ?? []) === 4);


// Spacing of a flow page edited in the editors (top margin, left offset, gap, padding) is remembered as overrides in style.flow.
$flow_node = function ($id) use ($call, $route) {
    $found = null;
    $walk = function ($nodes) use (&$walk, &$found, $id) { foreach ((array) $nodes as $n) { if (is_array($n) && ($n['id'] ?? '') === $id) $found = $n; if (is_array($n)) $walk($n['children'] ?? []); } };
    $walk($call('GET', $route)->get_data()['schema']['sections']);
    return $found;
};
$flow_schema = $sync_schema;
$call('PUT', $route, ['schema' => $flow_schema, 'layout' => 'flow', 'editorMode' => 'gutenberg']);
$flow_content = get_post($post)->post_content;
$check('a flow page remembers the spacing it was exported with', is_array(json_decode(get_post_meta($post, '_page_generator_flow_state', true), true)) && strpos(get_post_meta($post, '_page_generator_flow_state', true), '"t1"') !== false);
$set_spacing = function ($blocks) use (&$set_spacing) {
    foreach ($blocks as &$block) {
        if (($block['attrs']['pgId'] ?? '') === 't1' && is_array($block['attrs']['pgFlow'] ?? null)) { $block['attrs']['pgFlow']['mt'] = 77; $block['attrs']['pgFlow']['ml'] = 33; }
        if (!empty($block['innerBlocks'])) $block['innerBlocks'] = $set_spacing($block['innerBlocks']);
    }
    return $blocks;
};
wp_update_post(['ID' => $post, 'post_content' => wp_slash(serialize_blocks($set_spacing(parse_blocks($flow_content))))]);
$check('spacing edited in a block reaches style.flow of its node', (int) ($flow_node('t1')['style']['flow']['mt'] ?? -1) === 77 && (int) ($flow_node('t1')['style']['flow']['ml'] ?? -1) === 33);
$check('spacing that was not touched is not turned into an override', empty($flow_node('b1')['style']['flow']));
$flow_hash = md5(get_post_meta($post, '_page_generator_schema', true));
wp_update_post(['ID' => $post, 'post_content' => wp_slash(get_post($post)->post_content)]);
$check('saving the same spacing again leaves the schema alone', md5(get_post_meta($post, '_page_generator_schema', true)) === $flow_hash);
$call('PUT', $route, ['schema' => $call('GET', $route)->get_data()['schema'], 'layout' => 'flow', 'editorMode' => 'gutenberg']);
$check('a rebuilt flow page keeps the edited spacing', preg_match('/"pgId":"t1".*?"pgFlow":\{[^}]*"mt":77/s', get_post($post)->post_content) === 1 || preg_match('/"pgFlow":\{[^}]*"mt":77[^}]*\}[^}]*"pgId":"t1"/s', get_post($post)->post_content) === 1);

$call('PUT', $route, ['schema' => $flow_schema, 'layout' => 'flow', 'editorMode' => 'elementor']);
$flow_tree = json_decode(get_post_meta($post, '_elementor_data', true), true);
$check('an Elementor flow page remembers the spacing it was exported with', strpos(get_post_meta($post, '_page_generator_el_flow_state', true), '"mt"') !== false);
$set_margin = function (&$nodes) use (&$set_margin) {
    foreach ($nodes as &$n) {
        if (in_array($n['id'] ?? '', ['t1', 't1p'], true)) {
            $key = ($n['elType'] ?? '') === 'container' ? 'margin' : '_margin';
            $n['settings'][$key] = ['unit' => 'px', 'top' => '61', 'right' => '0', 'bottom' => '0', 'left' => '0', 'isLinked' => false];
        }
        if (!empty($n['elements'])) $set_margin($n['elements']);
    }
    unset($n);
};
$margin_tree = $flow_tree;
$set_margin($margin_tree);
update_post_meta($post, '_elementor_data', wp_slash(wp_json_encode($margin_tree)));
call_user_func($el_sync, $stub, ['elements' => $margin_tree]);
$check('a margin edited in Elementor reaches style.flow of its node', (int) ($flow_node('t1')['style']['flow']['mt'] ?? -1) === 61);
$call('PUT', $route, ['schema' => $call('GET', $route)->get_data()['schema'], 'layout' => 'flow', 'editorMode' => 'elementor']);
$check('a rebuilt Elementor flow page keeps the edited margin', strpos(get_post_meta($post, '_elementor_data', true), '"top":"61"') !== false);
$call('PUT', $route, ['schema' => $sync_schema, 'layout' => 'pixel', 'editorMode' => 'gutenberg']);

// Font family names: style.fontFamily holds a slug of a shipped web font; both exporters write its class, the bridges read it back.
$font_schema = $flow_schema;
$set_font = function (&$nodes) use (&$set_font) {
    foreach ($nodes as &$n) {
        if (($n['id'] ?? '') === 't1') $n['style']['fontFamily'] = 'roboto';
        foreach (['children', 'elements'] as $key) if (!empty($n[$key])) $set_font($n[$key]);
    }
    unset($n);
};
$set_font($font_schema['sections']);
$call('PUT', $route, ['schema' => $font_schema, 'layout' => 'pixel', 'editorMode' => 'gutenberg']);
$check('a font slug becomes the class of the block', strpos(get_post($post)->post_content, 'pg-font-roboto') !== false);
$check('the font survives the Gutenberg bridge', ($flow_node('t1')['style']['fontFamily'] ?? '') === 'roboto');
$call('PUT', $route, ['schema' => $font_schema, 'layout' => 'pixel', 'editorMode' => 'elementor']);
$check('a font slug becomes a CSS class of the Elementor widget', strpos(get_post_meta($post, '_elementor_data', true), 'pg-font-roboto') !== false);
$check('the registered fonts have a stylesheet', is_file(dirname(__DIR__) . '/assets/fonts.css') && strpos(file_get_contents(dirname(__DIR__) . '/assets/fonts.css'), '.pg-font-roboto') !== false);

$call('PUT', $route, ['schema' => $schema, 'editorMode' => 'gutenberg']);
$call('PUT', $route, ['schema' => $schema]);
exit($failed ? 1 : 0);
