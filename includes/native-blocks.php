<?php
defined('ABSPATH') || exit;

/**
 * Bridge between the Page Schema and native Gutenberg blocks.
 *
 * The schema is emitted as ordinary core blocks (group, paragraph, heading, buttons, image, table). The pixel box of a node is
 * kept in an extra block attribute (pgBox / pgCanvas) and is applied by CSS, so every block stays editable with the stock UI.
 */
trait Page_Generator_Native_Blocks {
    private function bridged_blocks() {
        return ['core/group', 'core/paragraph', 'core/heading', 'core/buttons', 'core/image', 'core/table'];
    }

    private function register_native_bridge() {
        add_filter('register_block_type_args', [$this, 'add_bridge_attributes'], 10, 2);
        add_filter('render_block', [$this, 'apply_bridge_box'], 10, 2);
        add_action('enqueue_block_assets', [$this, 'enqueue_canvas_styles']);
    }

    public function add_bridge_attributes($args, $name) {
        if (in_array($name, $this->bridged_blocks(), true)) {
            $args['attributes']['pgBox'] = ['type' => 'object'];
            $args['attributes']['pgCanvas'] = ['type' => 'object'];
            $args['attributes']['pgFlow'] = ['type' => 'object'];
            $args['attributes']['pgId'] = ['type' => 'string'];
        }
        return $args;
    }

    public function enqueue_canvas_styles() {
        if (!is_admin()) {
            $post = get_post();
            if (!$post instanceof WP_Post || strpos($post->post_content, 'page-generator-canvas') === false && strpos($post->post_content, 'pg-flow-page') === false) {
                return;
            }
        }
        wp_enqueue_style('page-generator-canvas', plugins_url('assets/canvas.css', dirname(__DIR__) . '/page-generator.php'), [], self::VERSION);
    }

    public function apply_bridge_box($html, $block) {
        $attrs = is_array($block['attrs'] ?? null) ? $block['attrs'] : [];
        $box = is_array($attrs['pgBox'] ?? null) ? $attrs['pgBox'] : null;
        $canvas = is_array($attrs['pgCanvas'] ?? null) ? $attrs['pgCanvas'] : null;
        $flow = is_array($attrs['pgFlow'] ?? null) ? $attrs['pgFlow'] : null;
        if ($flow && is_string($html) && $html !== '' && class_exists('WP_HTML_Tag_Processor')) {
            $html = $this->apply_flow_attrs($html, $flow);
        }
        if ((!$box && !$canvas) || !is_string($html) || $html === '' || !class_exists('WP_HTML_Tag_Processor')) {
            return $html;
        }
        $variables = '';
        $classes = [];
        if ($box) {
            foreach (['x', 'y', 'w', 'h', 'fs'] as $key) {
                if (isset($box[$key]) && is_numeric($box[$key])) {
                    $variables .= '--pg-' . $key . ':' . (0 + $box[$key]) . ';';
                }
            }
            $classes[] = 'pg-abs';
            if (in_array($block['blockName'] ?? '', ['core/paragraph', 'core/heading'], true)) {
                $classes[] = 'pg-text';
            }
        }
        if ($canvas) {
            foreach (['w', 'h'] as $key) {
                if (isset($canvas[$key]) && is_numeric($canvas[$key])) {
                    $variables .= '--pg-' . $key . ':' . (0 + $canvas[$key]) . ';';
                }
            }
            $max = isset($canvas['max']) && is_numeric($canvas['max']) ? absint($canvas['max']) : absint($this->settings()['default_container_width']);
            $variables .= '--pg-max:' . $max . 'px;';
            $classes[] = 'page-generator-canvas';
        }
        $processor = new WP_HTML_Tag_Processor($html);
        if (!$processor->next_tag()) {
            return $html;
        }
        foreach ($classes as $class) {
            $processor->add_class($class);
        }
        $style = trim((string) $processor->get_attribute('style'));
        $style = $style !== '' ? rtrim($style, ';') . ';' : '';
        $processor->set_attribute('style', $style . $variables);
        return $processor->get_updated_html();
    }

    // pgFlow -> classes and CSS variables read by canvas.css (see "Flow layout").
    public function apply_flow_attrs($html, $flow) {
        $classes = ['pg-flow'];
        $vars = [];
        $number = function ($key, $name) use ($flow, &$vars) {
            if (isset($flow[$key]) && is_numeric($flow[$key])) $vars[] = '--pg-' . $name . ':' . (0 + $flow[$key]);
        };
        if (!empty($flow['root'])) $classes[] = 'pg-fr';
        if (!empty($flow['d'])) {
            $classes[] = 'pg-fc';
            $vars[] = '--pg-d:' . ($flow['d'] === 'row' ? 'row' : 'column');
            if (!empty($flow['wr'])) $classes[] = 'pg-wrap';
            if (($flow['ai'] ?? '') === 'c') $classes[] = 'pg-ai-c';
            if (!empty($flow['jb'])) $classes[] = 'pg-jb';
        }
        if (!empty($flow['t'])) $classes[] = 'pg-ft';
        if (!empty($flow['nw'])) $classes[] = 'pg-nw';
        if (!empty($flow['sx'])) $classes[] = 'pg-sx';
        if (!empty($flow['cols']) && is_array($flow['cols'])) {
            $classes[] = 'pg-fg';
            $vars[] = '--pg-cols:' . implode(' ', array_map(function ($n) { return (0 + $n) . 'fr'; }, $flow['cols']));
        }
        if (!empty($flow['im'])) $classes[] = 'pg-fm';
        if (!empty($flow['fill'])) $classes[] = 'pg-fill';
        if (isset($flow['gr'])) $classes[] = 'pg-grow';
        if (($flow['ml'] ?? '') === 'c') $classes[] = 'pg-mc';
        elseif (($flow['ml'] ?? '') === 'r') $classes[] = 'pg-mr';
        elseif (isset($flow['ml']) && is_numeric($flow['ml'])) $vars[] = '--pg-ml:' . (0 + $flow['ml']);
        foreach (['g' => 'g', 'b' => 'b', 'gr' => 'gr', 'mt' => 'mt', 'fs' => 'fs', 'w' => 'w', 'iw' => 'iw', 'ih' => 'ih', 'mh' => 'mh', 'bp' => 'bp', 'gs' => 'gs', 'tw' => 'tw'] as $key => $name) $number($key, $name);
        if (!empty($flow['p']) && is_array($flow['p']) && count($flow['p']) === 4) {
            foreach (['pt', 'pr', 'pb', 'pl'] as $i => $name) $vars[] = '--pg-' . $name . ':' . (0 + $flow['p'][$i]);
        }
        $processor = new WP_HTML_Tag_Processor($html);
        if (!$processor->next_tag()) return $html;
        foreach ($classes as $class) $processor->add_class($class);
        $style = trim((string) $processor->get_attribute('style'));
        $style = $style !== '' ? rtrim($style, ';') . ';' : '';
        $processor->set_attribute('style', $style . implode(';', $vars) . ';');
        return $processor->get_updated_html();
    }

    // ---- Schema -> native blocks -------------------------------------------------------------------------------------------

    private function native_number($value) {
        $number = round((float) $value, 1);
        return $number == (int) $number ? (int) $number : $number;
    }

    private function native_block($name, $attrs, $open, $inner, $close) {
        $short = preg_replace('#^core/#', '', $name);
        $json = $attrs ? ' ' . serialize_block_attributes($attrs) : '';
        return '<!-- wp:' . $short . $json . ' -->' . "\n" . $open . $inner . $close . "\n" . '<!-- /wp:' . $short . ' -->';
    }

    private function native_box($node, $origin) {
        $bbox = is_array($node['bbox'] ?? null) ? $node['bbox'] : null;
        if (!$bbox || !isset($bbox['x'], $bbox['y'], $bbox['width'], $bbox['height'])) {
            return null;
        }
        $box = [
            'x' => $this->native_number((float) $bbox['x'] - (float) $origin['x']),
            'y' => $this->native_number((float) $bbox['y'] - (float) $origin['y']),
            'w' => $this->native_number(max(1, (float) $bbox['width'])),
            'h' => $this->native_number(max(1, (float) $bbox['height'])),
        ];
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $font = $style['fontSize'] ?? ($node['settings']['fontSize'] ?? null);
        if (is_numeric($font) && $font > 0) {
            $box['fs'] = $this->native_number($font);
        }
        return $box;
    }

    // The node id travels with its block so edits can be read back into the schema (see block-sync.php).
    private function native_id($node) {
        $id = is_array($node) && isset($node['id']) && is_string($node['id']) ? preg_replace('/[^A-Za-z0-9_-]/', '', $node['id']) : '';
        return $id !== '' ? ['pgId' => $id] : [];
    }

    private function native_color($value) {
        $value = strtolower(trim((string) $value));
        return preg_match('/^#[0-9a-f]{6}$/', $value) ? $value : '';
    }

    /**
     * Style attributes, inline CSS and classes in the exact order Gutenberg's own save() produces them,
     * so the blocks validate in the editor without a "recover block" prompt.
     */
    private function native_style($node, $text = false, $background = true) {
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $attrs = [];
        $css = '';
        $classes = ['text' => false, 'background' => false, 'border' => false];
        $text_color = $text ? $this->native_color($style['color'] ?? '') : '';
        $fill = $background ? $this->native_color($style['background'] ?? ($node['background'] ?? '')) : '';
        $radius = absint($style['borderRadius'] ?? 0);
        $border_color = $this->native_color($style['borderColor'] ?? '');
        $border_width = absint($style['borderWidth'] ?? 0);
        $accent_color = $this->native_color($style['accentColor'] ?? '');
        $accent_width = absint($style['accentWidth'] ?? 0);

        if ($accent_color && $accent_width) {
            $edge = $border_color && $border_width ? ['color' => $border_color, 'width' => $border_width . 'px'] : null;
            $attrs['border'] = ['radius' => $radius . 'px'];
            $css .= 'border-radius:' . $radius . 'px;';
            foreach (['top', 'right', 'bottom'] as $side) {
                if ($edge) {
                    $attrs['border'][$side] = $edge;
                    $css .= 'border-' . $side . '-color:' . $edge['color'] . ';border-' . $side . '-width:' . $edge['width'] . ';';
                }
            }
            $attrs['border']['left'] = ['color' => $accent_color, 'width' => $accent_width . 'px'];
            $css .= 'border-left-color:' . $accent_color . ';border-left-width:' . $accent_width . 'px;';
        } elseif ($border_color && $border_width) {
            $attrs['border'] = ['radius' => $radius . 'px', 'color' => $border_color, 'width' => $border_width . 'px'];
            $css .= 'border-color:' . $border_color . ';border-width:' . $border_width . 'px;border-radius:' . $radius . 'px;';
            $classes['border'] = true;
        } elseif ($radius) {
            $attrs['border'] = ['radius' => $radius . 'px'];
            $css .= 'border-radius:' . $radius . 'px;';
        }
        if ($text_color) {
            $attrs['color']['text'] = $text_color;
            $css .= 'color:' . $text_color . ';';
            $classes['text'] = true;
        }
        $weight = absint($style['fontWeight'] ?? 0);
        if ($text && in_array($weight, [500, 600, 700, 800], true)) {
            // Weight comes from the screenshot (measured per text line); regular text keeps the theme's default.
            $attrs['typography']['fontWeight'] = (string) $weight;
            $css .= 'font-weight:' . $weight . ';';
        }
        $gradient = $background ? $this->gradient_css($style) : '';
        if ($gradient) {
            $attrs['color']['gradient'] = $gradient;
            $css .= 'background:' . $gradient . ';';
            $classes['background'] = true;
        } elseif ($background && ($image = $this->backdrop_image($style))) {
            if ($fill) {
                $attrs['color']['background'] = $fill;
                $css .= 'background-color:' . $fill . ';';
                $classes['background'] = true;
            }
            $attrs['background']['backgroundImage'] = ['url' => $image['url'], 'id' => $image['id'], 'source' => 'file'];
            $attrs['background']['backgroundSize'] = 'cover';
            $attrs['background']['backgroundPosition'] = '50% 50%';
            // Core writes background-image styles at render time (block support), so the saved markup carries only the attributes.
        } elseif ($fill) {
            $attrs['color']['background'] = $fill;
            $css .= 'background-color:' . $fill . ';';
            $classes['background'] = true;
        }
        if (!empty($style['shadow'])) {
            $shadow = '0 2px 10px rgba(15,23,42,.08)';
            $attrs['shadow'] = $shadow;
            $css .= 'box-shadow:' . $shadow . ';';
        }
        return ['attrs' => $attrs ? ['style' => $attrs] : [], 'css' => rtrim($css, ';'), 'classes' => $classes];
    }

    private function native_class_attr($base, $custom, $classes) {
        $parts = array_filter([$base, $custom]);
        if ($classes['border']) $parts[] = 'has-border-color';
        if ($classes['text']) $parts[] = 'has-text-color';
        if ($classes['background']) $parts[] = 'has-background';
        return implode(' ', $parts);
    }

    private function native_text_block($node, $origin, $tag, $custom_class = '', $link = false, $background = false) {
        $label = (string) ($node['text'] ?? ($node['content'] ?? ''));
        $style = $this->native_style($node, true, $background);
        // The face is a class (not inline CSS) so the block still validates against its saved markup.
        if (($node['style']['fontFamily'] ?? '') === 'serif') $custom_class = trim($custom_class . ' pg-serif');
        $attrs = $this->native_id($node);
        if ($box = $this->native_box($node, $origin)) $attrs['pgBox'] = $box;
        if ($custom_class) $attrs['className'] = $custom_class;
        $attrs = array_merge($attrs, $style['attrs']);
        $base = $tag === 'p' ? '' : 'wp-block-heading';
        $class = $this->native_class_attr($base, $custom_class, $style['classes']);
        $content = esc_html($label);
        if ($link) {
            $content = '<a href="' . esc_url($node['behavior']['url'] ?? '#') . '">' . $content . '</a>';
        }
        $open = '<' . $tag . ($class ? ' class="' . esc_attr($class) . '"' : '') . ($style['css'] !== '' ? ' style="' . esc_attr($style['css']) . '"' : '') . '>';
        return $this->native_block($tag === 'p' ? 'paragraph' : 'heading', $attrs, $open, $content, '</' . $tag . '>');
    }

    private function native_button_block($node, $origin) {
        $label = (string) ($node['text'] ?? ($node['content'] ?? ''));
        $style = $this->native_style($node, true, true);
        $url = esc_url($node['behavior']['url'] ?? '#') ?: '#';
        $button_attrs = $style['attrs'];
        $link_class = trim('wp-block-button__link ' . implode(' ', array_filter([
            $style['classes']['border'] ? 'has-border-color' : '',
            $style['classes']['text'] ? 'has-text-color' : '',
            $style['classes']['background'] ? 'has-background' : '',
        ])) . ' wp-element-button');
        $link_class = preg_replace('/\s+/', ' ', $link_class);
        $inner = $this->native_block('core/button', $button_attrs,
            '<div class="wp-block-button"><a class="' . esc_attr($link_class) . '" href="' . esc_url($url) . '"' . ($style['css'] !== '' ? ' style="' . esc_attr($style['css']) . '"' : '') . '>',
            esc_html($label), '</a></div>');
        $attrs = $this->native_id($node);
        if ($box = $this->native_box($node, $origin)) $attrs['pgBox'] = $box;
        return $this->native_block('core/buttons', $attrs, '<div class="wp-block-buttons">', $inner, '</div>');
    }

    private function native_image_block($node, $origin) {
        $asset = is_array($node['asset'] ?? null) ? $node['asset'] : [];
        $url = esc_url($node['url'] ?? ($asset['url'] ?? ''));
        $id = absint($node['attachmentId'] ?? ($asset['id'] ?? 0));
        if (!$url) {
            return $this->native_group_block($node, $origin, [], true);
        }
        $radius = absint(($node['style']['borderRadius'] ?? 0));
        $attrs = $this->native_id($node);
        if ($id) $attrs['id'] = $id;
        $attrs['sizeSlug'] = 'full';
        $attrs['linkDestination'] = 'none';
        if ($box = $this->native_box($node, $origin)) $attrs['pgBox'] = $box;
        if ($radius) $attrs['style'] = ['border' => ['radius' => $radius . 'px']];
        $figure_class = 'wp-block-image size-full' . ($radius ? ' has-custom-border' : '');
        $img = '<img src="' . esc_url($url) . '" alt="' . esc_attr($node['alt'] ?? '') . '"' . ($id ? ' class="wp-image-' . $id . '"' : '') . ($radius ? ' style="border-radius:' . $radius . 'px"' : '') . '/>';
        return $this->native_block('core/image', $attrs, '<figure class="' . $figure_class . '">', $img, '</figure>');
    }

    private function native_table_block($node, $origin) {
        $rows = is_array($node['rows'] ?? null) ? $node['rows'] : [];
        if (!$rows) {
            return '';
        }
        $head = '';
        $body = '';
        foreach ($rows as $index => $row) {
            $cells = '';
            foreach ((array) $row as $cell) {
                $tag = $index === 0 ? 'th' : 'td';
                $cells .= '<' . $tag . '>' . esc_html($cell['text'] ?? ($cell['content'] ?? '')) . '</' . $tag . '>';
            }
            if ($index === 0) $head = '<thead><tr>' . $cells . '</tr></thead>'; else $body .= '<tr>' . $cells . '</tr>';
        }
        $attrs = $this->native_id($node);
        if ($box = $this->native_box($node, $origin)) $attrs['pgBox'] = $box;
        return $this->native_block('core/table', $attrs, '<figure class="wp-block-table"><table class="has-fixed-layout">', $head . '<tbody>' . $body . '</tbody>', '</table></figure>');
    }

    private function native_group_block($node, $origin, $children, $leaf = false, $custom = []) {
        $style = $this->native_style($node, false, true);
        $attrs = $custom + $this->native_id($node);
        if ($box = $this->native_box($node, $origin)) $attrs['pgBox'] = $box;
        $attrs = array_merge($attrs, $style['attrs']);
        $class = $this->native_class_attr('wp-block-group', '', $style['classes']);
        $open = '<div class="' . esc_attr($class) . '"' . ($style['css'] !== '' ? ' style="' . esc_attr($style['css']) . '"' : '') . '>';
        return $this->native_block('core/group', $attrs, $open, implode("\n\n", array_filter($children)), '</div>');
    }

    private function native_node($node, $origin, $parent_box) {
        if (!is_array($node)) {
            return '';
        }
        $type = sanitize_key($node['type'] ?? 'container');
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        switch ($type) {
            case 'heading':
                return $this->native_text_block($node, $origin, 'h2');
            case 'text':
                return $this->native_text_block($node, $origin, 'p');
            case 'link':
                return $this->native_text_block($node, $origin, 'p', 'pg-link', true);
            case 'logo':
                return $this->native_text_block($node, $origin, 'p');
            case 'badge':
                return $this->native_text_block($node, $origin, 'p', 'pg-badge', false, true);
            case 'button':
                return $this->native_button_block($node, $origin);
            case 'image':
                return $this->native_image_block($node, $origin);
            case 'icon':
                return $this->native_group_block($node, $origin, [], true);
            case 'table':
                $table = $this->native_table_block($node, $origin);
                if ($table !== '') {
                    return $table;
                }
                break;
            case 'form':
                if ($this->wpforms_node_active($node)) {
                    $embed = $this->native_block('core/html', [], '', $this->wpforms_embed_html($node), '');
                    return $this->native_group_block($node, $origin, [$embed], true);
                }
                // no break: forms without a WPForms counterpart use the built-in renderer.
            case 'form-field':
                return $this->serialize_component_block($node, [
                    'width' => max(1, (float) ($parent_box['width'] ?? 1)),
                    'height' => max(1, (float) ($parent_box['height'] ?? 1)),
                    'offsetX' => (float) ($parent_box['x'] ?? 0),
                    'offsetY' => (float) ($parent_box['y'] ?? 0),
                ], false);
        }
        $own = is_array($node['bbox'] ?? null) ? $node['bbox'] : null;
        $child_origin = $own ? ['x' => (float) ($own['x'] ?? 0), 'y' => (float) ($own['y'] ?? 0)] : $origin;
        $child_parent = $own ?: $parent_box;
        $inner = [];
        foreach ($children as $child) {
            $inner[] = $this->native_node($child, $child_origin, $child_parent);
        }
        return $this->native_group_block($node, $origin, $inner);
    }

    private function native_content($schema) {
        $content = [];
        foreach ($this->group_sections($schema) as $group) {
            $first = $group['sections'][0] ?? [];
            $width = absint($first['settings']['sourceWidth'] ?? 0);
            $height = absint($first['settings']['sourceHeight'] ?? 0);
            $canvas_box = ['x' => 0, 'y' => 0, 'width' => $width ?: 1, 'height' => $height ?: 1];
            $sections = [];
            foreach ($group['sections'] as $section) {
                $sections[] = $this->native_node($section, ['x' => 0, 'y' => 0], $canvas_box);
            }
            $class = 'page-generator-canvas' . $this->breakpoint_classes($group);
            $attrs = ['pgCanvas' => ['w' => $width, 'h' => $height], 'className' => $class];
            $content[] = $this->native_block('core/group', $attrs, '<div class="wp-block-group ' . $class . '">', implode("\n\n", array_filter($sections)), '</div>');
        }
        return implode("\n\n", $content) . "\n";
    }
}
