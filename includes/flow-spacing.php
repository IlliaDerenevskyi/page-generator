<?php
defined('ABSPATH') || exit;

/**
 * Spacing of a flow page that can be edited in the editors.
 *
 * In flow mode the space around a node is measured from the screenshot's gaps at export time: top margin (mt), left offset (ml: a number, or
 * 'c' / 'r' for centred / right), gap between its children (g) and its padding (p: top, right, bottom, left). Nothing in the schema holds
 * these numbers, so an edit made in an editor would be lost on the next rebuild. Here they become overrides in `style.flow` of the node:
 *
 *  - on export an override replaces the measured value (Gutenberg: the block's pgFlow; Elementor: margin, gap and padding of the element);
 *  - on export the spacing that was written is remembered per node id (the "state");
 *  - when the editor saves, the spacing found in the blocks / elements is compared with the remembered state; a value that differs is an
 *    edit and goes into `style.flow` of that node. The new spacing is remembered again.
 */
trait Page_Generator_Flow_Spacing {
    // The spacing keys a node can override, as they are named in pgFlow.
    private function fsp_keys() {
        return ['mt', 'ml', 'g', 'p'];
    }

    // id => style.flow for every node of the schema (desktop and mobile layouts) that carries an override.
    private function fsp_overrides($schema) {
        $found = [];
        $walk = function ($nodes) use (&$walk, &$found) {
            foreach ((array) $nodes as $node) {
                if (!is_array($node)) continue;
                $flow = $node['style']['flow'] ?? null;
                if (!empty($node['id']) && is_string($node['id']) && is_array($flow) && $flow) {
                    $clean = [];
                    foreach ($this->fsp_keys() as $key) if (array_key_exists($key, $flow)) $clean[$key] = $flow[$key];
                    if ($clean) $found[$node['id']] = $clean;
                }
                $walk($node['children'] ?? []);
                if (empty($node['children'])) $walk($node['elements'] ?? []);
            }
        };
        $walk($schema['sections'] ?? []);
        $walk($schema['variants']['mobile']['sections'] ?? []);
        return $found;
    }

    private function fsp_same($a, $b) {
        if (is_array($a) || is_array($b)) {
            if (!is_array($a) || !is_array($b) || count($a) !== count($b)) return false;
            foreach ($a as $i => $value) if (!array_key_exists($i, $b) || !$this->fsp_same($value, $b[$i])) return false;
            return true;
        }
        if (is_numeric($a) && is_numeric($b)) return abs((float) $a - (float) $b) <= .6;
        return (string) $a === (string) $b;
    }

    // ---- Gutenberg ---------------------------------------------------------------------------------------------------------------

    // The overrides written into the pgFlow of the blocks that carry the node's id.
    private function fsp_apply_to_content($content, $overrides) {
        if (!$overrides) return $content;
        return preg_replace_callback('/<!-- wp:([a-z\/-]+) (\{.*?\}) -->/s', function ($match) use ($overrides) {
            $attrs = json_decode($match[2], true);
            if (!is_array($attrs) || !is_array($attrs['pgFlow'] ?? null) || !is_string($attrs['pgId'] ?? null) || !isset($overrides[$attrs['pgId']])) return $match[0];
            foreach ($overrides[$attrs['pgId']] as $key => $value) $attrs['pgFlow'][$key] = $value;
            return '<!-- wp:' . $match[1] . ' ' . serialize_block_attributes($attrs) . ' -->';
        }, $content);
    }

    // id => spacing of every block that carries a node id and a pgFlow.
    private function fsp_state_from_blocks($blocks) {
        $state = [];
        $walk = function ($list) use (&$walk, &$state) {
            foreach ((array) $list as $block) {
                $id = $block['attrs']['pgId'] ?? '';
                $flow = $block['attrs']['pgFlow'] ?? null;
                if (is_string($id) && $id !== '' && is_array($flow)) {
                    $spacing = [];
                    foreach ($this->fsp_keys() as $key) if (array_key_exists($key, $flow)) $spacing[$key] = $flow[$key];
                    // A block without any spacing is remembered too (as empty), so that adding one later is seen as an edit.
                    $state[$id] = $spacing;
                }
                if (!empty($block['innerBlocks'])) $walk($block['innerBlocks']);
            }
        };
        $walk($blocks);
        return $state;
    }

    // Writes the spacing that differs from the remembered state into style.flow of the nodes (through the references of the node index).
    private function fsp_record_edits($current, $previous, &$index) {
        $changed = false;
        if (!is_array($previous)) return false;
        foreach ($current as $id => $spacing) {
            if (!isset($previous[$id]) || empty($index[$id])) continue;
            foreach ($spacing as $key => $value) {
                if (array_key_exists($key, $previous[$id]) && $this->fsp_same($previous[$id][$key], $value)) continue;
                foreach ($index[$id] as &$ref) {
                    if (!is_array($ref['style'] ?? null)) $ref['style'] = [];
                    if (!is_array($ref['style']['flow'] ?? null)) $ref['style']['flow'] = [];
                    if (!array_key_exists($key, $ref['style']['flow']) || !$this->fsp_same($ref['style']['flow'][$key], $value)) {
                        $ref['style']['flow'][$key] = $value;
                        $changed = true;
                    }
                }
                unset($ref);
            }
        }
        return $changed;
    }

    private function fsp_load_state($post_id, $meta) {
        $raw = get_post_meta($post_id, $meta, true);
        $state = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        return is_array($state) ? $state : null;
    }

    private function fsp_save_state($post_id, $meta, $state) {
        if ($state) update_post_meta($post_id, $meta, wp_slash(wp_json_encode($state)));
        else delete_post_meta($post_id, $meta);
    }

    // ---- Elementor ---------------------------------------------------------------------------------------------------------------

    // The spacing of one element as the exporter writes it: margin (top, left), gap between children, padding.
    private function fsp_elementor_spacing($element) {
        $settings = is_array($element['settings'] ?? null) ? $element['settings'] : [];
        $container = ($element['elType'] ?? '') === 'container';
        $out = [];
        $margin = $settings[$container ? 'margin' : '_margin'] ?? null;
        if (is_array($margin) && isset($margin['top']) && is_numeric($margin['top'])) $out['mt'] = (float) $margin['top'];
        $align = $settings[$container ? 'flex_align_self' : '_flex_align_self'] ?? '';
        if ($align === 'center') $out['ml'] = 'c';
        elseif ($align === 'flex-end') $out['ml'] = 'r';
        elseif (is_array($margin) && isset($margin['left']) && is_numeric($margin['left'])) $out['ml'] = (float) $margin['left'];
        if ($container && is_array($settings['flex_gap'] ?? null) && isset($settings['flex_gap']['column']) && is_numeric($settings['flex_gap']['column'])) $out['g'] = (float) $settings['flex_gap']['column'];
        $padding = $settings['padding'] ?? null;
        if ($container && is_array($padding) && isset($padding['top'], $padding['right'], $padding['bottom'], $padding['left'])) {
            $out['p'] = [(float) $padding['top'], (float) $padding['right'], (float) $padding['bottom'], (float) $padding['left']];
        }
        return $out;
    }

    // element id => spacing for a whole tree.
    private function fsp_state_from_elementor($elements) {
        $state = [];
        $walk = function ($list) use (&$walk, &$state) {
            foreach ((array) $list as $element) {
                if (!is_array($element) || empty($element['id'])) continue;
                $state[(string) $element['id']] = $this->fsp_elementor_spacing($element);
                if (!empty($element['elements'])) $walk($element['elements']);
            }
        };
        $walk($elements);
        return $state;
    }

    // The overrides of a node written into the model of its Elementor element (the margin comes through the slot, see elementor_flow_slot).
    private function fsp_apply_to_model($model, $node) {
        $flow = is_array($node['style']['flow'] ?? null) ? $node['style']['flow'] : [];
        if (!$flow || ($model['elType'] ?? '') !== 'container') return $model;
        if (isset($flow['g']) && is_numeric($flow['g'])) {
            $row = is_array($model['settings']['flex_gap'] ?? null) && isset($model['settings']['flex_gap']['row']) ? $model['settings']['flex_gap']['row'] : '8';
            $model['settings']['flex_gap'] = ['unit' => 'px', 'column' => (string) $this->flow_num($flow['g']), 'row' => (string) $row, 'isLinked' => false];
        }
        if (is_array($flow['p'] ?? null) && count($flow['p']) === 4) {
            $model['settings']['padding'] = $this->el_dims((float) $flow['p'][0], (float) $flow['p'][1], (float) $flow['p'][2], (float) $flow['p'][3]);
        }
        return $model;
    }
}
