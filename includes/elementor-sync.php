<?php
defined('ABSPATH') || exit;

/**
 * Return path of the two-way bridge for Elementor: what is changed in Elementor's editor is merged back into the stored Page Schema.
 *
 * The exporter gives every Elementor element the id of its schema node (a filled text node is a container with the id plus "p"
 * around its widget), and Elementor keeps ids when a document is edited. After each save in Elementor the saved tree is read back:
 * texts, links, colours, size and weight of the type, radius, picture and (in pixel mode) the position and size are copied onto the
 * node with that id; an element that disappeared removes its node; a widget Elementor created becomes a new node under its parent.
 */
trait Page_Generator_Elementor_Sync {
    private function register_elementor_sync() {
        add_action('elementor/document/after_save', [$this, 'sync_elementor_to_schema'], 20, 2);
    }

    private function elementor_element_ids($elements) {
        $ids = [];
        $walk = function ($list) use (&$walk, &$ids) {
            foreach ((array) $list as $element) {
                if (!is_array($element)) continue;
                if (!empty($element['id']) && is_string($element['id'])) $ids[] = $element['id'];
                if (!empty($element['elements'])) $walk($element['elements']);
            }
        };
        $walk($elements);
        return $ids;
    }

    private function store_elementor_ids($post_id, $elements) {
        update_post_meta($post_id, '_page_generator_el_ids', wp_slash(wp_json_encode($this->elementor_element_ids($elements))));
    }

    public function sync_elementor_to_schema($document, $data = []) {
        if (!is_object($document) || !method_exists($document, 'get_main_id')) return;
        $post_id = (int) $document->get_main_id();
        $schema = $post_id ? $this->rest_saved_schema($post_id) : null;
        if (!$schema) return;
        $elements = is_array($data['elements'] ?? null) ? $data['elements'] : json_decode((string) get_post_meta($post_id, '_elementor_data', true), true);
        if (!is_array($elements)) return;
        $previous = json_decode((string) get_post_meta($post_id, '_page_generator_el_ids', true), true);
        $result = $this->merge_elementor_into_schema($schema, $elements, is_array($previous) ? $previous : []);
        if ($result['changed']) {
            update_post_meta($post_id, '_page_generator_schema', wp_slash(wp_json_encode($result['schema'])));
        }
        $this->store_elementor_ids($post_id, $elements);
    }

    /** Pure part (used by the tests): returns ['schema' => merged schema, 'changed' => bool]. */
    public function merge_elementor_into_schema($schema, $elements, $previous = []) {
        $index = [];
        if (!empty($schema['sections']) && is_array($schema['sections'])) $this->sync_index($schema['sections'], $index);
        if (!empty($schema['variants']['mobile']['sections']) && is_array($schema['variants']['mobile']['sections'])) {
            $this->sync_index($schema['variants']['mobile']['sections'], $index);
        }
        $state = ['changed' => false, 'seen' => [], 'orders' => [], 'index' => &$index];
        $this->elsync_walk($elements, ['x' => 0, 'y' => 0], null, $state);
        // Nodes whose element is gone (the node itself or its plate).
        $removed = [];
        foreach ($previous as $element_id) {
            if (isset($state['seen'][$element_id])) continue;
            $node_id = isset($index[$element_id]) ? $element_id : (substr($element_id, -1) === 'p' && isset($index[substr($element_id, 0, -1)]) ? substr($element_id, 0, -1) : null);
            if ($node_id !== null && !isset($state['seen'][$node_id]) && !isset($state['seen'][$node_id . 'p'])) $removed[$node_id] = true;
        }
        if ($removed) {
            $ids = array_keys($removed);
            if (!empty($schema['sections'])) $schema['sections'] = $this->sync_prune($schema['sections'], $ids, $state);
            if (!empty($schema['variants']['mobile']['sections'])) {
                $schema['variants']['mobile']['sections'] = $this->sync_prune($schema['variants']['mobile']['sections'], $ids, $state);
            }
        }
        unset($state['index']);
        // The order of the elements inside a container is the order of its nodes.
        if ($state['orders']) {
            if (!empty($schema['sections'])) $schema['sections'] = $this->sync_apply_orders($schema['sections'], $state['orders'], $state);
            if (!empty($schema['variants']['mobile']['sections'])) {
                $schema['variants']['mobile']['sections'] = $this->sync_apply_orders($schema['variants']['mobile']['sections'], $state['orders'], $state);
            }
        }
        return ['schema' => $schema, 'changed' => $state['changed']];
    }

    private function el_read_size($value) {
        return is_array($value) && isset($value['size']) && is_numeric($value['size']) ? (float) $value['size'] : null;
    }

    private function elsync_walk($elements, $origin, $parent_id, &$state) {
        foreach ((array) $elements as $element) {
            if (!is_array($element) || empty($element['id'])) continue;
            $id = (string) $element['id'];
            $settings = is_array($element['settings'] ?? null) ? $element['settings'] : [];
            $container = ($element['elType'] ?? '') === 'container';
            $state['seen'][$id] = true;
            $node_id = isset($state['index'][$id]) ? $id : (substr($id, -1) === 'p' && isset($state['index'][substr($id, 0, -1)]) ? substr($id, 0, -1) : null);
            // The geometry of an absolutely placed element (a container, or a widget without a plate around it).
            $absolute = null;
            $own_origin = $origin;
            $placed = ($container ? ($settings['position'] ?? '') : ($settings['_position'] ?? '')) === 'absolute';
            if ($placed) {
                $x = $this->el_read_size($settings['_offset_x'] ?? null);
                $y = $this->el_read_size($settings['_offset_y'] ?? null);
                $w = $this->el_read_size($container ? ($settings['width'] ?? null) : ($settings['_element_custom_width'] ?? null));
                $h = $container ? $this->el_read_size($settings['min_height'] ?? null) : null;
                if ($x !== null && $y !== null) {
                    $absolute = ['x' => $origin['x'] + $x, 'y' => $origin['y'] + $y, 'width' => $w, 'height' => $h];
                    if ($container) $own_origin = ['x' => $absolute['x'], 'y' => $absolute['y']];
                }
            }
            if ($node_id !== null) {
                $state['seen'][$node_id] = true;
                foreach ($state['index'][$node_id] as &$ref) {
                    if ($this->elsync_update_node($ref, $element, $settings, $absolute, $container)) $state['changed'] = true;
                }
                unset($ref);
            } elseif ($parent_id !== null && ($new = $this->elsync_new_node($element, $settings, $absolute))) {
                $state['changed'] = true;
                $state['seen'][$new['id']] = true;
                foreach ($state['index'][$parent_id] as &$parent) {
                    $parent['children'][] = $new;
                    if (!empty($parent['elements'])) $parent['elements'][] = $new;
                }
                unset($parent);
                $state['index'][$new['id']] = [$new];
                continue;
            }
            if (!empty($element['elements'])) {
                $this->elsync_walk($element['elements'], $own_origin, $node_id !== null ? $node_id : $parent_id, $state);
                if ($node_id !== null) {
                    $order = [];
                    foreach ($element['elements'] as $child) {
                        $child_element = is_array($child) ? (string) ($child['id'] ?? '') : '';
                        $child_node = isset($state['index'][$child_element]) ? $child_element : (substr($child_element, -1) === 'p' && isset($state['index'][substr($child_element, 0, -1)]) ? substr($child_element, 0, -1) : '');
                        if ($child_node !== '' && !in_array($child_node, $order, true)) $order[] = $child_node;
                    }
                    if (count($order) > 1) $state['orders'][$node_id] = $order;
                }
            }
        }
    }

    // ---- Reading an element ------------------------------------------------------------------------------------------------

    private function elsync_text($html) {
        $html = preg_replace('#<br\s*/?>#i', "\n", (string) $html);
        $html = preg_replace('#</p>\s*<p[^>]*>#i', "\n", $html);
        return trim(html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES, 'UTF-8'));
    }

    // Fields of a built-in form read from its markup: id => [label, placeholder, required] (a button: [text]).
    private function elsync_parse_form($html) {
        $found = [];
        if (trim($html) === '' || !class_exists('DOMDocument')) return $found;
        $previous = libxml_use_internal_errors(true);
        $dom = new DOMDocument();
        $dom->loadHTML('<?xml encoding="utf-8"?><body>' . $html . '</body>');
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        $xpath = new DOMXPath($dom);
        $text = function ($element) { return trim(preg_replace('/\s+/', ' ', $element->textContent)); };
        foreach ($xpath->query('//*[@data-block-id][@data-block-type]') as $element) {
            $id = $element->getAttribute('data-block-id');
            $type = $element->getAttribute('data-block-type');
            if ($type === 'button') {
                $found[$id] = ['text' => $text($element)];
                continue;
            }
            if ($type !== 'form-field') continue;
            $control = $xpath->query('.//input|.//select|.//textarea', $element)->item(0);
            if (!$control) continue;
            $required = $control->hasAttribute('required');
            $mark = trim($text($xpath->query('.//*[contains(@class,"page-generator-required")]', $element)->item(0) ?: $dom->createTextNode('')));
            $strip = function ($value) use ($mark) { return trim(preg_replace('/\s*\*$/', '', $mark !== '' ? preg_replace('/' . preg_quote($mark, '/') . '$/', '', trim($value)) : trim($value))); };
            $values = ['required' => $required];
            if ($control->getAttribute('type') === 'checkbox') {
                $values['label'] = $strip($text($element));
            } else {
                $caption = null;
                foreach ($xpath->query('./span[not(contains(@class,"page-generator-required"))]', $element) as $span) { $caption = $span; break; }
                if ($caption) $values['label'] = $strip($text($caption));
                $placeholder = $control->nodeName === 'select' ? $text($xpath->query('.//option', $control)->item(0) ?: $dom->createTextNode('')) : $control->getAttribute('placeholder');
                // Without a caption the asterisk of a required field lives in the placeholder.
                if (!$caption && $required) $placeholder = preg_replace('/\s*\*$/', '', $placeholder);
                $values['placeholder'] = $placeholder;
            }
            $found[$id] = $values;
        }
        return $found;
    }

    private function elsync_radius($value) {
        return is_array($value) && isset($value['top']) && is_numeric($value['top']) ? absint($value['top']) : null;
    }

    private function elsync_update_node(&$node, $element, $settings, $absolute, $container) {
        $changed = false;
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $set = function ($key, $value) use (&$style, &$changed) {
            if ($value === null) return;
            if (($style[$key] ?? null) !== $value) { $style[$key] = $value; $changed = true; }
        };
        if ($absolute) {
            $old = is_array($node['bbox'] ?? null) ? $node['bbox'] : [];
            $new = $old;
            $moved = false;
            foreach (['x' => 'x', 'y' => 'y', 'width' => 'width', 'height' => 'height'] as $key => $source) {
                if ($absolute[$source] === null) continue;
                $value = $this->native_number($absolute[$source]);
                if (!isset($old[$key]) || abs((float) $old[$key] - (float) $value) > .6) { $new[$key] = $value; $moved = true; }
            }
            if ($moved) {
                $node['bbox'] = $new;
                if (is_array($node['settings'] ?? null)) foreach (['x', 'y', 'width', 'height'] as $key) if (isset($new[$key])) $node['settings'][$key] = $new[$key];
                $changed = true;
            }
        }
        $widget = $element['widgetType'] ?? '';
        if ($widget === 'heading' || $widget === 'text-editor' || $widget === 'button') {
            $text = $widget === 'heading' ? $this->elsync_text($settings['title'] ?? '') : ($widget === 'button' ? trim((string) ($settings['text'] ?? '')) : $this->elsync_text($settings['editor'] ?? ''));
            if ((string) ($node['text'] ?? ($node['content'] ?? '')) !== $text) {
                $node['text'] = $text;
                $node['content'] = $text;
                $changed = true;
            }
            $size = $this->el_read_size($settings['typography_font_size'] ?? null);
            if ($size !== null) {
                $old_size = $style['fontSize'] ?? ($node['settings']['fontSize'] ?? null);
                // Elementor's own rule is max(10, size), so a size it clamped is not an edit.
                if (!is_numeric($old_size) || (abs((float) $old_size - $size) > .6 && !($size == 10 && (float) $old_size < 10))) {
                    $set('fontSize', $this->native_number($size));
                    if (is_array($node['settings'] ?? null)) $node['settings']['fontSize'] = $this->native_number($size);
                }
            }
            if (!empty($settings['typography_font_weight']) && is_numeric($settings['typography_font_weight'])) $set('fontWeight', (int) $settings['typography_font_weight']);
            $color = $this->native_color($settings[$widget === 'heading' ? 'title_color' : ($widget === 'button' ? 'button_text_color' : 'text_color')] ?? '');
            if ($color !== '') $set('color', $color);
            if ($widget === 'button') {
                $url = $settings['link']['url'] ?? null;
                if (is_string($url) && ($node['behavior']['url'] ?? '#') !== $url) { $node['behavior']['url'] = $url; $changed = true; }
                $fill = $this->native_color($settings['background_color'] ?? '');
                if ($fill !== '') $set('background', $fill);
                $radius = $this->elsync_radius($settings['border_radius'] ?? null);
                if ($radius !== null && $radius !== absint($style['borderRadius'] ?? 0)) $set('borderRadius', $radius);
            }
        } elseif ($widget === 'html' && in_array($node['type'] ?? '', ['form', 'form-field'], true)) {
            // The built-in form is an HTML widget: its fields carry the id of their node, and their captions, placeholders and
            // required flags are read back from the markup.
            if ($this->sync_form_tree($node, $this->elsync_parse_form((string) ($settings['html'] ?? '')))) $changed = true;
        } elseif ($widget === 'image') {
            $url = $settings['image']['url'] ?? '';
            if ($url && ($node['url'] ?? ($node['asset']['url'] ?? '')) !== $url) { $node['url'] = esc_url_raw($url); $changed = true; }
            if (!empty($settings['image']['id']) && absint($settings['image']['id']) !== absint($node['attachmentId'] ?? 0)) { $node['attachmentId'] = absint($settings['image']['id']); $changed = true; }
        } elseif ($container) {
            if (($settings['background_background'] ?? '') === 'classic') {
                $fill = $this->native_color($settings['background_color'] ?? '');
                if ($fill !== '' && empty($style['gradient'])) $set('background', $fill);
                // The picture behind a container: a soft backdrop cut from the screenshot, or the picture of a ramp with more than three stops
                // (see elementor_plate_settings). Changing or removing it in Elementor changes or removes it on the node.
                $image = is_array($settings['background_image'] ?? null) ? $settings['background_image'] : [];
                $image_url = esc_url_raw((string) ($image['url'] ?? ''));
                $image_key = !empty($style['gradient']['stops']) && count($style['gradient']['stops']) > 3 ? 'gradientImage' : 'backgroundImage';
                if ($image_url !== '') {
                    $picture = ['url' => $image_url, 'attachmentId' => absint($image['id'] ?? 0)];
                    if (($style[$image_key] ?? null) !== $picture) { $style[$image_key] = $picture; $changed = true; }
                } elseif (!empty($style[$image_key])) {
                    unset($style[$image_key]);
                    $changed = true;
                }
            }
            $radius = $this->elsync_radius($settings['border_radius'] ?? null);
            if ($radius !== null && $radius !== absint($style['borderRadius'] ?? 0)) $set('borderRadius', $radius);
        }
        if ($changed) $node['style'] = $style;
        return $changed;
    }

    private function elsync_new_node($element, $settings, $absolute) {
        $types = ['heading' => 'heading', 'text-editor' => 'text', 'button' => 'button', 'image' => 'image'];
        $widget = $element['widgetType'] ?? '';
        if (!isset($types[$widget])) return null;
        $id = sanitize_key((string) $element['id']);
        if ($id === '') return null;
        $node = ['id' => $id, 'type' => $types[$widget], 'role' => $types[$widget], 'children' => [], 'elements' => [], 'style' => [], 'behavior' => ['type' => 'none'],
            'confidence' => 1, 'source' => ['detectedBy' => ['elementor-editor'], 'manual' => true]];
        if ($absolute && $absolute['width'] !== null) {
            $node['bbox'] = ['x' => $this->native_number($absolute['x']), 'y' => $this->native_number($absolute['y']), 'width' => $this->native_number($absolute['width']), 'height' => $this->native_number($absolute['height'] ?? 30)];
            $node['settings'] = $node['bbox'];
        }
        $probe = $node;
        $this->elsync_update_node($probe, $element, $settings, null, false);
        $node = $probe;
        if (!$node['style']) unset($node['style']);
        if ($widget !== 'image' && trim((string) ($node['text'] ?? '')) === '') return null;
        return $node;
    }
}
