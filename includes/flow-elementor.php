<?php
/**
 * Flow layout for the Elementor export. It uses the same row/column analysis as the block export (see flow-layout.php) but
 * writes native flex containers instead of coordinates, so Elementor's own responsive controls (_tablet / _mobile values) do
 * the adapting: rows wrap and stack, padding and type shrink, tables scroll sideways. Parts that cannot be expressed as rows
 * and columns stay as scaled pixel-match "islands".
 */
if (!defined('ABSPATH')) {
    exit;
}

trait Page_Generator_Flow_Elementor {
    private function el_dims($top, $right = null, $bottom = null, $left = null) {
        $right = $right ?? $top; $bottom = $bottom ?? $top; $left = $left ?? $top;
        return ['unit' => 'px', 'top' => (string) $this->flow_num($top), 'right' => (string) $this->flow_num($right), 'bottom' => (string) $this->flow_num($bottom), 'left' => (string) $this->flow_num($left), 'isLinked' => false];
    }

    private function el_size($unit, $size) {
        return ['unit' => $unit, 'size' => $this->flow_num($size), 'sizes' => []];
    }

    // Phone-sized type: small text rises to a readable floor, large type shrinks more slowly than the screen.
    private function el_mobile_font($font) {
        return (int) round(14 + max(0, $font - 14) * .6);
    }

    private function serialize_elementor_flow_schema($schema) {
        $models = [];
        foreach ($this->group_sections($schema) as $group) {
            $elements = [];
            foreach ($group['sections'] as $section) {
                $elements[] = $this->elementor_flow_node($section, ['fill' => 1], true);
            }
            $elements = array_values(array_filter($elements));
            $models[] = [
                'id' => substr(md5(wp_json_encode($elements)), 0, 7),
                'elType' => 'container',
                'isInner' => false,
                'settings' => [
                    'css_classes' => 'pg-el-flow' . $this->breakpoint_classes($group),
                    'flex_direction' => 'column',
                    'content_width' => 'full',
                    'padding' => $this->el_dims(0),
                    'flex_gap' => $this->elementor_gap(0),
                ],
                'elements' => $elements,
            ];
        }
        return $models;
    }

    // $slot: bp/gs/fill (place in a row), mt/ml (spacing) as computed by flow_item_slot and the row code.
    private function elementor_flow_node($node, $slot, $root = false) {
        if (!is_array($node)) return null;
        $type = sanitize_key($node['type'] ?? 'container');
        $box = $this->flow_box($node);
        $plain = $this->flow_without_box($node);
        $children = $this->flow_children($node);
        $leaf = ['heading', 'text', 'link', 'logo', 'badge', 'button', 'image', 'icon'];
        if (in_array($type, $leaf, true) || (!$children && !in_array($type, ['form', 'form-field', 'table'], true))) {
            $model = $this->serialize_elementor_node($plain, false, null);
            return $this->elementor_flow_slot($model, $slot, $box, $node);
        }
        if ($type === 'form') {
            if ($this->wpforms_node_active($node)) {
                $model = ['id' => $this->flow_id($node), 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => ['editor' => $this->wpforms_embed_html($node), '_margin' => $this->el_dims(0), '_padding' => $this->el_dims(0)], 'elements' => []];
            } else {
                $key = !empty($plain['children']) ? 'children' : 'elements';
                $fields = (array) ($plain[$key] ?? []);
                $placeholders = array_map(function ($f) { return trim((string) ($f['placeholder'] ?? '')); }, $fields);
                $plain[$key] = array_values(array_filter($fields, function ($f) use ($placeholders) {
                    return ($f['type'] ?? '') !== 'form-field' || trim((string) ($f['placeholder'] ?? '')) !== '' || !in_array(trim((string) ($f['label'] ?? '')), $placeholders, true);
                }));
                usort($plain[$key], function ($a, $b) { return (($a['type'] ?? '') === 'button') <=> (($b['type'] ?? '') === 'button'); });
                $model = ['id' => $this->flow_id($node), 'elType' => 'widget', 'widgetType' => 'html', 'settings' => ['html' => $this->render_node($plain)], 'elements' => []];
            }
            return $this->elementor_flow_slot($model, $slot + ['fill' => 1], $box, $node);
        }
        if ($type === 'form-field' || $type === 'table') {
            return $box ? $this->elementor_flow_island($node, $box, $slot) : null;
        }
        $rows = $box ? $this->flow_rows($children) : null;
        if ($rows === null) {
            return $box ? $this->elementor_flow_island($node, $box, $slot) : null;
        }
        $rows = $this->flow_merge_lines($rows);
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $inner = $this->elementor_flow_rows($rows, $box);
        $settings = $this->elementor_plate_settings($style, $node, 'column') + ['flex_gap' => $this->elementor_gap(0)];
        $pad = $inner['pad'];
        $settings['padding'] = $this->el_dims($pad[0], $pad[1], $pad[2], $pad[3]);
        $settings['padding_tablet'] = $this->el_dims(min($pad[0], 24), min($pad[1], 32), min($pad[2], 24), min($pad[3], 32));
        $settings['padding_mobile'] = $this->el_dims(min($pad[0], 12), min($pad[1], 14), min($pad[2], 12), min($pad[3], 14));
        if ($root) {
            // A section's background runs edge to edge; its content is capped at the width of the source page.
            $settings['content_width'] = 'boxed';
            $settings['boxed_width'] = $this->el_size('px', $box['w']);
        }
        if (!empty($inner['table'])) {
            // The table keeps its width on a phone and scrolls inside its own container.
            $settings['overflow'] = 'auto';
        }
        if ($box['h'] > 0 && !$root) $settings['min_height'] = $this->el_size('px', $box['h']);
        $model = ['id' => $this->flow_id($node), 'elType' => 'container', 'isInner' => !$root, 'settings' => $settings, 'elements' => $inner['elements']];
        return $this->elementor_flow_slot($model, $slot, $box, $node);
    }

    private function flow_id($node) {
        return sanitize_key($node['id'] ?? '') ?: substr(md5(wp_json_encode($node)), 0, 7);
    }

    // Applies the node's place in its row/column to an Elementor model: width share, spacing, alignment, phone overrides.
    private function elementor_flow_slot($model, $slot, $box, $node) {
        if (!$model) return null;
        $container = $model['elType'] === 'container';
        $p = $container ? '' : '_';
        // Spacing edited in an editor replaces the measured one (see includes/flow-spacing.php).
        $override = is_array($node['style']['flow'] ?? null) ? $node['style']['flow'] : [];
        if (array_key_exists('mt', $override) && is_numeric($override['mt'])) $slot['mt'] = $override['mt'];
        if (array_key_exists('ml', $override)) $slot['ml'] = $override['ml'];
        if (isset($slot['mt']) || isset($slot['ml']) && is_numeric($slot['ml'])) {
            $margin_top = (float) ($slot['mt'] ?? 0);
            $margin_left = isset($slot['ml']) && is_numeric($slot['ml']) ? (float) $slot['ml'] : 0;
            $model['settings'][$container ? 'margin' : '_margin'] = $this->el_dims($margin_top, 0, 0, $margin_left);
            $model['settings'][($container ? 'margin' : '_margin') . '_mobile'] = $this->el_dims(round($margin_top * .6), 0, 0, min($margin_left, 12));
        }
        if (($slot['ml'] ?? '') === 'c') $model['settings'][$p . 'flex_align_self'] = 'center';
        if (($slot['ml'] ?? '') === 'r') $model['settings'][$p . 'flex_align_self'] = 'flex-end';
        if (isset($slot['bp'])) {
            // One of several cells in a row: its share of the row; cells wrap, and on a phone small ones go two to a row.
            $share = max(5, min(100, (float) $slot['bp'] - (float) ($slot['gs'] ?? 0) / max(1, (float) ($slot['cw'] ?? 1200)) * 100));
            $mobile = $share <= 26 ? 47 : 100;
            $tablet = $share <= 36 ? 47 : (float) $share;
            if ($container) {
                $model['settings']['width'] = $this->el_size('%', $share);
                $model['settings']['width_tablet'] = $this->el_size('%', $tablet);
                $model['settings']['width_mobile'] = $this->el_size('%', $mobile);
            } else {
                $model['settings']['_element_width'] = 'initial';
                $model['settings']['_element_custom_width'] = $this->el_size('%', $share);
                $model['settings']['_element_custom_width_tablet'] = $this->el_size('%', $tablet);
                $model['settings']['_element_custom_width_mobile'] = $this->el_size('%', $mobile);
            }
        } elseif (!empty($slot['fill'])) {
            if ($container) {
                $model['settings']['width'] = $this->el_size('%', 100);
            } else {
                $model['settings']['_element_width'] = 'initial';
                $model['settings']['_element_custom_width'] = $this->el_size('%', 100);
            }
        } elseif ($container && $box) {
            // A plate (badge, tag, empty box) keeps its own size.
            $model['settings']['width'] = $this->el_size('px', $box['w']);
            $model['settings']['min_height'] = $this->el_size('px', $box['h']);
        }
        if (!$container && ($model['widgetType'] ?? '') === 'image' && $box) {
            $model['settings']['width'] = $this->el_size('%', 100);
            $model['settings']['object-fit'] = 'cover';
            // Icons and small pictures keep their own size; larger ones take their share of the row.
            if ($box['w'] <= 160 || (!isset($slot['bp']) && empty($slot['fill']))) {
                $model['settings']['_element_width'] = 'initial';
                $model['settings']['_element_custom_width'] = $this->el_size('px', $box['w']);
                $model['settings']['_element_custom_width_tablet'] = $this->el_size('px', $box['w']);
                $model['settings']['_element_custom_width_mobile'] = $box['w'] <= 160 ? $this->el_size('px', $box['w']) : $this->el_size('%', 100);
            }
        }
        if (!$container && isset($model['settings']['_css_classes']) && (!empty($node['pgMerged']) || ($box && $box['w'] > 320))) {
            // Paragraphs and long lines wrap; only short labels are held on one line.
            $model['settings']['_css_classes'] = trim(str_replace('pg-nowrap', '', $model['settings']['_css_classes']));
        }
        if (!$container) {
            if (!empty($model['settings']['typography_font_size']['size'])) {
                $model['settings']['typography_font_size_mobile'] = $this->el_size('px', $this->el_mobile_font((float) $model['settings']['typography_font_size']['size']));
            }
            if (($model['widgetType'] ?? '') === 'button') $model['settings']['align'] = 'left';
        }
        $model['elements'] = $this->elementor_flow_mobile_fonts($model['elements'] ?? []);
        return $this->fsp_apply_to_model($model, $node);
    }

    // Phone sizes for widgets nested inside a plate that was built by the shared serializer.
    private function elementor_flow_mobile_fonts($elements) {
        foreach ($elements as &$element) {
            if (($element['elType'] ?? '') === 'widget' && !empty($element['settings']['typography_font_size']['size']) && empty($element['settings']['typography_font_size_mobile'])) {
                $element['settings']['typography_font_size_mobile'] = $this->el_size('px', $this->el_mobile_font((float) $element['settings']['typography_font_size']['size']));
            }
        }
        return $elements;
    }

    // Rows of a container as Elementor elements, plus the container's padding measured from its children.
    private function elementor_flow_rows($rows, $box) {
        $left = INF; $right = -INF;
        foreach ($rows as $row) {
            $left = min($left, $row['items'][0]['box']['x']);
            foreach ($row['items'] as $item) $right = max($right, $item['box']['x'] + $item['box']['w']);
        }
        $pad_l = max(0, $left - $box['x']);
        $pad_r = max(0, ($box['x'] + $box['w']) - $right);
        $edge_r = $box['x'] + $box['w'] - $pad_r;
        // Empty space to the right of left-aligned content is not padding: the content may use it (and wraps when it is narrow).
        $pad_r = min($pad_r, max($pad_l, 24));
        $pad_t = max(0, $rows[0]['top'] - $box['y']);
        $pad_b = max(0, ($box['y'] + $box['h']) - end($rows)['bottom']);
        $content_w = max(1, $box['w'] - $pad_l - $pad_r);
        $table = $this->flow_table_columns($rows, $box);
        $elements = [];
        $previous_bottom = $rows[0]['top'];
        foreach ($rows as $index => $row) {
            $gap_above = $index === 0 ? 0 : max(0, $row['top'] - $previous_bottom);
            $previous_bottom = $row['bottom'];
            if ($table !== null && count($row['items']) >= 2) {
                $elements[] = $this->elementor_flow_table_row($row, $table, $edge_r, $gap_above);
                continue;
            }
            $m = $this->flow_row_metrics($row, $box, $pad_l, $edge_r, $content_w);
            $cells = [];
            foreach ($row['items'] as $item) {
                $slot = $this->flow_item_slot($item, $m, $content_w);
                $slot['cw'] = $content_w;
                $cells[] = ['item' => $item, 'slot' => $slot];
            }
            if ($m['count'] === 1) {
                $slot = $cells[0]['slot'];
                if ($gap_above > 0) $slot['mt'] = $gap_above;
                if (!isset($slot['fill'])) {
                    if ($m['left_gap'] > 4 && $m['right_gap'] > 4 && abs($m['left_gap'] - $m['right_gap']) <= 6) $slot['ml'] = 'c';
                    elseif ($m['right_gap'] < 4 && $m['left_gap'] > 12) $slot['ml'] = 'r';
                    elseif ($m['left_gap'] > 4) $slot['ml'] = $m['left_gap'];
                }
                $element = $this->elementor_flow_cell($cells[0]['item'], $slot);
                if ($element) $elements[] = $element;
                continue;
            }
            $children = array_values(array_filter(array_map(function ($c) { return $this->elementor_flow_cell($c['item'], $c['slot']); }, $cells)));
            $gap = $m['jb'] ? 16 : $m['gap'];
            $settings = [
                'flex_direction' => 'row',
                'flex_wrap' => 'wrap',
                'content_width' => 'full',
                'padding' => $this->el_dims(0),
                'flex_gap' => ['unit' => 'px', 'column' => (string) $this->flow_num($gap), 'row' => '8', 'isLinked' => false],
                'flex_gap_mobile' => ['unit' => 'px', 'column' => (string) $this->flow_num(min($gap, 12)), 'row' => '8', 'isLinked' => false],
                'flex_align_items' => $m['centered'] ? 'center' : 'flex-start',
                'width' => $this->el_size('%', 100),
            ];
            if ($m['jb']) $settings['flex_justify_content'] = 'space-between';
            if ($gap_above > 0 || $m['left_gap'] > 4) {
                $settings['margin'] = $this->el_dims($gap_above, 0, 0, $m['left_gap'] > 4 ? $m['left_gap'] : 0);
                $settings['margin_mobile'] = $this->el_dims(round($gap_above * .6), 0, 0, min(max(0, $m['left_gap']), 12));
            }
            $elements[] = ['id' => substr(md5(wp_json_encode($children)), 0, 7), 'elType' => 'container', 'isInner' => true, 'settings' => $settings, 'elements' => $children];
        }
        return ['elements' => $elements, 'pad' => [$pad_t, $pad_r, $pad_b, $pad_l], 'table' => $table !== null];
    }

    // One cell of a row: a node, or a nested stack of rows (one column of a multi-column row).
    private function elementor_flow_cell($item, $slot) {
        if (isset($item['node'])) {
            return $this->elementor_flow_node($item['node'], $slot);
        }
        $inner = $this->elementor_flow_rows($item['rows'], $item['box']);
        $model = [
            'id' => substr(md5(wp_json_encode($inner['elements'])), 0, 7),
            'elType' => 'container',
            'isInner' => true,
            'settings' => ['flex_direction' => 'column', 'content_width' => 'full', 'padding' => $this->el_dims(0), 'flex_gap' => $this->elementor_gap(0)],
            'elements' => $inner['elements'],
        ];
        return $this->elementor_flow_slot($model, $slot, null, ['type' => 'stack']);
    }

    // A table row: cells in fixed-share columns that every row repeats, so the columns line up; on a phone the row keeps
    // 60% of its source width and the table container scrolls.
    private function elementor_flow_table_row($row, $lefts, $right_edge, $gap_above) {
        $cells = array_fill(0, count($lefts), null);
        foreach ($row['items'] as $item) {
            $best = 0;
            foreach ($lefts as $i => $left) {
                if (abs($left - $item['box']['x']) < abs($lefts[$best] - $item['box']['x'])) $best = $i;
            }
            if ($cells[$best] === null) $cells[$best] = $item;
        }
        $spans = [];
        foreach ($lefts as $i => $left) $spans[] = max(1, ($lefts[$i + 1] ?? $right_edge) - $left);
        $total = array_sum($spans);
        $children = [];
        foreach ($cells as $i => $cell) {
            $share = $spans[$i] / $total * 100;
            $model = $cell === null ? ['id' => substr(md5('empty' . $i . $total), 0, 7), 'elType' => 'container', 'isInner' => true, 'settings' => ['content_width' => 'full', 'padding' => $this->el_dims(0)], 'elements' => []] : $this->elementor_flow_cell($cell, []);
            if (!$model) continue;
            $key = $model['elType'] === 'container' ? '' : '_';
            if ($model['elType'] === 'container') {
                $model['settings']['width'] = $this->el_size('%', $share);
            } else {
                $model['settings']['_element_width'] = 'initial';
                $model['settings']['_element_custom_width'] = $this->el_size('%', $share);
            }
            $children[] = $model;
        }
        $settings = [
            'flex_direction' => 'row',
            'flex_wrap' => 'nowrap',
            'content_width' => 'full',
            'padding' => $this->el_dims(0),
            'flex_gap' => $this->elementor_gap(0),
            'flex_align_items' => 'center',
            'css_classes' => 'pg-el-trow',
            'width' => $this->el_size('%', 100),
            'width_mobile' => $this->el_size('px', max(480, $total * .6)),
        ];
        if ($gap_above > 0) {
            $settings['margin'] = $this->el_dims($gap_above, 0, 0, 0);
            $settings['margin_mobile'] = $this->el_dims(round($gap_above * .6), 0, 0, 0);
        }
        return ['id' => substr(md5(wp_json_encode($children)), 0, 7), 'elType' => 'container', 'isInner' => true, 'settings' => $settings, 'elements' => $children];
    }

    // A part that cannot be written as rows and columns keeps its coordinates and is zoomed to fit (see canvas-scale.js).
    private function elementor_flow_island($node, $box, $slot) {
        $children = $this->flow_children($node);
        $elements = [];
        foreach ($children ?: [$node] as $child) {
            $model = $this->serialize_elementor_node($child, false, ['x' => $box['x'], 'y' => $box['y'], 'width' => $box['w'], 'height' => $box['h']]);
            if ($model) $elements[] = $model;
        }
        $model = [
            'id' => substr(md5(wp_json_encode($elements)), 0, 7),
            'elType' => 'container',
            'isInner' => true,
            'settings' => [
                'css_classes' => 'page-generator-canvas pg-el-canvas pg-w-' . (int) round($box['w']),
                'flex_direction' => 'column',
                'content_width' => 'full',
                'padding' => $this->el_dims(0),
                'flex_gap' => $this->elementor_gap(0),
                'width' => $this->el_size('px', $box['w']),
                'min_height' => $this->el_size('px', $box['h']),
            ],
            'elements' => $elements,
        ];
        return $model;
    }
}
