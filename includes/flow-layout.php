<?php
/**
 * Flow layout mode: the same schema (which always keeps the screenshot's coordinates) is exported as a responsive page instead of
 * an absolutely positioned canvas. Children are grouped into rows by their boxes, spacing and widths are measured from the gaps
 * between them, and the blocks wrap and stack when the screen is narrow. Parts that cannot be expressed as rows and columns
 * (overlapping elements, forms, tables) stay as small scaled "islands" in the pixel-match style.
 */
if (!defined('ABSPATH')) {
    exit;
}

trait Page_Generator_Flow_Layout {
    private $flow_enabled = false;

    private function flow_wanted($mode) {
        return $mode === 'flow' || ($mode !== 'pixel' && ($this->settings()['layout_mode'] ?? 'pixel') === 'flow');
    }

    private function flow_box($node) {
        $b = is_array($node['bbox'] ?? null) ? $node['bbox'] : null;
        if (!$b || !isset($b['x'], $b['y'], $b['width'], $b['height'])) return null;
        return ['x' => (float) $b['x'], 'y' => (float) $b['y'], 'w' => max(1, (float) $b['width']), 'h' => max(1, (float) $b['height'])];
    }

    private function flow_children($node) {
        return !empty($node['children']) && is_array($node['children']) ? $node['children'] : (array) ($node['elements'] ?? []);
    }

    private function flow_overlap($a, $b) {
        $w = min($a['x'] + $a['w'], $b['x'] + $b['w']) - max($a['x'], $b['x']);
        $h = min($a['y'] + $a['h'], $b['y'] + $b['h']) - max($a['y'], $b['y']);
        if ($w <= 0 || $h <= 0) return 0.0;
        return ($w * $h) / max(1, min($a['w'] * $a['h'], $b['w'] * $b['h']));
    }

    // Rows of a container's children, or null when the children do not form clean rows (they overlap or lack boxes).
    private function flow_rows($children) {
        $items = [];
        foreach ($children as $child) {
            if (!is_array($child)) continue;
            $box = $this->flow_box($child);
            if (!$box) return null;
            $items[] = ['node' => $child, 'box' => $box];
        }
        if (!$items) return [];
        // OCR leaves a stray one- or two-letter "word" over a neighbour (a logo or icon read as text); it is not content and would only
        // force the whole container into an island.
        $items = array_values(array_filter($items, function ($item) use ($items) {
            $text = trim((string) ($item['node']['text'] ?? ($item['node']['content'] ?? '')));
            if (!$this->flow_is_text($item['node']) || mb_strlen($text) > 3) return true;
            foreach ($items as $other) {
                if ($other !== $item && $this->flow_overlap($item['box'], $other['box']) > .5) return false;
            }
            return true;
        }));
        // A sibling that lies inside a container sibling (a photo drawn over a card) belongs to that container.
        $leaf_types = ['text', 'heading', 'image', 'button', 'badge', 'link', 'icon', 'logo', 'form-field', 'table'];
        $moved = [];
        foreach ($items as $i => $inner) {
            foreach ($items as $j => $outer) {
                if ($i === $j || isset($moved[$j]) || in_array($outer['node']['type'] ?? '', $leaf_types, true)) continue;
                $inner_area = $inner['box']['w'] * $inner['box']['h'];
                $outer_area = $outer['box']['w'] * $outer['box']['h'];
                if ($outer_area > $inner_area && $this->flow_overlap($inner['box'], $outer['box']) > .85) {
                    $key = !empty($items[$j]['node']['children']) ? 'children' : 'elements';
                    $items[$j]['node'][$key] = array_merge((array) ($items[$j]['node'][$key] ?? []), [$inner['node']]);
                    $moved[$i] = true;
                    break;
                }
            }
        }
        if ($moved) {
            $items = array_values(array_filter($items, function ($key) use ($moved) { return !isset($moved[$key]); }, ARRAY_FILTER_USE_KEY));
        }
        // A picture lying (mostly) inside another picture is a second crop of the same region, not a second image.
        $items = array_values(array_filter($items, function ($item) use ($items) {
            if (($item['node']['type'] ?? '') !== 'image') return true;
            foreach ($items as $other) {
                if ($other !== $item && ($other['node']['type'] ?? '') === 'image' && $this->flow_overlap($item['box'], $other['box']) > .7
                    && $item['box']['w'] * $item['box']['h'] <= $other['box']['w'] * $other['box']['h']) return false;
            }
            return true;
        }));
        return $this->flow_xy_cut($items);
    }

    private function flow_union($items) {
        $x1 = INF; $y1 = INF; $x2 = -INF; $y2 = -INF;
        foreach ($items as $item) {
            $x1 = min($x1, $item['box']['x']); $y1 = min($y1, $item['box']['y']);
            $x2 = max($x2, $item['box']['x'] + $item['box']['w']); $y2 = max($y2, $item['box']['y'] + $item['box']['h']);
        }
        return ['x' => $x1, 'y' => $y1, 'w' => $x2 - $x1, 'h' => $y2 - $y1];
    }

    // XY-cut: split by empty horizontal bands into rows, split each row by empty vertical bands into cells, and recurse into cells
    // that hold several items. Returns rows of cells (a cell is one node or a nested stack of rows), or null when some group of
    // items cannot be separated either way (they interleave), which makes the container an island.
    private function flow_xy_cut($items, $depth = 0) {
        if ($depth > 6) return null;
        usort($items, function ($a, $b) { return $a['box']['y'] <=> $b['box']['y'] ?: $a['box']['x'] <=> $b['box']['x']; });
        $bands = [];
        foreach ($items as $item) {
            $bottom = $item['box']['y'] + $item['box']['h'];
            $last = count($bands) - 1;
            if ($last >= 0 && $item['box']['y'] < $bands[$last]['bottom'] - 1) {
                $bands[$last]['items'][] = $item;
                $bands[$last]['bottom'] = max($bands[$last]['bottom'], $bottom);
            } else {
                $bands[] = ['top' => $item['box']['y'], 'bottom' => $bottom, 'items' => [$item]];
            }
        }
        $rows = [];
        foreach ($bands as $band) {
            $cells_items = [];
            usort($band['items'], function ($a, $b) { return $a['box']['x'] <=> $b['box']['x']; });
            foreach ($band['items'] as $item) {
                $right = $item['box']['x'] + $item['box']['w'];
                $last = count($cells_items) - 1;
                if ($last >= 0 && $item['box']['x'] < $cells_items[$last]['right'] - 1) {
                    $cells_items[$last]['items'][] = $item;
                    $cells_items[$last]['right'] = max($cells_items[$last]['right'], $right);
                } else {
                    $cells_items[] = ['right' => $right, 'items' => [$item]];
                }
            }
            if (count($band['items']) > 1 && count($cells_items) === 1) return null;
            $cells = [];
            foreach ($cells_items as $cell) {
                if (count($cell['items']) === 1) {
                    $cells[] = $cell['items'][0];
                    continue;
                }
                $inner = $this->flow_xy_cut($cell['items'], $depth + 1);
                if ($inner === null) return null;
                $cells[] = ['rows' => $inner, 'box' => $this->flow_union($cell['items'])];
            }
            $rows[] = ['top' => $band['top'], 'bottom' => $band['bottom'], 'items' => $cells];
        }
        return $rows;
    }

    private function flow_is_text($node) {
        return in_array($node['type'] ?? '', ['text', 'heading'], true) && empty($node['children']) && empty($node['elements']);
    }

    // Consecutive one-line text nodes that share a left edge and size are lines of one paragraph; joined, they re-wrap on any width.
    private function flow_merge_lines($rows) {
        $out = [];
        foreach ($rows as $row) {
            $prev = end($out);
            if ($prev && count($prev['items']) === 1 && count($row['items']) === 1) {
                $a = $prev['items'][0];
                $b = $row['items'][0];
                $size_a = (float) ($a['node']['style']['fontSize'] ?? 0);
                $size_b = (float) ($b['node']['style']['fontSize'] ?? 0);
                if (isset($a['node'], $b['node']) && $this->flow_is_text($a['node']) && $this->flow_is_text($b['node'])
                    && ($a['node']['type'] ?? '') === ($b['node']['type'] ?? '')
                    && abs($a['box']['x'] - $b['box']['x']) <= 6 && abs($size_a - $size_b) <= 1
                    && $b['box']['y'] - ($a['box']['y'] + $a['box']['h']) < $a['box']['h'] * 1.1
                    && ($a['node']['style']['color'] ?? '') === ($b['node']['style']['color'] ?? '')) {
                    $merged = $a['node'];
                    $merged['text'] = rtrim((string) ($a['node']['text'] ?? ($a['node']['content'] ?? ''))) . ' ' . ltrim((string) ($b['node']['text'] ?? ($b['node']['content'] ?? '')));
                    unset($merged['content']);
                    $merged['pgMerged'] = 1;
                    $bottom = max($a['box']['y'] + $a['box']['h'], $b['box']['y'] + $b['box']['h']);
                    $box = ['x' => min($a['box']['x'], $b['box']['x']), 'y' => $a['box']['y'], 'w' => max($a['box']['w'], $b['box']['w']), 'h' => $bottom - $a['box']['y']];
                    $out[count($out) - 1] = ['top' => $prev['top'], 'bottom' => $bottom, 'items' => [['node' => $merged, 'box' => $box]]];
                    continue;
                }
            }
            $out[] = $row;
        }
        return $out;
    }

    private function flow_num($value) {
        $value = round((float) $value, 1);
        return $value == (int) $value ? (int) $value : $value;
    }

    // Puts a pgFlow attribute into the first block comment of already serialised block markup.
    private function flow_tag($markup, $flow) {
        if (!preg_match('/^<!-- wp:([a-z\/-]+)( \{.*?\})? -->/s', $markup, $m)) return $markup;
        $attrs = !empty($m[2]) ? json_decode(trim($m[2]), true) : [];
        if (!is_array($attrs)) $attrs = [];
        $attrs['pgFlow'] = $flow;
        $json = serialize_block_attributes($attrs);
        return '<!-- wp:' . $m[1] . ' ' . $json . ' -->' . substr($markup, strlen($m[0]));
    }

    private function flow_without_box($node) {
        unset($node['bbox']);
        return $node;
    }

    // A part of the page kept in pixel-match style (scaled by its own width), used where flow cannot express the layout.
    private function native_flow_island($node, $box) {
        $origin = ['x' => $box['x'], 'y' => $box['y']];
        $parent = ['x' => $box['x'], 'y' => $box['y'], 'width' => $box['w'], 'height' => $box['h']];
        $inner = [];
        $type = $node['type'] ?? '';
        if (in_array($type, ['form', 'form-field', 'table'], true)) {
            $inner[] = $this->native_node($node, $origin, $parent);
        } else {
            foreach ($this->flow_children($node) as $child) {
                $inner[] = $this->native_node($child, $origin, $parent);
            }
        }
        $style = $this->native_style($node, false, true);
        $class = 'page-generator-canvas pg-island';
        $attrs = array_merge(['pgCanvas' => ['w' => $this->flow_num($box['w']), 'h' => $this->flow_num($box['h']), 'max' => $this->flow_num($box['w'])], 'className' => $class], $style['attrs']);
        $open = '<div class="wp-block-group ' . esc_attr($this->native_class_attr('', $class, $style['classes'])) . '"' . ($style['css'] !== '' ? ' style="' . esc_attr($style['css']) . '"' : '') . '>';
        return $this->native_block('core/group', $attrs, $open, implode("\n\n", array_filter($inner)), '</div>');
    }

    // $slot describes the node's place in its parent row: basis/grow in px, margins, and the page width for scaling.
    private function native_flow_node($node, $slot) {
        if (!is_array($node)) return '';
        $type = sanitize_key($node['type'] ?? 'container');
        $box = $this->flow_box($node);
        $flow = $slot;
        $plain = $this->flow_without_box($node);
        $origin = ['x' => 0, 'y' => 0];
        if ($box) {
            $flow['iw'] = $this->flow_num($box['w']);
            $flow['ih'] = $this->flow_num($box['h']);
        }
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $font = $style['fontSize'] ?? ($node['settings']['fontSize'] ?? null);
        if (is_numeric($font) && $font > 0) $flow['fs'] = $this->flow_num($font);
        // A short one-line label stays on one line; only longer text (and merged paragraphs) may wrap.
        if ($box && in_array($type, ['text', 'heading', 'link', 'badge', 'logo'], true) && empty($node['pgMerged']) && $box['w'] <= 320) $flow['nw'] = 1;
        switch ($type) {
            case 'heading':
                return $this->flow_tag($this->native_text_block($plain, $origin, 'h2'), $flow + ['t' => 1]);
            case 'text':
            case 'logo':
                return $this->flow_tag($this->native_text_block($plain, $origin, 'p'), $flow + ['t' => 1]);
            case 'link':
                return $this->flow_tag($this->native_text_block($plain, $origin, 'p', 'pg-link', true), $flow + ['t' => 1]);
            case 'badge':
                return $this->flow_tag($this->native_text_block($plain, $origin, 'p', 'pg-badge', false, true), $flow + ['t' => 1]);
            case 'button':
                return $this->flow_tag($this->native_button_block($plain, $origin), $flow);
            case 'image':
                return $this->flow_tag($this->native_image_block($plain, $origin), $flow + ['im' => 1]);
            case 'icon':
                return $this->flow_tag($this->native_group_block($plain, $origin, [], true), $flow + ['im' => 1]);
            case 'form':
                // The built-in form renderer, without coordinates, stacks its fields full width: that is already a flow layout.
                // OCR sometimes reads a placeholder twice, the second time as a field with an empty placeholder: drop that duplicate.
                $key = !empty($plain['children']) ? 'children' : 'elements';
                $fields = (array) ($plain[$key] ?? []);
                $placeholders = array_map(function ($f) { return trim((string) ($f['placeholder'] ?? '')); }, $fields);
                $plain[$key] = array_values(array_filter($fields, function ($f) use ($placeholders) {
                    return ($f['type'] ?? '') !== 'form-field' || trim((string) ($f['placeholder'] ?? '')) !== '' || !in_array(trim((string) ($f['label'] ?? '')), $placeholders, true);
                }));
                // Buttons go last, whatever order nesting left the fields in.
                usort($plain[$key], function ($a, $b) { return (($a['type'] ?? '') === 'button') <=> (($b['type'] ?? '') === 'button'); });
                $form = $this->serialize_component_block($plain, null, false);
                return $this->flow_tag($this->native_block('core/group', [], '<div class="wp-block-group">', $form, '</div>'), $slot + ['fill' => 1]);
            case 'form-field':
            case 'table':
                return $box ? $this->flow_tag($this->native_flow_island($node, $box), $flow) : '';
        }
        $children = $this->flow_children($node);
        if (!$children) {
            return $this->flow_tag($this->native_group_block($plain, $origin, [], true), $flow + ['im' => 1]);
        }
        $rows = $box ? $this->flow_rows($children) : null;
        if ($rows === null) {
            return $box ? $this->flow_tag($this->native_flow_island($node, $box), $flow) : '';
        }
        $rows = $this->flow_merge_lines($rows);
        $content = $this->flow_container_inner($rows, $box, $flow);
        $flow = $content['flow'];
        return $this->flow_tag($this->native_group_block($plain, $origin, $content['blocks']), $flow + ['d' => 'column']);
    }

    // Rows whose cells line up in three or more columns (the same left edges row after row) are a table: each row becomes a grid
    // with one shared column template, so the columns stay aligned however the cells are filled. Returns null otherwise.
    private function flow_table_columns($rows, $box) {
        if (count($rows) < 3) return null;
        $edges = [];
        foreach ($rows as $row) {
            if (count($row['items']) < 2) continue;
            foreach ($row['items'] as $item) $edges[] = $item['box']['x'];
        }
        if (count($edges) < 6) return null;
        sort($edges);
        $columns = [];
        foreach ($edges as $x) {
            $last = count($columns) - 1;
            if ($last >= 0 && $x - end($columns[$last]) <= 10) $columns[$last][] = $x;
            else $columns[] = [$x];
        }
        $lefts = array_map(function ($group) { return min($group); }, $columns);
        if (count($lefts) < 3) return null;
        // Most rows must fill (nearly) every column, otherwise this is ordinary content that happens to share an edge.
        $full = 0;
        $multi = 0;
        foreach ($rows as $row) {
            if (count($row['items']) >= 2) {
                $multi++;
                if (count($row['items']) >= count($lefts) - 1) $full++;
            }
        }
        if ($multi < 3 || $full < $multi * .7) return null;
        return $lefts;
    }

    // One table row as a grid row: cell i sits in the column whose left edge is nearest to the item's own.
    private function flow_grid_row($row, $lefts, $right_edge, $flow, $slot_item) {
        $cells = array_fill(0, count($lefts), null);
        foreach ($row['items'] as $item) {
            $best = 0;
            foreach ($lefts as $i => $left) {
                if (abs($left - $item['box']['x']) < abs($lefts[$best] - $item['box']['x'])) $best = $i;
            }
            if ($cells[$best] === null) $cells[$best] = $item;
        }
        $blocks = [];
        foreach ($cells as $cell) {
            $blocks[] = $cell === null
                ? $this->native_block('core/group', [], '<div class="wp-block-group">', '', '</div>')
                : $this->native_flow_cell($cell, $slot_item);
        }
        $spans = [];
        foreach ($lefts as $i => $left) $spans[] = max(1, ($lefts[$i + 1] ?? $right_edge) - $left);
        return $this->flow_tag($this->native_block('core/group', [], '<div class="wp-block-group">', implode("\n\n", array_filter($blocks, 'strlen')), '</div>'), $flow + ['cols' => array_map([$this, 'flow_num'], $spans), 'tw' => $this->flow_num(array_sum($spans))]);
    }

    // One cell of a row: a node, or a nested stack of rows (a column of a multi-column row).
    private function native_flow_cell($item, $slot) {
        if (isset($item['node'])) {
            return $this->native_flow_node($item['node'], $slot);
        }
        $inner = $this->flow_container_inner($item['rows'], $item['box'], $slot);
        $flow = $inner['flow'];
        unset($flow['mh']);
        return $this->flow_tag($this->native_block('core/group', [], '<div class="wp-block-group">', implode("\n\n", array_filter($inner['blocks'])), '</div>'), $flow + ['d' => 'column']);
    }

    // What a row of cells looks like: how many, the typical gap, whether it fills the width, and the free space on each side.
    private function flow_row_metrics($row, $box, $pad_l, $edge_r, $content_w) {
        $count = count($row['items']);
        $gaps = [];
        for ($i = 1; $i < $count; $i++) {
            $gaps[] = max(0, $row['items'][$i]['box']['x'] - ($row['items'][$i - 1]['box']['x'] + $row['items'][$i - 1]['box']['w']));
        }
        sort($gaps);
        $gap = $gaps ? $gaps[intdiv(count($gaps), 2)] : 0;
        $sum = 0;
        foreach ($row['items'] as $item) $sum += $item['box']['w'];
        $first = $row['items'][0]['box'];
        $last = end($row['items'])['box'];
        $left_gap = $first['x'] - $box['x'] - $pad_l;
        $right_gap = $edge_r - ($last['x'] + $last['w']);
        $centers = array_map(function ($item) { return $item['box']['y'] + $item['box']['h'] / 2; }, $row['items']);
        return [
            'count' => $count,
            'gap' => $gap,
            'fills' => ($sum + $gap * max(0, $count - 1)) >= $content_w * .9,
            'left_gap' => $left_gap,
            'right_gap' => $right_gap,
            // A wide gap between items that reach both edges is space-between, not a gap: it must not force a wrap.
            'jb' => $count > 1 && $gap > 40 && $left_gap < 4 && $right_gap < 4,
            'centered' => $count > 1 && max($centers) - min($centers) <= 3,
        ];
    }

    // The place of one cell in its row: its share of the row (several cells) or whether it spans the full width (a single cell).
    private function flow_item_slot($item, $m, $content_w) {
        $slot = [];
        $is_text = isset($item['node']) && $this->flow_is_text($item['node']);
        if ($m['count'] > 1) {
            $slot['bp'] = $this->flow_num($item['box']['w'] / $content_w * 100);
            $slot['gs'] = $this->flow_num(($m['jb'] ? 16 : $m['gap']) * ($m['count'] - 1) / $m['count']);
            $grows = $m['fills'] && !$is_text && !in_array($item['node']['type'] ?? '', ['button', 'badge', 'image', 'icon', 'link'], true);
            $slot['b'] = $this->flow_num($item['box']['w']);
            if ($grows) $slot['gr'] = $this->flow_num($item['box']['w']);
        } elseif ($item['box']['w'] >= $content_w * .92 && !$is_text) {
            $slot['fill'] = 1;
        }
        return $slot;
    }

    // Blocks for the rows of one container, plus the container's own padding measured from its children.
    private function flow_container_inner($rows, $box, $flow) {
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
        $flow['p'] = [$this->flow_num($pad_t), $this->flow_num($pad_r), $this->flow_num($pad_b), $this->flow_num($pad_l)];
        $flow['mh'] = $this->flow_num($box['h']);
        $blocks = [];
        $table = $this->flow_table_columns($rows, $box);
        if ($table !== null) $flow['sx'] = 1;
        $previous_bottom = $rows[0]['top'];
        foreach ($rows as $index => $row) {
            $gap_above = $index === 0 ? 0 : max(0, $row['top'] - $previous_bottom);
            $previous_bottom = $row['bottom'];
            if ($table !== null && count($row['items']) >= 2) {
                $blocks[] = $this->flow_grid_row($row, $table, $edge_r, $gap_above > 0 ? ['mt' => $this->flow_num($gap_above)] : [], []);
                continue;
            }
            $m = $this->flow_row_metrics($row, $box, $pad_l, $edge_r, $content_w);
            $count = $m['count'];
            $row_gap = $m['gap'];
            $left_gap = $m['left_gap'];
            $right_gap = $m['right_gap'];
            $blocks_in_row = [];
            foreach ($row['items'] as $item) {
                $item_flow = $this->flow_item_slot($item, $m, $content_w);
                $blocks_in_row[] = $this->native_flow_cell($item, $item_flow);
            }
            if ($count === 1) {
                $only = [];
                if ($gap_above > 0) $only['mt'] = $this->flow_num($gap_above);
                // A narrow single item is centred or pushed right when the free space says so, otherwise it starts at its own offset.
                if (!isset($item_flow['fill'])) {
                    if ($left_gap > 4 && $right_gap > 4 && abs($left_gap - $right_gap) <= 6) $only['ml'] = 'c';
                    elseif ($right_gap < 4 && $left_gap > 12) $only['ml'] = 'r';
                    elseif ($left_gap > 4) $only['ml'] = $this->flow_num($left_gap);
                }
                $blocks[] = $this->flow_tag_slot($blocks_in_row[0], $only);
                continue;
            }
            // Several items in a row: a flex row that wraps when the screen is too narrow for them.
            $row_flow = ['d' => 'row', 'g' => $m['jb'] ? 16 : $this->flow_num($row_gap), 'wr' => 1];
            if ($m['jb']) $row_flow['jb'] = 1;
            if ($gap_above > 0) $row_flow['mt'] = $this->flow_num($gap_above);
            if ($m['centered']) $row_flow['ai'] = 'c';
            if ($left_gap > 4) $row_flow['ml'] = $this->flow_num($left_gap);
            $row_markup = $this->native_block('core/group', [], '<div class="wp-block-group">', implode("\n\n", array_filter($blocks_in_row)), '</div>');
            $blocks[] = $this->flow_tag($row_markup, $row_flow);
        }
        return ['blocks' => $blocks, 'flow' => $flow];
    }

    // Adds spacing keys to a block that already carries a pgFlow attribute.
    private function flow_tag_slot($markup, $extra) {
        if (!$extra || !preg_match('/^<!-- wp:([a-z\/-]+) (\{.*?\}) -->/s', $markup, $m)) return $markup;
        $attrs = json_decode($m[2], true);
        if (!is_array($attrs)) return $markup;
        $attrs['pgFlow'] = array_merge($attrs['pgFlow'] ?? [], $extra);
        return '<!-- wp:' . $m[1] . ' ' . serialize_block_attributes($attrs) . ' -->' . substr($markup, strlen($m[0]));
    }

    private function native_flow_content($schema) {
        $content = [];
        foreach ($this->group_sections($schema) as $group) {
            $first = $group['sections'][0] ?? [];
            $width = absint($first['settings']['sourceWidth'] ?? 0);
            $sections = [];
            foreach ($group['sections'] as $section) {
                $sections[] = $this->native_flow_node($section, ['fill' => 1]);
            }
            $class = 'pg-flow-page' . $this->breakpoint_classes($group);
            $attrs = ['pgFlow' => ['root' => 1, 'w' => $width ?: 1200], 'className' => $class];
            $content[] = $this->native_block('core/group', $attrs, '<div class="wp-block-group ' . $class . '">', implode("\n\n", array_filter($sections)), '</div>');
        }
        return implode("\n\n", $content) . "\n";
    }
}
