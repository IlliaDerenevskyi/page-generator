<?php
defined('ABSPATH') || exit;

/**
 * Return path of the two-way bridge: edits made in the block editor are merged back into the stored Page Schema.
 *
 * Every block the exporter emits for a schema node carries the node id in `pgId`. When the page is saved, the blocks are read back:
 * text, links, colours, radius, weight, images, table cells and (in pixel mode) the pixel box are copied onto the node with that id;
 * a block that disappeared removes its node; a block without an id inside a node becomes a new node (and receives an id).
 * The content itself is left as the user saved it, except that new blocks are given their id.
 */
trait Page_Generator_Block_Sync {
    private $block_sync_suspended = false;

    private function register_block_sync() {
        add_action('wp_after_insert_post', [$this, 'sync_blocks_to_schema'], 20, 4);
    }

    // Ids of the schema nodes that own a block in this content (what the exporter wrote, or what the editor now holds).
    private function block_ids_in($blocks) {
        $ids = [];
        $walk = function ($list) use (&$walk, &$ids) {
            foreach ((array) $list as $block) {
                $id = $block['attrs']['pgId'] ?? '';
                if (is_string($id) && $id !== '') $ids[$id] = true;
                if (!empty($block['innerBlocks'])) $walk($block['innerBlocks']);
            }
        };
        $walk($blocks);
        return array_keys($ids);
    }

    private function store_block_ids($post_id, $content) {
        update_post_meta($post_id, '_page_generator_block_ids', wp_slash(wp_json_encode($this->block_ids_in(parse_blocks($content)))));
    }

    public function sync_blocks_to_schema($post_id, $post, $update = true, $before = null) {
        if ($this->block_sync_suspended || !$update || !$post instanceof WP_Post) return;
        if (wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) return;
        if (strpos((string) $post->post_content, '"pgId"') === false) return;
        // Elementor pages are edited in Elementor; their blocks are not the source.
        if (get_post_meta($post_id, '_elementor_data', true)) return;
        $schema = $this->rest_saved_schema($post_id);
        if (!$schema) return;
        $previous = json_decode((string) get_post_meta($post_id, '_page_generator_block_ids', true), true);
        $flow_state = $this->fsp_load_state($post_id, '_page_generator_flow_state');
        $result = $this->merge_blocks_into_schema($schema, parse_blocks($post->post_content), is_array($previous) ? $previous : [], $flow_state);
        $this->fsp_save_state($post_id, '_page_generator_flow_state', $result['flowState'] ?? []);
        if ($result['changed']) {
            update_post_meta($post_id, '_page_generator_schema', wp_slash(wp_json_encode($result['schema'])));
        }
        if ($result['content'] !== null) {
            // New blocks were given ids: write them into the content without running this sync again.
            $this->block_sync_suspended = true;
            wp_update_post(['ID' => $post_id, 'post_content' => wp_slash($result['content'])]);
            $this->block_sync_suspended = false;
            $this->store_block_ids($post_id, $result['content']);
        } else {
            $this->store_block_ids($post_id, $post->post_content);
        }
    }

    /**
     * Pure part (used by the tests): returns ['schema' => merged schema, 'changed' => bool, 'content' => serialized blocks or null].
     * `$previous` is the list of node ids the blocks carried before this edit; ids that vanished from the blocks lose their node.
     */
    public function merge_blocks_into_schema($schema, $blocks, $previous = [], $flow_state = null) {
        $index = [];
        foreach (['sections'] as $key) {
            if (!empty($schema[$key]) && is_array($schema[$key])) $this->sync_index($schema[$key], $index);
        }
        if (!empty($schema['variants']['mobile']['sections']) && is_array($schema['variants']['mobile']['sections'])) {
            $this->sync_index($schema['variants']['mobile']['sections'], $index);
        }
        $state = ['changed' => false, 'seen' => [], 'created' => false, 'orders' => [], 'index' => &$index];
        $blocks = $this->sync_walk($blocks, ['x' => 0, 'y' => 0], null, $state);
        // Spacing edited in a flow page (see flow-spacing.php).
        $flow_current = $this->fsp_state_from_blocks($blocks);
        if ($this->fsp_record_edits($flow_current, $flow_state, $state['index'])) $state['changed'] = true;
        // Nodes whose block is gone.
        $removed = array_values(array_diff($previous, array_keys($state['seen'])));
        if ($removed) {
            foreach (['sections'] as $key) $schema[$key] = $this->sync_prune($schema[$key], $removed, $state);
            if (!empty($schema['variants']['mobile']['sections'])) {
                $schema['variants']['mobile']['sections'] = $this->sync_prune($schema['variants']['mobile']['sections'], $removed, $state);
            }
        }
        unset($state['index']);
        // The order of the blocks is the order of the nodes (in a flow page it is the layout itself).
        if ($state['orders']) {
            foreach (['sections'] as $key) $schema[$key] = $this->sync_apply_orders($schema[$key] ?? [], $state['orders'], $state);
            if (!empty($schema['variants']['mobile']['sections'])) {
                $schema['variants']['mobile']['sections'] = $this->sync_apply_orders($schema['variants']['mobile']['sections'], $state['orders'], $state);
            }
        }
        return ['schema' => $schema, 'changed' => $state['changed'], 'content' => $state['created'] ? serialize_blocks($blocks) : null, 'flowState' => $flow_current];
    }

    private function sync_index(&$nodes, &$index) {
        foreach ($nodes as &$node) {
            if (!is_array($node)) continue;
            if (!empty($node['id']) && is_string($node['id'])) $index[$node['id']][] = &$node;
            foreach (['children', 'elements'] as $key) {
                if (!empty($node[$key]) && is_array($node[$key])) $this->sync_index($node[$key], $index);
            }
        }
        unset($node);
    }

    private function sync_prune($nodes, $removed, &$state) {
        $kept = [];
        foreach ((array) $nodes as $node) {
            if (is_array($node) && in_array($node['id'] ?? '', $removed, true)) {
                $state['changed'] = true;
                continue;
            }
            if (is_array($node)) {
                foreach (['children', 'elements'] as $key) {
                    if (!empty($node[$key]) && is_array($node[$key])) $node[$key] = $this->sync_prune($node[$key], $removed, $state);
                }
            }
            $kept[] = $node;
        }
        return $kept;
    }

    // Walks the blocks with the same origin rule the exporter used (a boxed block is the origin of what it holds).
    private function sync_walk($blocks, $origin, $parent_id, &$state) {
        foreach ($blocks as $key => $block) {
            if (empty($block['blockName'])) continue;
            $attrs = is_array($block['attrs'] ?? null) ? $block['attrs'] : [];
            $id = is_string($attrs['pgId'] ?? null) ? $attrs['pgId'] : '';
            $box = is_array($attrs['pgBox'] ?? null) ? $attrs['pgBox'] : null;
            if ($id !== '' && isset($state['seen'][$id])) $id = ''; // a duplicated block is a new node
            // A form is one dynamic block holding its whole node tree in an attribute: the fields edited there are read from the attribute.
            if (($block['blockName'] ?? '') === 'page-generator/component' && is_array($attrs['node'] ?? null) && $this->sync_component_tree($attrs['node'], $state)) $state['changed'] = true;
            $absolute = null;
            $own_origin = $origin;
            if ($box && isset($box['x'], $box['y'], $box['w'], $box['h'])) {
                $absolute = ['x' => $origin['x'] + $box['x'], 'y' => $origin['y'] + $box['y'], 'width' => $box['w'], 'height' => $box['h']];
                $own_origin = ['x' => $absolute['x'], 'y' => $absolute['y']];
            }
            if ($id !== '' && isset($state['index'][$id])) {
                $state['seen'][$id] = true;
                foreach ($state['index'][$id] as &$ref) {
                    if ($this->sync_update_node($ref, $block, $absolute, $box)) $state['changed'] = true;
                }
                unset($ref);
            } elseif ($id === '' && $parent_id !== null && ($new = $this->sync_new_node($block, $absolute, $box))) {
                $id = $new['id'];
                $blocks[$key]['attrs']['pgId'] = $id;
                $state['seen'][$id] = true;
                $state['created'] = true;
                $state['changed'] = true;
                // The new node collects the nodes of the blocks inside it, and is attached to its parent afterwards.
                $state['index'][$id] = [];
                $state['index'][$id][] = &$new;
                if (!empty($block['innerBlocks'])) {
                    $blocks[$key]['innerBlocks'] = $this->sync_walk($block['innerBlocks'], $own_origin, $id, $state);
                }
                $state['index'][$id] = [$new];
                foreach ($state['index'][$parent_id] as &$parent) {
                    $parent['children'][] = $new;
                    if (!empty($parent['elements'])) $parent['elements'][] = $new;
                }
                unset($parent, $new);
                continue;
            }
            if (!empty($block['innerBlocks'])) {
                $inner = $this->sync_walk($block['innerBlocks'], $own_origin, ($id !== '' && isset($state['index'][$id])) ? $id : $parent_id, $state);
                $blocks[$key]['innerBlocks'] = $inner;
                if ($id !== '' && isset($state['index'][$id])) {
                    $order = [];
                    foreach ($inner as $child_block) {
                        $child_id = is_string($child_block['attrs']['pgId'] ?? null) ? $child_block['attrs']['pgId'] : '';
                        if ($child_id !== '' && isset($state['seen'][$child_id])) $order[] = $child_id;
                    }
                    if (count($order) > 1) $state['orders'][$id] = $order;
                }
            }
        }
        return $blocks;
    }

    // Puts the children of each node listed in $orders (parent id => child ids in the wanted order) in that order. Children that are not in the
    // list keep their place; the listed ones fill the places the listed ones held, in the new order. Sets $state['changed'] when something moved.
    private function sync_apply_orders($nodes, $orders, &$state) {
        foreach ($nodes as $index => $node) {
            if (!is_array($node)) continue;
            foreach (['children', 'elements'] as $key) {
                if (empty($node[$key]) || !is_array($node[$key])) continue;
                $node[$key] = $this->sync_apply_orders($node[$key], $orders, $state);
            }
            $id = (string) ($node['id'] ?? '');
            if ($id !== '' && isset($orders[$id])) {
                foreach (['children', 'elements'] as $key) {
                    if (empty($node[$key]) || !is_array($node[$key])) continue;
                    $slots = [];
                    $items = [];
                    foreach ($node[$key] as $slot => $child) {
                        $child_id = is_array($child) ? (string) ($child['id'] ?? '') : '';
                        if ($child_id !== '' && in_array($child_id, $orders[$id], true)) { $slots[] = $slot; $items[$child_id] = $child; }
                    }
                    $sorted = [];
                    foreach ($orders[$id] as $child_id) if (isset($items[$child_id])) $sorted[] = $items[$child_id];
                    if (count($sorted) !== count($slots) || count($slots) < 2) continue;
                    $moved = false;
                    foreach ($slots as $position => $slot) {
                        if (($node[$key][$slot]['id'] ?? '') !== ($sorted[$position]['id'] ?? '')) $moved = true;
                        $node[$key][$slot] = $sorted[$position];
                    }
                    if ($moved) $state['changed'] = true;
                }
            }
            $nodes[$index] = $node;
        }
        return $nodes;
    }

    // ---- Forms ---------------------------------------------------------------------------------------------------------------

    // The editable parts of a form field or a form button: caption, placeholder, required flag, button text. Only the keys present in
    // $values are applied; returns true when the node changed.
    private function sync_form_fields(&$node, $values) {
        $changed = false;
        foreach (['label', 'placeholder'] as $key) {
            if (array_key_exists($key, $values) && (string) ($node[$key] ?? '') !== (string) $values[$key]) { $node[$key] = (string) $values[$key]; $changed = true; }
        }
        if (array_key_exists('required', $values) && !empty($node['required']) !== (bool) $values['required']) {
            if ($values['required']) $node['required'] = true; else unset($node['required']);
            $changed = true;
        }
        if (array_key_exists('text', $values) && (string) ($node['text'] ?? ($node['content'] ?? '')) !== (string) $values['text']) {
            $node['text'] = (string) $values['text'];
            $node['content'] = (string) $values['text'];
            $changed = true;
        }
        return $changed;
    }

    // Applies fields read from markup (id => values) to a node and every node below it.
    private function sync_form_tree(&$node, $parsed) {
        $changed = false;
        $id = (string) ($node['id'] ?? '');
        if ($id !== '' && isset($parsed[$id]) && in_array($node['type'] ?? '', ['form-field', 'button'], true)) {
            $changed = $this->sync_form_fields($node, $parsed[$id]);
        }
        foreach (['children', 'elements'] as $key) {
            if (empty($node[$key]) || !is_array($node[$key])) continue;
            foreach ($node[$key] as &$child) {
                if (is_array($child) && $this->sync_form_tree($child, $parsed)) $changed = true;
            }
            unset($child);
        }
        return $changed;
    }

    // The node tree a component block carries, read onto the schema nodes of the same ids.
    private function sync_component_tree($block_node, &$state) {
        $changed = false;
        $id = (string) ($block_node['id'] ?? '');
        if ($id !== '' && isset($state['index'][$id])) {
            $state['seen'][$id] = true;
            if (in_array($block_node['type'] ?? '', ['form-field', 'button'], true)) {
                $values = [];
                foreach (['label', 'placeholder'] as $key) if (array_key_exists($key, $block_node)) $values[$key] = $block_node[$key];
                $values['required'] = !empty($block_node['required']);
                if (($block_node['type'] ?? '') === 'button') $values['text'] = (string) ($block_node['text'] ?? ($block_node['content'] ?? ''));
                if (($block_node['type'] ?? '') === 'button') unset($values['required'], $values['label'], $values['placeholder']);
                foreach ($state['index'][$id] as &$ref) {
                    if ($this->sync_form_fields($ref, $values)) $changed = true;
                }
                unset($ref);
            }
        }
        foreach (['children', 'elements'] as $key) {
            foreach ((array) ($block_node[$key] ?? []) as $child) {
                if (is_array($child) && $this->sync_component_tree($child, $state)) $changed = true;
            }
        }
        return $changed;
    }

    // ---- Reading a block ---------------------------------------------------------------------------------------------------

    private function sync_inner_html($html, $tag = '') {
        $html = (string) $html;
        if ($tag !== '' && preg_match('#<' . $tag . '\b[^>]*>(.*)</' . $tag . '>#is', $html, $match)) $html = $match[1];
        $html = preg_replace('#<br\s*/?>#i', ' ', $html);
        return trim(preg_replace('/\s+/', ' ', html_entity_decode(wp_strip_all_tags($html), ENT_QUOTES, 'UTF-8')));
    }

    private function sync_palette_color($slug) {
        static $palette = null;
        if ($palette === null) {
            $palette = [];
            $settings = function_exists('wp_get_global_settings') ? wp_get_global_settings(['color', 'palette']) : [];
            foreach ((array) $settings as $origin) {
                foreach ((array) $origin as $entry) {
                    if (isset($entry['slug'], $entry['color']) && !isset($palette[$entry['slug']])) $palette[$entry['slug']] = $entry['color'];
                }
            }
        }
        return isset($palette[$slug]) ? $this->native_color($palette[$slug]) : '';
    }

    private function sync_color($custom, $slug) {
        $hex = $this->native_color($custom ?? '');
        return $hex !== '' ? $hex : ($slug ? $this->sync_palette_color($slug) : '');
    }

    // linear-gradient(135deg,#a 0%,#b 100%), as gradient_css writes it, back into the schema form.
    private function sync_parse_gradient($css) {
        if (!is_string($css) || !preg_match('/^linear-gradient\(\s*(-?\d+)deg\s*,(.+)\)$/i', trim($css), $match)) return null;
        $stops = [];
        foreach (preg_split('/,(?![^(]*\))/', $match[2]) as $part) {
            if (!preg_match('/(#[0-9a-f]{6})\s+(\d+)%/i', $part, $stop)) return null;
            $stops[] = ['pos' => (int) $stop[2], 'color' => strtolower($stop[1])];
        }
        return count($stops) >= 2 ? ['type' => 'linear', 'angle' => ((int) $match[1] % 360 + 360) % 360, 'stops' => $stops] : null;
    }

    // Sets $style[$key] from the block's style attributes; returns true when something changed.
    private function sync_style(&$node, $attrs, $text) {
        $changed = false;
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $set = function ($key, $value) use (&$style, &$changed) {
            if ($value === null) {
                if (array_key_exists($key, $style)) { unset($style[$key]); $changed = true; }
            } elseif (($style[$key] ?? null) !== $value) {
                $style[$key] = $value;
                $changed = true;
            }
        };
        $css = is_array($attrs['style'] ?? null) ? $attrs['style'] : [];
        if ($text) {
            $color = $this->sync_color($css['color']['text'] ?? '', $attrs['textColor'] ?? '');
            if ($color !== '') $set('color', $color); elseif (!empty($style['color']) && $this->native_color($style['color']) !== '') $set('color', null);
        }
        $gradient = $this->sync_parse_gradient($css['color']['gradient'] ?? '');
        $fill = $this->sync_color($css['color']['background'] ?? '', $attrs['backgroundColor'] ?? '');
        if ($gradient) {
            $set('gradient', $gradient);
        } elseif (!empty($style['gradient']) && empty($css['color']['gradient']) && empty($attrs['gradient'])) {
            $set('gradient', null);
        }
        if ($fill !== '') $set('background', $fill);
        elseif (!$gradient && !empty($style['background']) && $this->native_color($style['background']) !== '' && empty($style['gradient']) && empty($style['backgroundImage'])) $set('background', null);
        $weight = absint($css['typography']['fontWeight'] ?? 0);
        if ($text && $weight) $set('fontWeight', $weight);
        if (empty($style['accentColor'])) {
            $border = is_array($css['border'] ?? null) ? $css['border'] : [];
            $radius = absint($border['radius'] ?? 0);
            if ($radius || !empty($style['borderRadius'])) $set('borderRadius', $radius ?: null);
            $border_color = $this->sync_color($border['color'] ?? '', $attrs['borderColor'] ?? '');
            $border_width = absint($border['width'] ?? 0);
            if ($border_color !== '' && $border_width) {
                $set('borderColor', $border_color);
                $set('borderWidth', $border_width);
            } elseif (!empty($style['borderColor']) && empty($border['color'])) {
                $set('borderColor', null);
                $set('borderWidth', null);
            }
        }
        $classes = ' ' . ($attrs['className'] ?? '') . ' ';
        if ($text) {
            if (strpos($classes, ' pg-serif ') !== false) $set('fontFamily', 'serif');
            elseif (strpos($classes, ' pg-mono ') !== false) $set('fontFamily', 'mono');
            elseif (in_array($style['fontFamily'] ?? '', ['serif', 'mono'], true)) $set('fontFamily', null);
        }
        if ($changed) $node['style'] = $style;
        return $changed;
    }

    private function sync_set_text(&$node, $text) {
        if ((string) ($node['text'] ?? ($node['content'] ?? '')) === $text) return false;
        $node['text'] = $text;
        $node['content'] = $text;
        return true;
    }

    private function sync_set_box(&$node, $absolute, $box) {
        if (!$absolute) return false;
        $changed = false;
        $old = is_array($node['bbox'] ?? null) ? $node['bbox'] : [];
        $new = [];
        foreach (['x', 'y', 'width', 'height'] as $key) {
            $value = $this->native_number($absolute[$key]);
            $new[$key] = $value;
            // The exporter rounds to 0.1, so a smaller difference is rounding, not an edit.
            if (!isset($old[$key]) || abs((float) $old[$key] - (float) $value) > .6) $changed = true;
        }
        if ($changed) {
            $node['bbox'] = $new;
            if (is_array($node['settings'] ?? null)) {
                $node['settings']['x'] = $new['x']; $node['settings']['y'] = $new['y'];
                $node['settings']['width'] = $new['width']; $node['settings']['height'] = $new['height'];
            }
        }
        if (isset($box['fs']) && is_numeric($box['fs']) && $box['fs'] > 0) {
            $old_size = $node['style']['fontSize'] ?? ($node['settings']['fontSize'] ?? null);
            if (!is_numeric($old_size) || abs((float) $old_size - (float) $box['fs']) > .6) {
                $node['style']['fontSize'] = $this->native_number($box['fs']);
                if (is_array($node['settings'] ?? null)) $node['settings']['fontSize'] = $node['style']['fontSize'];
                $changed = true;
            }
        }
        return $changed;
    }

    private function sync_update_node(&$node, $block, $absolute, $box) {
        $name = $block['blockName'];
        $attrs = is_array($block['attrs'] ?? null) ? $block['attrs'] : [];
        $changed = $this->sync_set_box($node, $absolute, $box);
        switch ($name) {
            case 'core/paragraph':
            case 'core/heading':
                $html = (string) ($block['innerHTML'] ?? '');
                $changed = $this->sync_set_text($node, $this->sync_inner_html($html, $name === 'core/heading' ? 'h[1-6]' : 'p')) || $changed;
                if (($node['type'] ?? '') === 'link' && preg_match('/<a\b[^>]*\bhref="([^"]*)"/i', $html, $link) && ($node['behavior']['url'] ?? '') !== $link[1]) {
                    $node['behavior']['url'] = esc_url_raw(html_entity_decode($link[1]));
                    $changed = true;
                }
                return $this->sync_style($node, $attrs, true) || $changed;
            case 'core/buttons':
                foreach ((array) ($block['innerBlocks'] ?? []) as $button) {
                    if (($button['blockName'] ?? '') !== 'core/button') continue;
                    $html = (string) ($button['innerHTML'] ?? '');
                    $changed = $this->sync_set_text($node, $this->sync_inner_html($html, 'a')) || $changed;
                    if (preg_match('/<a\b[^>]*\bhref="([^"]*)"/i', $html, $link) && ($node['behavior']['url'] ?? '#') !== $link[1]) {
                        $node['behavior']['url'] = esc_url_raw(html_entity_decode($link[1]));
                        $changed = true;
                    }
                    $changed = $this->sync_style($node, is_array($button['attrs'] ?? null) ? $button['attrs'] : [], true) || $changed;
                    break;
                }
                return $changed;
            case 'core/image':
                $html = (string) ($block['innerHTML'] ?? '');
                if (preg_match('/<img\b[^>]*\bsrc="([^"]*)"/i', $html, $src) && ($node['url'] ?? ($node['asset']['url'] ?? '')) !== $src[1]) {
                    $node['url'] = esc_url_raw(html_entity_decode($src[1]));
                    $changed = true;
                }
                if (isset($attrs['id']) && absint($attrs['id']) !== absint($node['attachmentId'] ?? 0)) {
                    $node['attachmentId'] = absint($attrs['id']);
                    $changed = true;
                }
                if (preg_match('/<img\b[^>]*\balt="([^"]*)"/i', $html, $alt) && ($node['alt'] ?? '') !== html_entity_decode($alt[1])) {
                    $node['alt'] = html_entity_decode($alt[1]);
                    $changed = true;
                }
                return $this->sync_style($node, $attrs, false) || $changed;
            case 'core/table':
                $rows = $this->sync_table_rows((string) ($block['innerHTML'] ?? ''), is_array($node['rows'] ?? null) ? $node['rows'] : []);
                if ($rows !== null) { $node['rows'] = $rows; $changed = true; }
                return $changed;
            case 'core/group':
                return $this->sync_style($node, $attrs, false) || $changed;
        }
        return $changed;
    }

    // Cell texts from the table markup, laid over the existing rows (other cell fields are kept). Null when nothing differs.
    private function sync_table_rows($html, $existing) {
        if (!preg_match_all('#<tr\b[^>]*>(.*?)</tr>#is', $html, $row_matches)) return null;
        $rows = [];
        foreach ($row_matches[1] as $row_index => $row_html) {
            preg_match_all('#<t[hd]\b[^>]*>(.*?)</t[hd]>#is', $row_html, $cells);
            $row = [];
            foreach ($cells[1] as $cell_index => $cell_html) {
                $text = $this->sync_inner_html($cell_html);
                $cell = is_array($existing[$row_index][$cell_index] ?? null) ? $existing[$row_index][$cell_index] : [];
                $cell['text'] = $text;
                if (array_key_exists('content', $cell)) $cell['content'] = $text;
                $row[] = $cell;
            }
            $rows[] = $row;
        }
        return $rows === $existing ? null : $rows;
    }

    // ---- A block the schema does not know yet ------------------------------------------------------------------------------

    private function sync_new_node($block, $absolute, $box) {
        $name = $block['blockName'];
        $types = ['core/paragraph' => 'text', 'core/heading' => 'heading', 'core/buttons' => 'button', 'core/image' => 'image', 'core/table' => 'table', 'core/group' => 'container'];
        if (!isset($types[$name])) return null;
        $id = 'pg' . substr(md5(uniqid('', true)), 0, 10);
        $node = ['id' => $id, 'type' => $types[$name], 'role' => $types[$name], 'children' => [], 'elements' => [], 'style' => [], 'behavior' => ['type' => 'none'],
            'confidence' => 1, 'source' => ['detectedBy' => ['block-editor'], 'manual' => true]];
        if ($name === 'core/group' && empty($block['innerBlocks'])) return null;
        $this->sync_update_node($node, $block, $absolute, $box);
        if (!$node['style']) unset($node['style']);
        if ($name === 'core/paragraph' || $name === 'core/heading' || $name === 'core/buttons') {
            if (trim((string) ($node['text'] ?? '')) === '') return null;
        }
        return $node;
    }
}
