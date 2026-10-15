<?php
/**
 * Form export: a detected form becomes a real WPForms form (fields, labels, placeholders, submit text) and the page embeds it by
 * shortcode. Off by default (Settings), because WPForms lays fields out with its own CSS and the result is a working form rather
 * than a pixel copy of the screenshot.
 */
if (!defined('ABSPATH')) {
    exit;
}

trait Page_Generator_WPForms_Export {
    private $wpforms_enabled = false;

    private function wpforms_available() {
        return post_type_exists('wpforms') || function_exists('wpforms');
    }

    // `$mode` is 'wpforms', 'custom' or '' (use the setting).
    private function wpforms_wanted($mode) {
        if (!$this->wpforms_available()) {
            return false;
        }
        return $mode === 'wpforms' || ($mode !== 'custom' && !empty($this->settings()['use_wpforms']));
    }

    // Creates (or updates, in document order) one WPForms form per detected form and records its id on the node as `wpformsId`.
    private function attach_wpforms($schema, $post_id) {
        $known = get_post_meta($post_id, '_page_generator_wpforms', true);
        $known = is_array($known) ? array_values($known) : [];
        $used = [];
        $index = 0;
        $visit = function (&$nodes) use (&$visit, &$known, &$used, &$index, $post_id) {
            foreach ($nodes as &$node) {
                if (!is_array($node)) continue;
                if (($node['type'] ?? '') === 'form') {
                    $fields = $this->wpforms_fields($node);
                    if ($fields) {
                        $existing = absint($known[$index] ?? 0);
                        if ($existing && get_post_type($existing) !== 'wpforms') $existing = 0;
                        $form_id = $this->wpforms_save($existing, $node, $fields, $post_id, $index);
                        if ($form_id) {
                            $node['wpformsId'] = $form_id;
                            $used[$index] = $form_id;
                        }
                    }
                    $index++;
                    continue;
                }
                // `children` and `elements` can both hold the same subtree; the renderers read `children` first, so only that copy is visited.
                $key = !empty($node['children']) && is_array($node['children']) ? 'children' : 'elements';
                if (!empty($node[$key]) && is_array($node[$key])) $visit($node[$key]);
            }
        };
        if (!empty($schema['sections']) && is_array($schema['sections'])) {
            $visit($schema['sections']);
        }
        if (!empty($schema['variants']['mobile']['sections']) && is_array($schema['variants']['mobile']['sections'])) {
            $visit($schema['variants']['mobile']['sections']);
        }
        update_post_meta($post_id, '_page_generator_wpforms', array_values($used));
        return $schema;
    }

    private function wpforms_field_nodes($node) {
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        return array_values(array_filter((array) $children, function ($child) {
            return is_array($child) && ($child['type'] ?? '') === 'form-field';
        }));
    }

    // Fields in reading order, each with the WPForms layout class that reproduces the screenshot's column count for its row.
    private function wpforms_fields($node) {
        $nodes = $this->wpforms_field_nodes($node);
        if (!$nodes) return [];
        // OCR sometimes reads a placeholder a second time as a field of its own (empty placeholder, label equal to another field's placeholder).
        $placeholders = array_map(function ($field) { return trim((string) ($field['placeholder'] ?? '')); }, $nodes);
        $nodes = array_values(array_filter($nodes, function ($field) use ($placeholders) {
            return trim((string) ($field['placeholder'] ?? '')) !== '' || !in_array(trim((string) ($field['label'] ?? '')), $placeholders, true);
        }));
        usort($nodes, function ($a, $b) {
            $ay = (float) ($a['bbox']['y'] ?? ($a['labelBox']['y'] ?? 0));
            $by = (float) ($b['bbox']['y'] ?? ($b['labelBox']['y'] ?? 0));
            return $ay <=> $by ?: ((float) ($a['bbox']['x'] ?? 0) <=> (float) ($b['bbox']['x'] ?? 0));
        });
        // Rows: fields whose boxes overlap vertically sit side by side (a tall textarea does not drag its neighbours into its row).
        $rows = [];
        foreach ($nodes as $field) {
            $top = (float) ($field['bbox']['y'] ?? 0);
            $height = (float) ($field['bbox']['height'] ?? 0);
            $placed = false;
            foreach ($rows as &$row) {
                if (abs($top - $row['top']) <= max(12, $row['height'] * .5)) {
                    $row['fields'][] = $field;
                    $placed = true;
                    break;
                }
            }
            unset($row);
            if (!$placed) $rows[] = ['top' => $top, 'height' => $height, 'fields' => [$field]];
        }
        $out = [];
        foreach ($rows as $row) {
            $count = min(3, count($row['fields']));
            usort($row['fields'], function ($a, $b) { return (float) ($a['bbox']['x'] ?? 0) <=> (float) ($b['bbox']['x'] ?? 0); });
            foreach (array_slice($row['fields'], 0, 3) as $position => $field) {
                $class = $count === 3 ? 'wpforms-one-third' : ($count === 2 ? 'wpforms-one-half' : '');
                if ($class && $position === 0) $class .= ' wpforms-first';
                $out[] = ['node' => $field, 'css' => trim($class)];
            }
        }
        return $out;
    }

    private function wpforms_field_data($id, $entry) {
        $field = $entry['node'];
        $kind = sanitize_key($field['fieldType'] ?? 'text');
        $label = sanitize_text_field(rtrim((string) ($field['label'] ?? ''), " *"));
        $required = !empty($field['required']) || preg_match('/\*\s*$/', (string) ($field['label'] ?? '')) ? '1' : '';
        $data = [
            'id' => (string) $id,
            'label' => $label !== '' ? $label : sanitize_text_field((string) ($field['placeholder'] ?? 'Поле')),
            'required' => $required,
            'size' => 'medium',
            'placeholder' => sanitize_text_field((string) ($field['placeholder'] ?? '')),
            'css' => $entry['css'],
        ];
        switch ($kind) {
            case 'email':
                return $data + ['type' => 'email'];
            case 'textarea':
                return $data + ['type' => 'textarea'];
            case 'phone':
            case 'tel':
                return $data + ['type' => 'phone', 'format' => 'international'];
            case 'number':
                return $data + ['type' => 'number'];
            case 'date':
                return $data + ['type' => 'date-time', 'format' => 'date', 'date_type' => 'datepicker', 'date_format' => 'm/d/Y'];
            case 'select':
                return $data + ['type' => 'select', 'choices' => ['1' => ['label' => '', 'value' => '', 'image' => '', 'icon' => '', 'icon_style' => '']]];
            case 'checkbox':
                return ['id' => (string) $id, 'type' => 'checkbox', 'label' => $data['label'], 'required' => $required, 'size' => 'medium', 'css' => $entry['css'],
                    'choices' => ['1' => ['label' => $data['label'], 'value' => '', 'image' => '', 'icon' => '', 'icon_style' => '']]];
            default:
                return $data + ['type' => 'text'];
        }
    }

    private function wpforms_submit_text($node) {
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        foreach ((array) $children as $child) {
            if (is_array($child) && ($child['type'] ?? '') === 'button') {
                $text = sanitize_text_field((string) ($child['text'] ?? ($child['content'] ?? '')));
                if ($text !== '') return $text;
            }
        }
        return 'Надіслати';
    }

    private function wpforms_save($existing, $node, $entries, $post_id, $index) {
        $fields = [];
        $next = 1;
        foreach ($entries as $entry) {
            $fields[(string) $next] = $this->wpforms_field_data($next, $entry);
            $next++;
        }
        $title = sprintf('%s — форма %d', get_the_title($post_id) ?: 'Page Generator', $index + 1);
        $email_field = '';
        foreach ($fields as $id => $field) {
            if ($field['type'] === 'email') { $email_field = (string) $id; break; }
        }
        $data = [
            'fields' => $fields,
            'field_id' => $next,
            'settings' => [
                'form_title' => $title,
                'form_desc' => '',
                'submit_text' => $this->wpforms_submit_text($node),
                'submit_text_processing' => 'Надсилання...',
                'antispam_v3' => '1',
                'notification_enable' => '1',
                'notifications' => ['1' => [
                    'email' => '{admin_email}',
                    'subject' => $title,
                    'sender_name' => get_bloginfo('name'),
                    'sender_address' => '{admin_email}',
                    'replyto' => $email_field ? '{field_id="' . $email_field . '"}' : '',
                    'message' => '{all_fields}',
                ]],
                'confirmations' => ['1' => ['type' => 'message', 'message' => 'Дякуємо! Заявку надіслано.', 'message_scroll' => '1']],
                'ajax_submit' => '1',
            ],
            'meta' => ['template' => 'blank'],
        ];
        if (!$existing) {
            $existing = wp_insert_post(['post_type' => 'wpforms', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => '{}']);
            if (!$existing || is_wp_error($existing)) return 0;
        }
        $data['id'] = $existing;
        wp_update_post(['ID' => $existing, 'post_title' => $title, 'post_status' => 'publish', 'post_content' => wp_slash(wp_json_encode($data))]);
        return (int) $existing;
    }

    // Colours for the embedded form, taken from the screenshot's own fields and button (applied through CSS variables).
    private function wpforms_style_vars($node) {
        $vars = [];
        $field = $this->wpforms_field_nodes($node)[0] ?? null;
        if ($field) {
            if (!empty($field['style']['background'])) $vars['--pg-field-bg'] = $this->normalize_color($field['style']['background']);
            if (!empty($field['style']['borderRadius'])) $vars['--pg-field-radius'] = absint($field['style']['borderRadius']) . 'px';
        }
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        foreach ((array) $children as $child) {
            if (is_array($child) && ($child['type'] ?? '') === 'button') {
                if (!empty($child['style']['background'])) $vars['--pg-btn-bg'] = $this->normalize_color($child['style']['background']);
                if (!empty($child['style']['color'])) $vars['--pg-btn-color'] = $this->normalize_color($child['style']['color']);
                if (!empty($child['style']['borderRadius'])) $vars['--pg-btn-radius'] = absint($child['style']['borderRadius']) . 'px';
                break;
            }
        }
        return $vars;
    }

    // The markup both exporters embed: a styled wrapper around the shortcode.
    private function wpforms_embed_html($node) {
        $style = '';
        foreach ($this->wpforms_style_vars($node) as $name => $value) {
            $style .= $name . ':' . $value . ';';
        }
        return '<div class="pg-wpforms"' . ($style !== '' ? ' style="' . esc_attr($style) . '"' : '') . '>[wpforms id="' . absint($node['wpformsId']) . '"]</div>';
    }

    private function wpforms_node_active($node) {
        return $this->wpforms_enabled && !empty($node['wpformsId']) && get_post_type(absint($node['wpformsId'])) === 'wpforms';
    }
}
