<?php
/**
 * Plugin Name: Page Generator
 * Description: Deterministic page importer for Figma and screenshots with Elementor and WordPress output.
 * Version: 3.3.9
 * Author: Dym
 */

defined('ABSPATH') || exit;

final class Page_Generator_Plugin {
    const VERSION = '3.3.9';
    const OPTION = 'page_generator_settings';
    const NONCE = 'page_generator_nonce';

    public function __construct() {
        add_action('admin_menu', [$this, 'register_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('elementor/editor/after_enqueue_scripts', [$this, 'enqueue_editor_assets']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin_assets']);
        add_action('enqueue_block_editor_assets', [$this, 'enqueue_block_editor_assets']);

        add_action('wp_ajax_page_generator_scan_figma', [$this, 'scan_figma']);
        add_action('wp_ajax_page_generator_import_figma', [$this, 'import_figma']);
        add_action('wp_ajax_page_generator_create_page', [$this, 'create_page']);
        add_action('wp_ajax_page_generator_compare_page', [$this, 'compare_page']);
        add_action('wp_ajax_page_generator_upload_asset', [$this, 'upload_asset']);
        add_action('init', [$this, 'register_component_block']);
        add_action('wp_ajax_page_generator_save_settings', [$this, 'save_settings_ajax']);
    }

    public function register_component_block() {
        register_block_type('page-generator/component', [
            'api_version' => 2,
            'attributes' => [
                'node' => ['type' => 'object'],
                'dimensions' => ['type' => 'object'],
                'rootSection' => ['type' => 'boolean', 'default' => false],
            ],
            'render_callback' => function ($attributes, $content) {
                $node = isset($attributes['node']) && is_array($attributes['node']) ? $attributes['node'] : [];
                $dimensions = isset($attributes['dimensions']) && is_array($attributes['dimensions']) ? $attributes['dimensions'] : null;
                return $this->render_node($node, $dimensions, !empty($attributes['rootSection']), $content);
            },
        ]);
    }

    public function register_settings_page() {
        add_options_page(
            'Page Generator',
            'Page Generator',
            'manage_options',
            'page-generator',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings() {
        register_setting('page_generator', self::OPTION, [
            'type' => 'array',
            'sanitize_callback' => [$this, 'sanitize_settings'],
            'default' => $this->defaults(),
        ]);
    }

    private function defaults() {
        return [
            'figma_token' => '',
            'figma_token_created_at' => 0,
            'figma_token_expires_at' => 0,
            'figma_token_total_days' => 90,
            'ocr_languages' => 'ukr+eng',
            'max_upload_size_mb' => 20,
            'default_container_width' => 1200,
            'output_mode' => 'draft',
            'keep_import_json' => 1,
        ];
    }

    private function settings() {
        return wp_parse_args((array) get_option(self::OPTION, []), $this->defaults());
    }

    public function save_settings_ajax() {
        $this->verify_request();
        $input = [
            'figma_token' => sanitize_text_field(wp_unslash($_POST['figmaToken'] ?? '')),
            'figma_token_total_days' => absint($_POST['figmaTokenTotalDays'] ?? 90),
            'ocr_languages' => sanitize_text_field(wp_unslash($_POST['ocrLanguages'] ?? 'ukr+eng')),
            'default_container_width' => absint($_POST['defaultContainerWidth'] ?? 1200),
        ];
        $saved = $this->sanitize_settings($input);
        update_option(self::OPTION, $saved);
        wp_send_json_success([
            'tokenConfigured' => !empty($saved['figma_token']),
            'tokenExpiresAt' => $saved['figma_token_expires_at'] ? wp_date('Y-m-d H:i', $saved['figma_token_expires_at']) : '',
        ]);
    }

    public function sanitize_settings($input) {
        $current = $this->settings();
        $input = is_array($input) ? $input : [];
        $settings = $this->defaults();
        $settings['figma_token'] = isset($input['figma_token']) && $input['figma_token'] !== ''
            ? sanitize_text_field($input['figma_token'])
            : $current['figma_token'];
        $settings['figma_token_created_at'] = absint($current['figma_token_created_at']);
        $settings['figma_token_expires_at'] = absint($current['figma_token_expires_at']);
        $settings['figma_token_total_days'] = max(1, min(3650, absint($input['figma_token_total_days'] ?? 90)));
        $settings['ocr_languages'] = sanitize_text_field($input['ocr_languages'] ?? 'ukr+eng');
        $settings['max_upload_size_mb'] = max(1, min(100, absint($input['max_upload_size_mb'] ?? 20)));
        $settings['default_container_width'] = max(320, min(2400, absint($input['default_container_width'] ?? 1200)));
        $settings['output_mode'] = in_array(($input['output_mode'] ?? 'draft'), ['draft', 'publish'], true)
            ? $input['output_mode']
            : 'draft';
        $settings['keep_import_json'] = empty($input['keep_import_json']) ? 0 : 1;

        if ($settings['figma_token'] !== $current['figma_token']) {
            $settings['figma_token_created_at'] = time();
            $settings['figma_token_expires_at'] = time() + ($settings['figma_token_total_days'] * DAY_IN_SECONDS);
        }

        return $settings;
    }

    public function render_settings_page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        $settings = $this->settings();
        $expiry = $settings['figma_token_expires_at'] ? wp_date('Y-m-d H:i', $settings['figma_token_expires_at']) : '—';
        ?>
        <div class="wrap">
            <h1>Page Generator</h1>
            <p>Налаштування імпорту Figma, скріншотів і створення сторінок.</p>
            <form method="post" action="options.php">
                <?php settings_fields('page_generator'); ?>
                <h2 class="nav-tab-wrapper">
                    <a class="nav-tab nav-tab-active" href="#pg-general">Загальні</a>
                    <a class="nav-tab" href="#pg-figma">Figma</a>
                    <a class="nav-tab" href="#pg-images">Скріншоти</a>
                </h2>
                <div id="pg-general" class="pg-settings-tab">
                    <table class="form-table">
                        <tr><th>Режим створення</th><td><select name="<?php echo esc_attr(self::OPTION); ?>[output_mode]">
                            <option value="draft" <?php selected($settings['output_mode'], 'draft'); ?>>Чернетка</option>
                            <option value="publish" <?php selected($settings['output_mode'], 'publish'); ?>>Опубліковано</option>
                        </select></td></tr>
                        <tr><th>Ширина контейнера</th><td><input type="number" min="320" max="2400" name="<?php echo esc_attr(self::OPTION); ?>[default_container_width]" value="<?php echo esc_attr($settings['default_container_width']); ?>"> px</td></tr>
                        <tr><th>Зберігати JSON імпорту</th><td><label><input type="checkbox" name="<?php echo esc_attr(self::OPTION); ?>[keep_import_json]" value="1" <?php checked($settings['keep_import_json'], 1); ?>> Так</label></td></tr>
                    </table>
                </div>
                <div id="pg-figma" class="pg-settings-tab" style="display:none">
                    <table class="form-table">
                        <tr><th>Personal Access Token</th><td><input type="password" class="regular-text" name="<?php echo esc_attr(self::OPTION); ?>[figma_token]" value="<?php echo esc_attr($settings['figma_token']); ?>" autocomplete="off"><p class="description">Токен зберігається на сервері й не передається у браузер.</p></td></tr>
                        <tr><th>Термін токена</th><td><input type="number" min="1" max="3650" name="<?php echo esc_attr(self::OPTION); ?>[figma_token_total_days]" value="<?php echo esc_attr($settings['figma_token_total_days']); ?>"> днів</td></tr>
                        <tr><th>Розрахована дата завершення</th><td><?php echo esc_html($expiry); ?></td></tr>
                    </table>
                </div>
                <div id="pg-images" class="pg-settings-tab" style="display:none">
                    <table class="form-table">
                        <tr><th>Мови OCR</th><td><input type="text" class="regular-text" name="<?php echo esc_attr(self::OPTION); ?>[ocr_languages]" value="<?php echo esc_attr($settings['ocr_languages']); ?>"><p class="description">Наприклад: ukr+eng.</p></td></tr>
                        <tr><th>Максимальний розмір файлу</th><td><input type="number" min="1" max="100" name="<?php echo esc_attr(self::OPTION); ?>[max_upload_size_mb]" value="<?php echo esc_attr($settings['max_upload_size_mb']); ?>"> MB</td></tr>
                    </table>
                </div>
                <?php submit_button('Зберегти налаштування'); ?>
            </form>
        </div>
        <?php
    }

    public function enqueue_admin_assets($hook) {
        if ($hook !== 'settings_page_page-generator') {
            return;
        }
        wp_enqueue_style('page-generator-admin', plugins_url('assets/admin.css', __FILE__), [], self::VERSION);
        wp_enqueue_script('page-generator-admin', plugins_url('assets/admin.js', __FILE__), ['jquery'], self::VERSION, true);
    }

    public function enqueue_editor_assets() {
        $this->enqueue_generator_assets('page-generator-editor');
    }

    public function enqueue_block_editor_assets() {
        $this->enqueue_generator_assets('page-generator-gutenberg-editor');
    }

    private function enqueue_generator_assets($handle) {
        $settings = $this->settings();
        wp_enqueue_style($handle, plugins_url('assets/editor.css', __FILE__), [], self::VERSION);
        wp_enqueue_script($handle, plugins_url('assets/editor.js', __FILE__), ['jquery'], self::VERSION, true);
        wp_localize_script($handle, 'PageGeneratorConfig', [
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce(self::NONCE),
            'build' => self::VERSION,
            'currentPostId' => $this->get_current_editor_post_id(),
            'ocrLanguages' => $settings['ocr_languages'],
            'containerWidth' => $settings['default_container_width'],
            'tokenConfigured' => !empty($settings['figma_token']),
            'tokenExpiresAt' => $settings['figma_token_expires_at'] ? wp_date('Y-m-d H:i', $settings['figma_token_expires_at']) : '',
            'tokenTotalDays' => $settings['figma_token_total_days'],
        ]);
    }

    private function get_current_editor_post_id() {
        if (!empty($_GET['post'])) {
            return absint($_GET['post']);
        }
        if (!empty($_POST['post'])) {
            return absint($_POST['post']);
        }
        return 0;
    }

    private function verify_request() {
        check_ajax_referer(self::NONCE, 'nonce');
        if (!current_user_can('edit_pages')) {
            wp_send_json_error('Недостатньо прав.', 403);
        }
    }

    public function scan_figma() {
        $this->verify_request();
        $url = esc_url_raw(wp_unslash($_POST['url'] ?? ''));
        $file_key = $this->extract_file_key($url);
        if (!$file_key) {
            wp_send_json_error('Невірне посилання на Figma.');
        }
        $response = $this->figma_request("/files/{$file_key}?depth=2");
        if (is_wp_error($response)) {
            wp_send_json_error($response->get_error_message());
        }
        $frames = [];
        foreach (($response['document']['children'] ?? []) as $page) {
            foreach (($page['children'] ?? []) as $child) {
                if (in_array($child['type'] ?? '', ['FRAME', 'SECTION', 'COMPONENT'], true)) {
                    $frames[] = ['id' => $child['id'], 'name' => $child['name'], 'page_name' => $page['name']];
                }
            }
        }
        wp_send_json_success(['fileKey' => $file_key, 'frames' => $frames]);
    }

    public function import_figma() {
        $this->verify_request();
        $file_key = sanitize_text_field(wp_unslash($_POST['fileKey'] ?? ''));
        $node_ids = sanitize_text_field(wp_unslash($_POST['nodeIds'] ?? ''));
        if (!$file_key || !$node_ids || !preg_match('/^[a-zA-Z0-9:_,-]+$/', $file_key . ':' . $node_ids)) {
            wp_send_json_error('Некоректні параметри імпорту.');
        }
        $response = $this->figma_request('/files/' . rawurlencode($file_key) . '/nodes?ids=' . implode(',', array_map('rawurlencode', array_map('trim', explode(',', $node_ids)))));
        if (is_wp_error($response)) {
            wp_send_json_error($response->get_error_message());
        }
        $sections = [];
        foreach (($response['nodes'] ?? []) as $node) {
            if (!empty($node['document'])) {
                $parsed = $this->translate_node($node['document'], false);
                if ($parsed) {
                    $sections[] = $parsed;
                }
            }
        }
        wp_send_json_success(['page' => $this->build_page_schema($sections)]);
    }

    private function figma_request($path) {
        $token = $this->settings()['figma_token'];
        if (!$token) {
            return new WP_Error('missing_token', 'Figma token не налаштований.');
        }
        $settings = $this->settings();
        if ($settings['figma_token_expires_at'] && time() >= $settings['figma_token_expires_at']) {
            return new WP_Error('expired_token', 'Термін Figma token завершився.');
        }
        $response = wp_remote_get('https://api.figma.com/v1' . $path, [
            'headers' => ['X-Figma-Token' => $token],
            'timeout' => 45,
        ]);
        if (is_wp_error($response)) {
            return $response;
        }
        $code = wp_remote_retrieve_response_code($response);
        $body = json_decode(wp_remote_retrieve_body($response), true);
        if ($code !== 200) {
            return new WP_Error('figma_api', $body['err'] ?? ('Figma API HTTP ' . $code));
        }
        return is_array($body) ? $body : new WP_Error('figma_json', 'Figma повернула некоректний JSON.');
    }

    private function extract_file_key($url) {
        return preg_match('~(?:file|design|make)/([a-zA-Z0-9]+)~', $url, $matches) ? $matches[1] : '';
    }

    private function build_page_schema($sections) {
        return [
            'version' => 1,
            'title' => 'Imported page',
            'containerWidth' => $this->settings()['default_container_width'],
            'tokens' => ['colors' => [], 'typography' => []],
            'sections' => array_values($sections),
        ];
    }

    private function translate_node($node, $is_inner = true) {
        if (($node['visible'] ?? true) === false) {
            return null;
        }
        $type = $node['type'] ?? '';
        $id = substr(md5(uniqid('', true)), 0, 7);
        if (in_array($type, ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP'], true)) {
            $settings = [
                'direction' => (($node['layoutMode'] ?? '') === 'HORIZONTAL') ? 'row' : 'column',
                'width' => '100%',
                'gap' => absint($node['itemSpacing'] ?? 0),
                'padding' => [
                    'top' => absint($node['paddingTop'] ?? 0),
                    'right' => absint($node['paddingRight'] ?? 0),
                    'bottom' => absint($node['paddingBottom'] ?? 0),
                    'left' => absint($node['paddingLeft'] ?? 0),
                ],
            ];
            $elements = [];
            foreach (($node['children'] ?? []) as $child) {
                $parsed = $this->translate_node($child, true);
                if ($parsed) {
                    $elements[] = $parsed;
                }
            }
            return ['id' => $id, 'type' => 'container', 'inner' => $is_inner, 'settings' => $settings, 'elements' => $elements];
        }
        if ($type === 'TEXT' && trim($node['characters'] ?? '') !== '') {
            $text = trim($node['characters']);
            return [
                'id' => $id,
                'type' => strlen($text) < 48 ? 'heading' : 'text',
                'content' => $text,
                'settings' => ['fontSize' => absint($node['style']['fontSize'] ?? 16), 'fontWeight' => absint($node['style']['fontWeight'] ?? 400)],
                'elements' => [],
            ];
        }
        return null;
    }

    public function create_page() {
        $this->verify_request();
        $post_id = absint($_POST['postId'] ?? 0);
        if (!$post_id || !current_user_can('edit_post', $post_id)) {
            wp_send_json_error('Не знайдено поточну сторінку або немає права її редагувати.');
        }

        $raw_schema = isset($_POST['schema']) ? wp_unslash($_POST['schema']) : '';
        $schema = json_decode($raw_schema, true);
        if (!is_array($schema) || empty($schema['sections'])) {
            wp_send_json_error('Схема сторінки порожня або пошкоджена. Отримано: ' . json_last_error_msg());
        }
        $validation_errors = $this->validate_schema($schema);
        if ($validation_errors) {
            wp_send_json_error('Схема не пройшла перевірку: ' . implode(' ', $validation_errors));
        }
        $raw_title = isset($_POST['title']) ? sanitize_text_field(wp_unslash($_POST['title'])) : '';
        $post_before_update = get_post($post_id);
        $title = $post_before_update ? $post_before_update->post_title : '';
        if (in_array(trim($title), ['Imported screenshot page', 'Imported page'], true)) {
            $title = '';
        }
        if ($raw_title && $raw_title !== 'Imported screenshot page') {
            $title = $raw_title;
        }
        $requested_editor_mode = sanitize_key(wp_unslash($_POST['editorMode'] ?? ''));
        $elementor_mode = $requested_editor_mode === 'elementor'
            ? true
            : ($requested_editor_mode === 'gutenberg' ? false : $this->is_elementor_page($post_id));
        $rendered_html = $this->render_html($schema);
        $block_content = $this->render_block_content($schema);
        $updated = wp_update_post([
            'ID' => $post_id,
            'post_title' => $title,
            'post_content' => $elementor_mode ? $block_content : $block_content,
        ], true);
        if (is_wp_error($updated)) {
            wp_send_json_error($updated->get_error_message());
        }
        if (!$updated) {
            wp_send_json_error('WordPress не оновив поточну сторінку.');
        }
        $post = get_post($post_id);
        if (!$post) {
            wp_send_json_error('Оновлену сторінку не знайдено.');
        }
        if ($this->settings()['keep_import_json']) {
            update_post_meta($post_id, '_page_generator_schema', wp_json_encode($schema));
        }
        if ($elementor_mode) {
            $elementor_data = $this->serialize_elementor_schema($schema);
            update_post_meta($post_id, '_elementor_data', wp_slash(wp_json_encode($elementor_data)));
            delete_post_meta($post_id, '_elementor_css');
        } else {
            delete_post_meta($post_id, '_elementor_data');
            delete_post_meta($post_id, '_elementor_css');
            delete_post_meta($post_id, '_elementor_edit_mode');
        }
        update_post_meta($post_id, '_page_generator_output_mode', $elementor_mode ? 'elementor-native-tree' : 'gutenberg-component-blocks');
        update_post_meta($post_id, '_page_generator_render_length', strlen($rendered_html));
        update_post_meta($post_id, '_page_generator_render_hash', md5($rendered_html));
        wp_send_json_success([
            'mode' => 'update-current-page',
            'build' => self::VERSION,
            'id' => $post_id,
            'status' => $post->post_status,
            'url' => get_edit_post_link($post_id, ''),
            'viewUrl' => get_permalink($post_id),
            'compareUrl' => $post->post_status === 'publish' ? get_permalink($post_id) : get_preview_post_link($post_id),
            'renderLength' => strlen($rendered_html),
            'renderHash' => md5($rendered_html),
            'elementorMode' => $elementor_mode,
            'outputMode' => $elementor_mode ? 'elementor-native-tree' : 'gutenberg-core-blocks',
            'blockCount' => substr_count($block_content, '<!-- wp:'),
            'contentHash' => md5($block_content),
        ]);
    }

    public function compare_page() {
        $this->verify_request();
        if (!current_user_can('edit_post', absint($_POST['postId'] ?? 0))) {
            wp_send_json_error('Немає права порівнювати цю сторінку.');
        }
        $url = esc_url_raw(wp_unslash($_POST['url'] ?? ''));
        $source_url = esc_url_raw(wp_unslash($_POST['sourceUrl'] ?? ''));
        $source_attachment_id = absint($_POST['sourceAttachmentId'] ?? 0);
        $schema = json_decode(wp_unslash($_POST['schema'] ?? ''), true);
        $width = absint($_POST['width'] ?? 0);
        $height = absint($_POST['height'] ?? 0);
        if (!$url || (!$source_url && !$source_attachment_id) || !$width || !$height || !is_array($schema)) {
            wp_send_json_error('Недостатньо даних для screenshot-порівняння: URL=' . ($url ? 'так' : 'ні') . ', reference=' . (($source_url || $source_attachment_id) ? 'так' : 'ні') . ', розмір=' . ($width && $height ? $width . 'x' . $height : 'відсутній') . '.');
        }
        $runner = __DIR__ . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'screenshot-runner.js';
        $node = defined('PAGE_GENERATOR_NODE_PATH') ? PAGE_GENERATOR_NODE_PATH : 'node';
        if (!file_exists($runner) || !function_exists('shell_exec')) {
            wp_send_json_error('Локальний Playwright runner недоступний. Перевірте Node.js та tools/screenshot-runner.js.');
        }
        $source_file = wp_tempnam('page-generator-source');
        $schema_file = wp_tempnam('page-generator-schema');
        $diff_file = wp_tempnam('page-generator-diff');
        $rendered_file = wp_tempnam('page-generator-rendered');
        $source_path = $source_attachment_id ? get_attached_file($source_attachment_id) : '';
        if (!$source_path || !is_readable($source_path)) {
            $source_response = wp_remote_get($source_url, ['timeout' => 30]);
            if (is_wp_error($source_response) || wp_remote_retrieve_response_code($source_response) >= 400) {
                wp_send_json_error('Не вдалося завантажити reference screenshot ні з attachment, ні за URL.');
            }
            $source_bytes = wp_remote_retrieve_body($source_response);
        } else {
            $source_bytes = file_get_contents($source_path);
        }
        if (!$source_file || !$schema_file || !$diff_file || !$rendered_file || $source_bytes === false || file_put_contents($source_file, $source_bytes) === false || file_put_contents($schema_file, wp_json_encode($schema)) === false) {
            wp_send_json_error('Не вдалося підготувати файли для Playwright.');
        }
        $command = escapeshellarg($node) . ' ' . escapeshellarg($runner)
            . ' --url ' . escapeshellarg($url)
            . ' --source ' . escapeshellarg($source_file)
            . ' --schema ' . escapeshellarg($schema_file)
            . ' --diff ' . escapeshellarg($diff_file)
            . ' --rendered ' . escapeshellarg($rendered_file)
            . ' --width ' . absint($width)
            . ' --height ' . absint($height)
            . ' 2>&1';
        $output = shell_exec($command);
        @unlink($source_file);
        @unlink($schema_file);
        $result = json_decode(trim((string) $output), true);
        if (!is_array($result) || empty($result['success'])) {
            @unlink($diff_file);
            @unlink($rendered_file);
            wp_send_json_error('Playwright не повернув коректний результат: ' . sanitize_text_field((string) $output));
        }
        if (is_readable($diff_file)) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
            $diff_bytes = file_get_contents($diff_file);
            $upload = wp_upload_bits('page-generator-diff-' . time() . '.png', null, $diff_bytes);
            if (empty($upload['error'])) {
                $result['diffUrl'] = $upload['url'];
            }
        }
        if (is_readable($rendered_file)) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
            $rendered_bytes = file_get_contents($rendered_file);
            $upload = wp_upload_bits('page-generator-rendered-' . time() . '.png', null, $rendered_bytes);
            if (empty($upload['error'])) {
                $result['renderedUrl'] = $upload['url'];
            }
        }
        @unlink($diff_file);
        @unlink($rendered_file);
        wp_send_json_success($result);
    }

    private function render_html($schema) {
        $first_section = !empty($schema['sections'][0]) && is_array($schema['sections'][0]) ? $schema['sections'][0] : [];
        $width = absint($first_section['settings']['sourceWidth'] ?? 0);
        $height = absint($first_section['settings']['sourceHeight'] ?? 0);
        $canvas_style = 'position:relative;width:100%;max-width:' . absint($this->settings()['default_container_width']) . 'px;margin:0 auto;font-family:Arial,sans-serif;color:#334155;';
        if ($width && $height) {
            $canvas_style .= 'aspect-ratio:' . $width . '/' . $height . ';overflow:hidden;';
        }
        $html = '<div class="page-generator-canvas" data-page-generator="canvas" style="' . esc_attr($canvas_style) . '">' . "\n";
        foreach ($schema['sections'] as $section) {
            $section_type = esc_html($section['type'] ?? 'section');
            $html .= "\n<!-- page-generator:block " . $section_type . " -->\n";
            $html .= $this->render_node($section, $width && $height ? ['width' => $width, 'height' => $height] : null, true) . "\n";
            $html .= "<!-- /page-generator:block " . $section_type . " -->\n";
        }
        return $html . '</div>';
    }

    private function render_block_content($schema) {
        $first_section = !empty($schema['sections'][0]) && is_array($schema['sections'][0]) ? $schema['sections'][0] : [];
        $width = absint($first_section['settings']['sourceWidth'] ?? 0);
        $height = absint($first_section['settings']['sourceHeight'] ?? 0);
        $dimensions = $width && $height ? ['width' => $width, 'height' => $height] : null;
        $content = '';
        foreach (($schema['sections'] ?? []) as $section) {
            $content .= $this->serialize_gutenberg_node($section, $dimensions, true);
        }
        return $content;
    }

    private function serialize_gutenberg_node($node, $dimensions = null, $root_section = false) {
        $type = sanitize_key($node['type'] ?? 'section');
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        $inner = '';
        foreach ($children as $child) {
            $inner .= $this->serialize_gutenberg_node($child, $dimensions, false);
        }

        if ($type === 'heading') {
            $text = esc_html($node['text'] ?? ($node['content'] ?? ''));
            return '<!-- wp:heading -->' . "\n" . '<h2>' . $text . '</h2>' . "\n<!-- /wp:heading -->\n";
        }
        if ($type === 'text' || $type === 'link' || $type === 'logo' || $type === 'badge') {
            $text = esc_html($node['text'] ?? ($node['content'] ?? ''));
            return '<!-- wp:paragraph -->' . "\n" . '<p>' . $text . '</p>' . "\n<!-- /wp:paragraph -->\n";
        }
        if ($type === 'button') {
            $label = sanitize_text_field($node['text'] ?? ($node['content'] ?? 'Кнопка'));
            $url = esc_url_raw($node['behavior']['url'] ?? '#') ?: '#';
            $style = is_array($node['style'] ?? null) ? $node['style'] : [];
            $background = $this->normalize_color($style['background'] ?? ($node['background'] ?? ''));
            $color = $this->normalize_color($style['color'] ?? ($node['color'] ?? ''));
            $attributes = ['url' => $url, 'text' => $label];
            $inline_style = '';
            if (!empty($style['background']) || !empty($node['background'])) {
                $attributes['style'] = ['color' => ['background' => $background]];
                $inline_style .= 'background-color:' . esc_attr($background) . ';';
            }
            if (!empty($style['color']) || !empty($node['color'])) {
                $attributes['style']['color']['text'] = $color;
                $inline_style .= 'color:' . esc_attr($color) . ';';
            }
            return '<!-- wp:button ' . wp_json_encode($attributes, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' -->' . "\n"
                . '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="' . esc_url($url) . '"' . ($inline_style ? ' style="' . $inline_style . '"' : '') . '>' . esc_html($label) . '</a></div>' . "\n"
                . '<!-- /wp:button -->' . "\n";
        }
        if ($type === 'image') {
            $asset = is_array($node['asset'] ?? null) ? $node['asset'] : [];
            $url = esc_url($node['url'] ?? ($asset['url'] ?? ''));
            $id = absint($node['attachmentId'] ?? ($asset['id'] ?? 0));
            if (!$url) {
                return '<!-- wp:group -->' . "\n"
                    . '<div class="wp-block-group page-generator-image-placeholder" aria-label="Detected image"></div>' . "\n"
                    . '<!-- /wp:group -->' . "\n";
            }
            $attributes = ['url' => $url, 'alt' => sanitize_text_field($node['alt'] ?? '')];
            if ($id) {
                $attributes['id'] = $id;
            }
            return '<!-- wp:image ' . wp_json_encode($attributes, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' -->' . "\n"
                . '<figure class="wp-block-image"><img src="' . $url . '" alt="' . esc_attr($attributes['alt']) . '"' . ($id ? ' class="wp-image-' . $id . '"' : '') . '/></figure>' . "\n"
                . '<!-- /wp:image -->' . "\n";
        }
        if ($type === 'form' || $type === 'form-field' || $type === 'table') {
            $html = $this->render_node($node, $dimensions);
            return '<!-- wp:html -->' . "\n" . $html . "\n<!-- /wp:html -->\n";
        }
        if (!$inner && in_array($type, ['section', 'header', 'footer', 'card', 'grid', 'gallery', 'navigation'], true)) {
            $inner = '<p></p>';
        }
        if (!$inner) {
            return '';
        }
        return '<!-- wp:group -->' . "\n" . '<div class="wp-block-group">' . "\n" . $inner . '</div>' . "\n<!-- /wp:group -->\n";
    }

    private function is_elementor_page($post_id) {
        $data = get_post_meta($post_id, '_elementor_data', true);
        $edit_mode = get_post_meta($post_id, '_elementor_edit_mode', true);
        if ($edit_mode === 'builder') {
            return true;
        }
        if (is_string($data)) {
            $data = json_decode($data, true);
        }
        return is_array($data) && !empty($data);
    }

    private function validate_schema($schema) {
        $errors = [];
        $node_count = 0;
        $visit = function ($nodes, $parent_box = null) use (&$visit, &$errors, &$node_count) {
            foreach ((array) $nodes as $node) {
                if (!is_array($node)) {
                    $errors[] = 'Знайдено пошкоджений вузол.';
                    continue;
                }
                $node_count++;
                $type = sanitize_key($node['type'] ?? '');
                if (!$type) {
                    $errors[] = 'Вузол без type.';
                }
                if (!empty($node['bbox']) && is_array($node['bbox'])) {
                    $bbox = $node['bbox'];
                    foreach (['x', 'y', 'width', 'height'] as $key) {
                        if (isset($bbox[$key]) && !is_numeric($bbox[$key])) {
                            $errors[] = 'Некоректний bbox у вузлі ' . $type . '.';
                            break;
                        }
                    }
                    if (isset($bbox['width'], $bbox['height']) && ((float) $bbox['width'] < 0 || (float) $bbox['height'] < 0)) {
                        $errors[] = 'Від’ємний розмір bbox у вузлі ' . $type . '.';
                    }
                }
                $colors = [];
                foreach (['background', 'color'] as $color_key) {
                    if (isset($node[$color_key])) $colors[] = $node[$color_key];
                }
                if (isset($node['style']) && is_array($node['style'])) {
                    foreach (['background', 'color'] as $color_key) {
                        if (isset($node['style'][$color_key])) $colors[] = $node['style'][$color_key];
                    }
                }
                foreach ($colors as $color_value) {
                    if (!preg_match('/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i', (string) $color_value)) {
                        $errors[] = 'Некоректний колір у вузлі ' . $type . '.';
                        break;
                    }
                }
                $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
                $visit($children, $node['bbox'] ?? $parent_box);
            }
        };
        $visit($schema['sections'] ?? []);
        if ($node_count === 0) $errors[] = 'Схема не містить вузлів.';
        return array_values(array_unique($errors));
    }

    private function serialize_elementor_schema($schema) {
        $models = [];
        foreach (($schema['sections'] ?? []) as $section) {
            $models[] = $this->serialize_elementor_node($section, true);
        }
        return $models;
    }

    private function serialize_elementor_node($node, $root = false) {
        $type = sanitize_key($node['type'] ?? 'section');
        $settings = is_array($node['settings'] ?? null) ? $node['settings'] : [];
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        $id = sanitize_key($node['id'] ?? '') ?: substr(md5(wp_json_encode($node)), 0, 7);
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $text_color = $this->normalize_color($style['color'] ?? ($node['color'] ?? ''));
        $background_color = $this->normalize_color($style['background'] ?? ($node['background'] ?? ''));

        if ($type === 'heading') {
            $widget_settings = ['title' => wp_kses_post($node['text'] ?? ($node['content'] ?? ''))];
            if ($text_color !== '#ffffff' || !empty($style['color']) || !empty($node['color'])) {
                $widget_settings['title_color'] = $text_color;
            }
            if (!empty($style['fontSize']) || !empty($settings['fontSize'])) {
                $widget_settings['__dynamic__'] = [];
                $widget_settings['typography_typography'] = 'custom';
                $widget_settings['typography_font_size'] = [
                    'unit' => 'px',
                    'size' => max(10, absint($style['fontSize'] ?? ($settings['fontSize'] ?? 16))),
                ];
            }
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => $widget_settings, 'elements' => []];
        }
        if ($type === 'text') {
            $widget_settings = ['editor' => wp_kses_post(nl2br($node['text'] ?? ($node['content'] ?? '')))];
            if ($text_color !== '#ffffff' || !empty($style['color']) || !empty($node['color'])) {
                $widget_settings['text_color'] = $text_color;
            }
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => $widget_settings, 'elements' => []];
        }
        if ($type === 'button') {
            $widget_settings = [
                'text' => sanitize_text_field($node['text'] ?? ($node['content'] ?? 'Кнопка')),
                'link' => ['url' => esc_url_raw($node['behavior']['url'] ?? '#')],
            ];
            if ($text_color !== '#ffffff' || !empty($style['color']) || !empty($node['color'])) {
                $widget_settings['button_text_color'] = $text_color;
            }
            if ($background_color !== '#ffffff' || !empty($style['background']) || !empty($node['background'])) {
                $widget_settings['background_color'] = $background_color;
            }
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'button', 'settings' => $widget_settings, 'elements' => []];
        }
        if ($type === 'image') {
            $asset = is_array($node['asset'] ?? null) ? $node['asset'] : [];
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'image', 'settings' => ['image' => ['url' => esc_url_raw($node['url'] ?? ($asset['url'] ?? '')), 'id' => absint($node['attachmentId'] ?? ($asset['id'] ?? 0))]], 'elements' => []];
        }
        if ($type === 'icon') {
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'icon', 'settings' => [], 'elements' => []];
        }
        if ($type === 'form' || $type === 'form-field' || $type === 'table') {
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'html', 'settings' => ['html' => $this->render_node($node)], 'elements' => []];
        }
        $elementor_settings = [
            'flex_direction' => (($settings['direction'] ?? '') === 'row' ? 'row' : 'column'),
            'content_width' => 'full',
            'gap' => ['unit' => 'px', 'size' => absint($settings['gap'] ?? 0)],
        ];
        if (!empty($style['background'])) {
            $elementor_settings['background_background'] = 'classic';
            $elementor_settings['background_color'] = $this->normalize_color($style['background']);
        } elseif (!empty($node['background'])) {
            $elementor_settings['background_background'] = 'classic';
            $elementor_settings['background_color'] = $this->normalize_color($node['background']);
        }
        return ['id' => $id, 'elType' => 'container', 'isInner' => !$root, 'settings' => $elementor_settings, 'elements' => array_map(function ($child) {
            return $this->serialize_elementor_node($child);
        }, $children)];
    }

    private function serialize_component_block($node, $dimensions = null, $root_section = false) {
        if (($node['type'] ?? '') === 'button') {
            $label = sanitize_text_field($node['text'] ?? ($node['content'] ?? 'Кнопка'));
            $url = esc_url_raw($node['behavior']['url'] ?? '#');
            $attributes = [
                'url' => $url ?: '#',
                'text' => $label,
            ];
            $style = is_array($node['style'] ?? null) ? $node['style'] : [];
            $background = $this->normalize_color($style['background'] ?? ($node['background'] ?? ''));
            $color = $this->normalize_color($style['color'] ?? ($node['color'] ?? ''));
            $link_style = '';
            if ($background !== '#ffffff' || !empty($style['background']) || !empty($node['background'])) {
                $attributes['style'] = ['color' => ['background' => $background]];
                $link_style .= 'background-color:' . esc_attr($background) . ';';
            }
            if ($color !== '#ffffff' || !empty($style['color']) || !empty($node['color'])) {
                $attributes['style']['color']['text'] = $color;
                $link_style .= 'color:' . esc_attr($color) . ';';
            }
            if (!empty($style['borderRadius'])) {
                $link_style .= 'border-radius:' . absint($style['borderRadius']) . 'px;';
            }
            return '<!-- wp:button ' . wp_json_encode($attributes, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' -->' . "\n"
                . '<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="' . esc_url($url ?: '#') . '"' . ($link_style ? ' style="' . $link_style . '"' : '') . '>' . esc_html($label) . '</a></div>' . "\n"
                . '<!-- /wp:button -->' . "\n";
        }
        $attributes = [
            'node' => $node,
            'dimensions' => $dimensions ?: new stdClass(),
            'rootSection' => (bool) $root_section,
        ];
        $children = '';
        $nodes = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        $child_dimensions = $dimensions;
        if ($child_dimensions && !empty($node['bbox'])) {
            $child_dimensions['offsetX'] = (float) ($dimensions['offsetX'] ?? 0) + (float) ($node['bbox']['x'] ?? 0);
            $child_dimensions['offsetY'] = (float) ($dimensions['offsetY'] ?? 0) + (float) ($node['bbox']['y'] ?? 0);
        }
        foreach ($nodes as $child) {
            $children .= $this->serialize_component_block($child, $child_dimensions, false);
        }
        return '<!-- wp:page-generator/component ' . wp_json_encode($attributes, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' -->' . "\n"
            . $children
            . '<!-- /wp:page-generator/component -->' . "\n";
    }

    private function render_node($node, $dimensions = null, $root_section = false, $inner_html = null) {
        $type = $node['type'] ?? 'container';
        $block_id = sanitize_html_class($node['id'] ?? wp_generate_uuid4());
        $block_attrs = ' data-block-id="' . esc_attr($block_id) . '" data-block-type="' . esc_attr($type) . '"';
        $children_nodes = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        if ($type === 'image') {
            $url = $node['url'] ?? ($node['asset']['url'] ?? '');
            if ($url) {
                return '<div class="page-generator-block page-generator-block-image"' . $block_attrs . '>' . "\n" . '<img src="' . esc_url($url) . '" alt="' . esc_attr($node['alt'] ?? ($node['text'] ?? '')) . '" style="max-width:100%;height:auto;">' . "\n" . '</div>';
            }
            return '<div class="page-generator-block page-generator-block-image"' . $block_attrs . '><div class="page-generator-image-placeholder" aria-label="Detected image"></div></div>';
        }
        if ($type === 'icon') {
            return '<span class="page-generator-block page-generator-icon"' . $block_attrs . ' aria-hidden="true" style="' . esc_attr($this->render_position_style($node, $dimensions)) . '">&#9679;</span>';
        }
        if ($type === 'heading') {
            return '<h2 class="page-generator-block page-generator-block-heading"' . $block_attrs . ' style="' . esc_attr($this->render_position_style($node, $dimensions)) . '">' . esc_html($node['text'] ?? ($node['content'] ?? '')) . '</h2>';
        }
        if ($type === 'text') {
            return '<p class="page-generator-block page-generator-block-text"' . $block_attrs . ' style="' . esc_attr($this->render_position_style($node, $dimensions)) . '">' . nl2br(esc_html($node['text'] ?? ($node['content'] ?? ''))) . '</p>';
        }
        if (in_array($type, ['link', 'navigation', 'logo'], true)) {
            if ($type === 'navigation') {
                $items = '';
                $items = $inner_html !== null ? $inner_html : $items;
                if ($inner_html === null) foreach ($children_nodes as $child) {
                    $items .= "\n" . $this->render_node($child, $dimensions);
                }
                return '<nav class="page-generator-block page-generator-navigation"' . $block_attrs . ' style="display:flex;gap:' . absint($node['style']['gap'] ?? 16) . 'px;">' . "\n" . $items . "\n" . '</nav>';
            }
            $label = $node['text'] ?? ($node['content'] ?? '');
            $tag = $type === 'logo' ? 'strong' : 'a';
            $href = $type === 'logo' ? '' : ' href="' . esc_url($node['behavior']['url'] ?? '#') . '"';
            return '<' . $tag . $href . ' class="page-generator-block page-generator-' . esc_attr($type) . '"' . $block_attrs . ' style="' . esc_attr($this->render_position_style($node, $dimensions)) . '">' . esc_html($label) . '</' . $tag . '>';
        }
        if ($type === 'button') {
            $label = $node['text'] ?? ($node['content'] ?? '');
            return '<button type="button" class="page-generator-block page-generator-button-node"' . $block_attrs . ' style="' . esc_attr($this->render_position_style($node, $dimensions)) . '">' . esc_html($label) . '</button>';
        }
        if ($type === 'badge') {
            $label = $node['text'] ?? ($node['content'] ?? '');
            $badge_style = 'display:inline-block;padding:3px 7px;border-radius:4px;background:#dcfce7;color:#166534;font-size:11px;';
            return '<span class="page-generator-block page-generator-badge"' . $block_attrs . ' style="' . esc_attr($badge_style . $this->render_position_style($node, $dimensions)) . '">' . esc_html($label) . '</span>';
        }
        if ($type === 'form-field') {
            $label = $node['label'] ?? '';
            $field_type = in_array($node['fieldType'] ?? '', ['email', 'phone', 'date', 'text'], true) ? $node['fieldType'] : 'text';
            if (($node['fieldType'] ?? '') === 'select') {
                return '<label class="page-generator-block page-generator-form-field"' . $block_attrs . ' style="display:flex;flex-direction:column;gap:4px;"><span>' . esc_html($label) . '</span><select><option>' . esc_html($label) . '</option></select></label>';
            }
            if (($node['fieldType'] ?? '') === 'textarea') {
                return '<label class="page-generator-block page-generator-form-field"' . $block_attrs . ' style="display:flex;flex-direction:column;gap:4px;"><span>' . esc_html($label) . '</span><textarea placeholder="' . esc_attr($label) . '"></textarea></label>';
            }
            if (($node['fieldType'] ?? '') === 'checkbox') {
                return '<label class="page-generator-block page-generator-form-field"' . $block_attrs . '><input type="checkbox"> ' . esc_html($label) . '</label>';
            }
            return '<label class="page-generator-block page-generator-form-field"' . $block_attrs . ' style="display:flex;flex-direction:column;gap:4px;"><span>' . esc_html($label) . '</span><input type="' . esc_attr($field_type === 'phone' ? 'tel' : $field_type) . '" placeholder="' . esc_attr($label) . '"></label>';
        }
        if ($type === 'form') {
            $fields = '';
            $form_style = 'display:grid;gap:12px;';
            if ($dimensions && !empty($node['bbox'])) {
                $form_style = $this->render_box_position_style($node, $dimensions) . 'display:grid;gap:12px;';
            }
            $field_dimensions = $dimensions;
            if ($dimensions && !empty($node['bbox'])) {
                $field_dimensions['offsetX'] = (float) ($dimensions['offsetX'] ?? 0) + (float) ($node['bbox']['x'] ?? 0);
                $field_dimensions['offsetY'] = (float) ($dimensions['offsetY'] ?? 0) + (float) ($node['bbox']['y'] ?? 0);
            }
            if ($inner_html !== null) {
                $fields = $inner_html;
            } else foreach ($children_nodes as $child) {
                $fields .= "\n" . $this->render_node($child, $field_dimensions);
            }
            return '<form class="page-generator-block page-generator-form"' . $block_attrs . ' style="' . esc_attr($form_style) . '">' . "\n" . $fields . '<button type="submit" class="page-generator-button-node">Надіслати</button>' . "\n" . '</form>';
        }
        if ($type === 'table') {
            $rows = '';
            foreach (($node['rows'] ?? []) as $row_index => $row) {
                $tag = $row_index === 0 ? 'th' : 'td';
                $rows .= '<tr>';
                foreach ($row as $cell) {
                    $rows .= '<' . $tag . '>' . esc_html($cell['text'] ?? ($cell['content'] ?? '')) . '</' . $tag . '>';
                }
                $rows .= '</tr>';
            }
            if (!$rows) {
                foreach ($children_nodes as $child) {
                    $rows .= '<tr><td>' . esc_html($child['text'] ?? ($child['content'] ?? '')) . '</td></tr>';
                }
            }
            return '<table class="page-generator-block page-generator-table"' . $block_attrs . '><tbody>' . $rows . '</tbody></table>';
        }
        if (in_array($type, ['card', 'grid', 'gallery'], true)) {
            $columns = max(1, absint($node['settings']['columns'] ?? count($children_nodes)));
            $style = 'display:grid;grid-template-columns:repeat(' . $columns . ',minmax(0,1fr));gap:' . absint($node['settings']['gap'] ?? 16) . 'px;';
            if ($dimensions && !empty($node['bbox'])) {
                $style = $this->render_box_position_style($node, $dimensions) . 'display:grid;grid-template-columns:repeat(' . $columns . ',minmax(0,1fr));gap:' . absint($node['settings']['gap'] ?? 16) . 'px;';
            }
            $children = '';
            $child_dimensions = $dimensions;
            if ($dimensions && !empty($node['bbox'])) {
                $child_dimensions['offsetX'] = (float) ($dimensions['offsetX'] ?? 0) + (float) ($node['bbox']['x'] ?? 0);
                $child_dimensions['offsetY'] = (float) ($dimensions['offsetY'] ?? 0) + (float) ($node['bbox']['y'] ?? 0);
            }
            if ($inner_html !== null) {
                $children = $inner_html;
            } else foreach ($children_nodes as $child) {
                $children .= "\n" . $this->render_node($child, $child_dimensions);
            }
            if ($type === 'card') {
                $style .= 'padding:16px;border-radius:' . absint($node['settings']['radius'] ?? 6) . 'px;background:' . esc_attr($this->normalize_color($node['settings']['background'] ?? '#fff')) . ';';
            }
            return '<div class="page-generator-block page-generator-' . esc_attr($type) . '"' . $block_attrs . ' style="' . esc_attr($style) . '">' . "\n" . $children . "\n" . '</div>';
        }
        $source_width = absint($node['settings']['sourceWidth'] ?? 0);
        $source_height = absint($node['settings']['sourceHeight'] ?? 0);
        $style = 'display:flex;flex-direction:' . (($node['settings']['direction'] ?? 'column') === 'row' ? 'row' : 'column') . ';gap:' . absint($node['settings']['gap'] ?? 0) . 'px;';
        if ($root_section && $dimensions && !empty($node['bbox'])) {
            $style = $this->render_box_position_style($node, $dimensions, true) . 'overflow:hidden;';
        } else {
            $style .= 'max-width:' . absint($this->settings()['default_container_width']) . 'px;margin:0 auto;';
        }
        $children = '';
        $child_dimensions = $dimensions ?: ($source_width && $source_height ? ['width' => $source_width, 'height' => $source_height] : null);
        if ($root_section && $child_dimensions) {
            $child_dimensions['offsetY'] = (float) ($node['bbox']['y'] ?? 0);
        }
        if ($inner_html !== null) {
            $children = $inner_html;
        } else foreach ($children_nodes as $child) {
            $children .= "\n" . $this->render_node($child, $child_dimensions);
        }
        $background = !empty($node['background']) ? 'background:' . esc_attr($this->normalize_color($node['background'])) . ';' : '';
        return '<section class="page-generator-block page-generator-section"' . $block_attrs . ' data-component="' . esc_attr($type) . '" data-source-image="0" style="' . esc_attr($style . $background) . '">' . "\n" . '<div class="page-generator-elements" style="position:relative;width:100%;height:100%;">' . "\n" . $children . "\n" . '</div>' . "\n" . '</section>';
    }

    private function normalize_color($value) {
        $value = strtolower(trim((string) $value));
        if (preg_match('/^#([0-9a-f]{3})$/', $value, $match)) {
            return '#' . $match[1][0] . $match[1][0] . $match[1][1] . $match[1][1] . $match[1][2] . $match[1][2];
        }
        if (preg_match('/^#([0-9a-f]{6})$/', $value)) {
            return $value;
        }
        return '#ffffff';
    }

    private function render_position_style($node, $dimensions) {
        $settings = $node['settings'] ?? [];
        $bbox = $node['bbox'] ?? [];
        $style = $node['style'] ?? [];
        $x = $settings['x'] ?? ($bbox['x'] ?? 0);
        $y = $settings['y'] ?? ($bbox['y'] ?? 0);
        $node_width_value = $settings['width'] ?? ($bbox['width'] ?? 0);
        $font_size = $style['fontSize'] ?? ($settings['fontSize'] ?? 16);
        if (!$dimensions || empty($settings['x']) && empty($settings['y'])) {
            if (!$dimensions || (empty($bbox['x']) && empty($bbox['y']))) return '';
        }
        $width = max(1, absint($dimensions['width']));
        $height = max(1, absint($dimensions['height']));
        $left = $this->clamp_percent(((float) $x - (float) ($dimensions['offsetX'] ?? 0)) / $width * 100);
        $top = $this->clamp_percent(((float) $y - (float) ($dimensions['offsetY'] ?? 0)) / $height * 100);
        $node_width = $this->clamp_percent((float) $node_width_value / $width * 100, 1, 100);
        return 'position:absolute;left:' . $left . '%;top:' . $top . '%;width:' . max(1, $node_width) . '%;margin:0;font-size:' . max(10, absint($font_size)) . 'px;line-height:1.2;';
    }

    private function render_box_position_style($node, $dimensions, $root_section = false) {
        $bbox = $node['bbox'] ?? [];
        $width = max(1, (float) ($dimensions['width'] ?? 1));
        $height = max(1, (float) ($dimensions['height'] ?? 1));
        $offset_x = $root_section ? 0 : (float) ($dimensions['offsetX'] ?? 0);
        $offset_y = $root_section ? 0 : (float) ($dimensions['offsetY'] ?? 0);
        $left = $root_section ? 0 : $this->clamp_percent((((float) ($bbox['x'] ?? 0) - $offset_x) / $width) * 100);
        $top = $this->clamp_percent((((float) ($bbox['y'] ?? 0) - $offset_y) / $height) * 100);
        $box_width = $this->clamp_percent(((float) ($bbox['width'] ?? 0) / $width) * 100, 1, 100);
        $box_height = $this->clamp_percent(((float) ($bbox['height'] ?? 0) / $height) * 100, 1, 100);
        return 'position:absolute;left:' . $left . '%;top:' . $top . '%;width:' . $box_width . '%;height:' . $box_height . '%;';
    }

    private function clamp_percent($value, $minimum = 0, $maximum = 100) {
        return round(max($minimum, min($maximum, (float) $value)), 4);
    }

    public function upload_asset() {
        $this->verify_request();
        if (empty($_FILES['asset'])) {
            wp_send_json_error('Файл не надійшов.');
        }
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $attachment_id = media_handle_upload('asset', 0);
        if (is_wp_error($attachment_id)) {
            wp_send_json_error($attachment_id->get_error_message());
        }
        wp_send_json_success(['id' => $attachment_id, 'url' => wp_get_attachment_url($attachment_id)]);
    }
}

new Page_Generator_Plugin();
