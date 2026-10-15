<?php
/**
 * Plugin Name: Page Generator
 * Description: Deterministic page importer for Figma and screenshots with Elementor and WordPress output.
 * Version: 3.4.2
 * Author: Dym
 */

defined('ABSPATH') || exit;

require_once __DIR__ . '/includes/native-blocks.php';
require_once __DIR__ . '/includes/wpforms-export.php';

final class Page_Generator_Plugin {
    use Page_Generator_Native_Blocks;
    use Page_Generator_WPForms_Export;

    const VERSION = '3.4.2';
    const OPTION = 'page_generator_settings';
    const NONCE = 'page_generator_nonce';

    public function __construct() {
        add_action('admin_menu', [$this, 'register_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('elementor/editor/after_enqueue_scripts', [$this, 'enqueue_editor_assets']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin_assets']);
        add_action('wp_enqueue_scripts', [$this, 'enqueue_frontend_assets']);
        add_action('enqueue_block_editor_assets', [$this, 'enqueue_block_editor_assets']);
        $this->register_native_bridge();

        add_action('rest_api_init', [$this, 'register_rest_routes']);
        add_action('wp_ajax_page_generator_scan_figma', [$this, 'scan_figma']);
        add_action('wp_ajax_page_generator_import_figma', [$this, 'import_figma']);
        add_action('wp_ajax_page_generator_create_page', [$this, 'create_page']);
        add_action('wp_ajax_page_generator_compare_page', [$this, 'compare_page']);
        add_action('wp_ajax_page_generator_upload_asset', [$this, 'upload_asset']);
        add_action('wp_ajax_page_generator_elementor_tree', [$this, 'elementor_tree']);
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
                return $this->render_node($node, $dimensions, !empty($attributes['rootSection']), trim((string) $content) !== '' ? $content : null);
            },
        ]);
        register_block_type('page-generator/canvas', [
            'api_version' => 2,
            'attributes' => [
                'width' => ['type' => 'number', 'default' => 0],
                'height' => ['type' => 'number', 'default' => 0],
            ],
            'render_callback' => function ($attributes, $content) {
                $width = absint($attributes['width'] ?? 0);
                $height = absint($attributes['height'] ?? 0);
                $style = 'position:relative;width:100%;max-width:' . absint($this->settings()['default_container_width']) . 'px;margin:0 auto;';
                if ($width && $height) {
                    $style .= 'aspect-ratio:' . $width . '/' . $height . ';overflow:hidden;';
                }
                return '<div class="page-generator-canvas" data-page-generator="canvas" style="' . esc_attr($style) . '">' . $content . '</div>';
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
            'keep_import_json' => 1,
            'use_wpforms' => 0,
        ];
    }

    private function settings() {
        return wp_parse_args((array) get_option(self::OPTION, []), $this->defaults());
    }

    public function save_settings_ajax() {
        $this->verify_request('manage_options');
        $ocr_languages = sanitize_text_field(wp_unslash($_POST['ocrLanguages'] ?? 'ukr+eng'));
        if (!$this->is_valid_ocr_languages($ocr_languages)) {
            wp_send_json_error('Некоректний список мов OCR. Використовуйте коди мов через +, наприклад ukr+eng.');
        }
        $input = [
            'figma_token' => sanitize_text_field(wp_unslash($_POST['figmaToken'] ?? '')),
            'figma_token_total_days' => absint($_POST['figmaTokenTotalDays'] ?? 90),
            'ocr_languages' => $ocr_languages,
            'max_upload_size_mb' => $this->settings()['max_upload_size_mb'],
            'default_container_width' => absint($_POST['defaultContainerWidth'] ?? 1200),
            'keep_import_json' => $this->settings()['keep_import_json'],
            'use_wpforms' => $this->settings()['use_wpforms'],
        ];
        $saved = $this->sanitize_settings($input);
        update_option(self::OPTION, $saved);
        wp_send_json_success([
            'tokenConfigured' => !empty($saved['figma_token']),
            'tokenExpiresAt' => $saved['figma_token_expires_at'] ? wp_date('Y-m-d H:i', $saved['figma_token_expires_at']) : '',
            'tokenTotalDays' => $saved['figma_token_total_days'],
            'ocrLanguages' => $saved['ocr_languages'],
            'containerWidth' => $saved['default_container_width'],
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
        if ($this->is_valid_ocr_languages($input['ocr_languages'] ?? '')) {
            $settings['ocr_languages'] = $input['ocr_languages'];
        } else {
            $settings['ocr_languages'] = $current['ocr_languages'];
            add_settings_error(self::OPTION, 'invalid_ocr_languages', 'Некоректний список мов OCR; попереднє значення збережено.', 'error');
        }
        $settings['max_upload_size_mb'] = max(1, min(100, absint($input['max_upload_size_mb'] ?? 20)));
        $settings['default_container_width'] = max(320, min(2400, absint($input['default_container_width'] ?? 1200)));
        $settings['keep_import_json'] = empty($input['keep_import_json']) ? 0 : 1;
        $settings['use_wpforms'] = empty($input['use_wpforms']) ? 0 : 1;

        if ($settings['figma_token'] !== $current['figma_token']) {
            $settings['figma_token_created_at'] = time();
            $settings['figma_token_expires_at'] = time() + ($settings['figma_token_total_days'] * DAY_IN_SECONDS);
        } elseif ($settings['figma_token'] && $settings['figma_token_total_days'] !== absint($current['figma_token_total_days'])) {
            $settings['figma_token_created_at'] = $settings['figma_token_created_at'] ?: time();
            $settings['figma_token_expires_at'] = $settings['figma_token_created_at'] + ($settings['figma_token_total_days'] * DAY_IN_SECONDS);
        }

        return $settings;
    }

    private function is_valid_ocr_languages($languages) {
        return is_string($languages)
            && strlen($languages) <= 30
            && preg_match('/^[a-z]{2,3}(?:\\+[a-z]{2,3}){0,4}$/', $languages);
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
                        <tr><th>Статус сторінки</th><td>Після імпорту статус поточної сторінки не змінюється.</td></tr>
                        <tr><th>Ширина контейнера</th><td><input type="number" min="320" max="2400" name="<?php echo esc_attr(self::OPTION); ?>[default_container_width]" value="<?php echo esc_attr($settings['default_container_width']); ?>"> px</td></tr>
                        <tr><th>Форми через WPForms</th><td><label><input type="checkbox" name="<?php echo esc_attr(self::OPTION); ?>[use_wpforms]" value="1" <?php checked($settings['use_wpforms'], 1); disabled(!$this->wpforms_available()); ?>> Створювати справжню форму WPForms замість власної розмітки</label><?php if (!$this->wpforms_available()) echo ' <em>(WPForms не встановлено)</em>'; ?></td></tr>
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
        $this->enqueue_generator_assets('page-generator-gutenberg-editor', true);
        wp_enqueue_script('page-generator-bridge', plugins_url('assets/block-bridge.js', __FILE__), ['wp-hooks', 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-compose'], self::VERSION, true);
    }

    public function enqueue_frontend_assets() {
        if (!is_singular()) {
            return;
        }
        $post = get_queried_object();
        if (!$post instanceof WP_Post) {
            return;
        }
        $has_generator_blocks = has_block('page-generator/canvas', $post) || has_block('page-generator/component', $post);
        $elementor_data = get_post_meta($post->ID, '_elementor_data', true);
        $has_elementor_canvas = is_string($elementor_data) && strpos($elementor_data, 'page-generator-canvas') !== false;
        if ($has_generator_blocks || $has_elementor_canvas) {
            wp_enqueue_style('page-generator-frontend', plugins_url('assets/frontend.css', __FILE__), [], self::VERSION);
        }
        if ($has_elementor_canvas) {
            // Elementor lays the canvas out in px, so it needs the shared canvas rules and the zoom-to-fit script.
            wp_enqueue_style('page-generator-canvas', plugins_url('assets/canvas.css', __FILE__), [], self::VERSION);
            wp_enqueue_script('page-generator-canvas-scale', plugins_url('assets/canvas-scale.js', __FILE__), [], self::VERSION, true);
            wp_localize_script('page-generator-canvas-scale', 'PageGeneratorScale', ['maxWidth' => absint($this->settings()['default_container_width'])]);
        }
    }

    private function enqueue_generator_assets($handle, $block_editor = false) {
        $settings = $this->settings();
        wp_enqueue_style($handle, plugins_url('assets/editor.css', __FILE__), [], self::VERSION);
        $dependencies = $block_editor ? ['jquery', 'wp-blocks', 'wp-element', 'wp-block-editor'] : ['jquery'];
        wp_enqueue_script('page-generator-detectors', plugins_url('assets/detectors.js', __FILE__), [], self::VERSION, true);
        $dependencies[] = 'page-generator-detectors';
        wp_enqueue_script($handle, plugins_url('assets/editor.js', __FILE__), $dependencies, self::VERSION, true);
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
            'canManageSettings' => current_user_can('manage_options'),
            'canUploadFiles' => current_user_can('upload_files'),
            'registerBlocks' => $block_editor,
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

    private function verify_request($capability = 'edit_pages') {
        check_ajax_referer(self::NONCE, 'nonce');
        if (!current_user_can($capability)) {
            wp_send_json_error('Недостатньо прав.', 403);
        }
    }

    public function register_rest_routes() {
        $permission = function ($request) {
            return current_user_can('edit_post', absint($request['id']));
        };
        register_rest_route('page-generator/v1', '/pages/(?P<id>\\d+)/schema', [
            ['methods' => 'GET', 'callback' => [$this, 'rest_get_schema'], 'permission_callback' => $permission],
            ['methods' => 'PUT', 'callback' => [$this, 'rest_put_schema'], 'permission_callback' => $permission],
        ]);
        register_rest_route('page-generator/v1', '/pages/(?P<id>\\d+)/export', [
            'methods' => 'GET',
            'callback' => [$this, 'rest_export'],
            'permission_callback' => $permission,
            'args' => ['target' => ['required' => true, 'type' => 'string', 'enum' => ['elementor', 'blocks', 'html']]],
        ]);
    }

    private function rest_saved_schema($post_id) {
        $stored = get_post_meta($post_id, '_page_generator_schema', true);
        $schema = is_string($stored) ? json_decode($stored, true) : null;
        return is_array($schema) && !empty($schema['sections']) ? $schema : null;
    }

    public function rest_get_schema($request) {
        $post_id = absint($request['id']);
        $schema = $this->rest_saved_schema($post_id);
        if (!$schema) {
            return new WP_Error('page_generator_no_schema', 'Для цієї сторінки немає збереженої схеми.', ['status' => 404]);
        }
        return [
            'id' => $post_id,
            'schema' => $schema,
            'outputMode' => get_post_meta($post_id, '_page_generator_output_mode', true) ?: null,
        ];
    }

    // Accepts {"schema": {...}} (optionally "title", "editorMode") or the bare schema; the page is rebuilt from it exactly as after an editor save.
    public function rest_put_schema($request) {
        $post_id = absint($request['id']);
        $body = $request->get_json_params();
        if (!is_array($body)) {
            return new WP_Error('page_generator_bad_body', 'Очікується JSON-тіло запиту.', ['status' => 400]);
        }
        $schema = isset($body['schema']) && is_array($body['schema']) ? $body['schema'] : $body;
        if (empty($schema['sections']) || !is_array($schema['sections'])) {
            return new WP_Error('page_generator_bad_schema', 'Схема порожня: потрібне поле sections.', ['status' => 400]);
        }
        $errors = $this->validate_schema($schema);
        foreach ($schema['sections'] as $section) {
            $root_type = is_array($section) ? sanitize_key($section['type'] ?? '') : '';
            // Root nodes are page regions: the plain ones plus the editor's specialised sections (form-section, table-section, ...).
            if (!in_array($root_type, ['header', 'footer', 'hero', 'navigation', 'main', 'aside', 'article'], true) && !preg_match('/^(?:[a-z]+-)?section$/', $root_type)) {
                $errors[] = 'Невідомий тип кореневого вузла: ' . ($root_type ?: 'порожній') . '.';
            }
        }
        if ($errors) {
            return new WP_Error('page_generator_invalid_schema', 'Схема не пройшла перевірку: ' . implode(' ', $errors), ['status' => 422]);
        }
        $result = $this->apply_schema(
            $post_id,
            $schema,
            isset($body['title']) ? sanitize_text_field($body['title']) : '',
            isset($body['editorMode']) ? sanitize_key($body['editorMode']) : '',
            true,
            isset($body['forms']) ? sanitize_key($body['forms']) : ''
        );
        if (is_wp_error($result)) {
            $result->add_data(['status' => 500]);
        }
        return $result;
    }

    public function rest_export($request) {
        $post_id = absint($request['id']);
        $schema = $this->rest_saved_schema($post_id);
        if (!$schema) {
            return new WP_Error('page_generator_no_schema', 'Для цієї сторінки немає збереженої схеми.', ['status' => 404]);
        }
        $this->wpforms_enabled = $this->wpforms_wanted('');
        $target = $request['target'];
        if ($target === 'elementor') return ['target' => $target, 'models' => $this->serialize_elementor_schema($schema)];
        if ($target === 'blocks') return ['target' => $target, 'content' => $this->render_block_content($schema)];
        return ['target' => $target, 'content' => $this->render_html($schema)];
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
        $image_node_ids = [];
        foreach (($response['nodes'] ?? []) as $node) {
            if (!empty($node['document'])) {
                $this->collect_figma_image_nodes($node['document'], $image_node_ids);
            }
        }
        $image_node_ids = array_values(array_unique($image_node_ids));
        if (count($image_node_ids) > 20) {
            wp_send_json_error('У вибраних фреймах понад 20 image-fill вузлів. Імпортуйте меншу кількість фреймів за один раз.');
        }
        if ($image_node_ids && !current_user_can('upload_files')) {
            wp_send_json_error('Для імпорту Figma image-fill зображень потрібне право завантажувати медіафайли.', 403);
        }
        $image_assets = $this->import_figma_images($file_key, $image_node_ids);
        if (is_wp_error($image_assets)) {
            wp_send_json_error($image_assets->get_error_message());
        }
        $sections = [];
        foreach (($response['nodes'] ?? []) as $node) {
            if (!empty($node['document'])) {
                $origin = $node['document']['absoluteBoundingBox'] ?? ['x' => 0, 'y' => 0];
                $parsed = $this->translate_node($node['document'], false, $origin, $image_assets);
                if ($parsed) {
                    $parsed['sourceGroup'] = 'figma-' . sanitize_key($parsed['id']);
                    $parsed['settings']['sourceWidth'] = absint($parsed['bbox']['width'] ?? 0);
                    $parsed['settings']['sourceHeight'] = absint($parsed['bbox']['height'] ?? 0);
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

    private function collect_figma_image_nodes($node, &$ids) {
        $has_image_fill = false;
        foreach (($node['fills'] ?? []) as $fill) {
            if (($fill['type'] ?? '') === 'IMAGE' && !empty($fill['imageRef'])) {
                $has_image_fill = true;
                break;
            }
        }
        if ($has_image_fill && !empty($node['id'])) {
            $ids[] = $node['id'];
        }
        foreach (($node['children'] ?? []) as $child) {
            $this->collect_figma_image_nodes($child, $ids);
        }
    }

    private function import_figma_images($file_key, $node_ids) {
        if (!$node_ids) {
            return [];
        }
        $path = '/images/' . rawurlencode($file_key) . '?ids=' . rawurlencode(implode(',', $node_ids)) . '&format=png&scale=1';
        $response = $this->figma_request($path);
        if (is_wp_error($response)) {
            return $response;
        }
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $assets = [];
        foreach (($response['images'] ?? []) as $node_id => $image_url) {
            $host = strtolower((string) wp_parse_url($image_url, PHP_URL_HOST));
            if (strpos((string) $image_url, 'https://') !== 0 || !($host === 'figma.com' || substr($host, -10) === '.figma.com')) {
                return new WP_Error('figma_image_host', 'Figma повернула URL з недозволеного домену зображень.');
            }
            $image_response = wp_safe_remote_get($image_url, ['timeout' => 30, 'redirection' => 0, 'limit_response_size' => 20 * MB_IN_BYTES]);
            if (is_wp_error($image_response) || wp_remote_retrieve_response_code($image_response) !== 200) {
                return new WP_Error('figma_image_download', 'Не вдалося завантажити зображення з Figma.');
            }
            $bytes = wp_remote_retrieve_body($image_response);
            if (!$bytes || strlen($bytes) > 20 * MB_IN_BYTES) {
                return new WP_Error('figma_image_size', 'Зображення Figma порожнє або перевищує ліміт 20 MB.');
            }
            $temp_file = wp_tempnam('page-generator-figma');
            if (!$temp_file || file_put_contents($temp_file, $bytes) === false) {
                if ($temp_file) @unlink($temp_file);
                return new WP_Error('figma_image_temp', 'Не вдалося підготувати зображення Figma для завантаження.');
            }
            $attachment_id = media_handle_sideload([
                'name' => 'figma-' . sanitize_file_name(str_replace(':', '-', $node_id)) . '.png',
                'tmp_name' => $temp_file,
                'type' => 'image/png',
                'size' => strlen($bytes),
            ], 0);
            if (is_wp_error($attachment_id)) {
                @unlink($temp_file);
                return $attachment_id;
            }
            $assets[$node_id] = [
                'id' => $attachment_id,
                'url' => wp_get_attachment_url($attachment_id),
            ];
        }
        foreach ($node_ids as $node_id) {
            if (empty($assets[$node_id])) {
                return new WP_Error('figma_image_missing', 'Figma не повернула зображення для одного з image-fill вузлів.');
            }
        }
        return $assets;
    }

    private function figma_fill_color($node, $fill_key) {
        foreach (($node[$fill_key] ?? []) as $fill) {
            if (($fill['type'] ?? '') !== 'SOLID' || empty($fill['color']) || ($fill['visible'] ?? true) === false) {
                continue;
            }
            $color = $fill['color'];
            $channels = [];
            foreach (['r', 'g', 'b'] as $channel) {
                $channels[] = str_pad(dechex((int) round(max(0, min(1, (float) ($color[$channel] ?? 0))) * 255)), 2, '0', STR_PAD_LEFT);
            }
            return '#' . implode('', $channels);
        }
        return '';
    }

    private function translate_node($node, $is_inner = true, $origin = null, $image_assets = []) {
        if (($node['visible'] ?? true) === false) {
            return null;
        }
        $type = $node['type'] ?? '';
        $id = substr(md5(uniqid('', true)), 0, 7);
        $origin = is_array($origin) ? $origin : ['x' => 0, 'y' => 0];
        $absolute_box = is_array($node['absoluteBoundingBox'] ?? null) ? $node['absoluteBoundingBox'] : [];
        $bbox = $absolute_box ? [
            'x' => (float) ($absolute_box['x'] ?? 0) - (float) ($origin['x'] ?? 0),
            'y' => (float) ($absolute_box['y'] ?? 0) - (float) ($origin['y'] ?? 0),
            'width' => (float) ($absolute_box['width'] ?? 0),
            'height' => (float) ($absolute_box['height'] ?? 0),
        ] : null;
        $background = $this->figma_fill_color($node, 'fills');
        if (!empty($image_assets[$node['id'] ?? ''])) {
            $asset = $image_assets[$node['id']];
            return [
                'id' => $id,
                'type' => 'image',
                'url' => $asset['url'],
                'attachmentId' => $asset['id'],
                'bbox' => $bbox,
                'settings' => $bbox ?: [],
                'style' => [],
                'elements' => [],
            ];
        }
        if (in_array($type, ['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'LINE'], true)) {
            $settings = [
                'direction' => (($node['layoutMode'] ?? '') === 'HORIZONTAL') ? 'row' : 'column',
                'width' => '100%',
                'gap' => absint($node['itemSpacing'] ?? 0),
                'sourceWidth' => $is_inner ? 0 : absint($bbox['width'] ?? 0),
                'sourceHeight' => $is_inner ? 0 : absint($bbox['height'] ?? 0),
                'padding' => [
                    'top' => absint($node['paddingTop'] ?? 0),
                    'right' => absint($node['paddingRight'] ?? 0),
                    'bottom' => absint($node['paddingBottom'] ?? 0),
                    'left' => absint($node['paddingLeft'] ?? 0),
                ],
            ];
            $elements = [];
            foreach (($node['children'] ?? []) as $child) {
                $parsed = $this->translate_node($child, true, $origin, $image_assets);
                if ($parsed) {
                    $elements[] = $parsed;
                }
            }
            return [
                'id' => $id,
                'type' => 'container',
                'inner' => $is_inner,
                'bbox' => $bbox,
                'background' => $background,
                'style' => ['background' => $background],
                'settings' => $settings,
                'elements' => $elements,
            ];
        }
        if ($type === 'TEXT' && trim($node['characters'] ?? '') !== '') {
            $text = trim($node['characters']);
            $text_color = $this->figma_fill_color($node, 'fills');
            $font_size = absint($node['style']['fontSize'] ?? 16);
            return [
                'id' => $id,
                'type' => $font_size >= 24 ? 'heading' : 'text',
                'content' => $text,
                'text' => $text,
                'bbox' => $bbox,
                'style' => ['fontSize' => $font_size, 'fontWeight' => absint($node['style']['fontWeight'] ?? 400), 'color' => $text_color],
                'settings' => [
                    'x' => $bbox['x'] ?? 0,
                    'y' => $bbox['y'] ?? 0,
                    'width' => $bbox['width'] ?? 0,
                    'height' => $bbox['height'] ?? 0,
                    'fontSize' => $font_size,
                    'fontWeight' => absint($node['style']['fontWeight'] ?? 400),
                ],
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
        $result = $this->apply_schema(
            $post_id,
            $schema,
            isset($_POST['title']) ? sanitize_text_field(wp_unslash($_POST['title'])) : '',
            sanitize_key(wp_unslash($_POST['editorMode'] ?? '')),
            false,
            sanitize_key(wp_unslash($_POST['forms'] ?? ''))
        );
        if (is_wp_error($result)) {
            wp_send_json_error($result->get_error_message());
        }
        wp_send_json_success($result);
    }

    // Writes a validated schema into a page through every exporter (blocks, Elementor tree) and returns a summary, or a WP_Error.
    // Shared by the editor's AJAX save and the REST PUT so both produce identical pages.
    private function apply_schema($post_id, $schema, $raw_title, $requested_editor_mode, $always_store = false, $forms_mode = '') {
        $this->wpforms_enabled = $this->wpforms_wanted($forms_mode);
        if ($this->wpforms_enabled) {
            $schema = $this->attach_wpforms($schema, $post_id);
        }
        $post_before_update = get_post($post_id);
        $title = $post_before_update ? $post_before_update->post_title : '';
        if (in_array(trim($title), ['Imported screenshot page', 'Imported page'], true)) {
            $title = '';
        }
        if ($raw_title && $raw_title !== 'Imported screenshot page') {
            $title = $raw_title;
        }
        $elementor_mode = $requested_editor_mode === 'elementor'
            ? true
            : ($requested_editor_mode === 'gutenberg' ? false : $this->is_elementor_page($post_id));
        $rendered_html = $this->render_html($schema);
        $block_content = $this->render_block_content($schema);
        // Keep the previous content restorable before it is replaced.
        wp_save_post_revision($post_id);
        $updated = wp_update_post([
            'ID' => $post_id,
            'post_title' => $title,
            'post_content' => $block_content,
        ], true);
        if (is_wp_error($updated)) {
            return $updated;
        }
        if (!$updated) {
            return new WP_Error('page_generator_not_updated', 'WordPress не оновив поточну сторінку.');
        }
        $post = get_post($post_id);
        if (!$post) {
            return new WP_Error('page_generator_missing', 'Оновлену сторінку не знайдено.');
        }
        if ($always_store || $this->settings()['keep_import_json']) {
            update_post_meta($post_id, '_page_generator_schema', wp_slash(wp_json_encode($schema)));
        }
        if ($elementor_mode) {
            $elementor_data = $this->serialize_elementor_schema($schema);
            update_post_meta($post_id, '_elementor_data', wp_slash(wp_json_encode($elementor_data)));
            // Without these Elementor ignores _elementor_data and renders post_content, so a REST-built page would stay plain blocks.
            update_post_meta($post_id, '_elementor_edit_mode', 'builder');
            update_post_meta($post_id, '_elementor_template_type', 'wp-page');
            delete_post_meta($post_id, '_elementor_css');
            // Elementor also keeps rendered element HTML and page assets in meta; stale copies would show the previous tree.
            delete_post_meta($post_id, '_elementor_element_cache');
            delete_post_meta($post_id, '_elementor_page_assets');
            // The generated stylesheet is keyed by element ids, so a rebuilt tree must not keep the old file.
            if (class_exists('\\Elementor\\Core\\Files\\CSS\\Post')) {
                (new \Elementor\Core\Files\CSS\Post($post_id))->delete();
            }
        } else {
            delete_post_meta($post_id, '_elementor_data');
            delete_post_meta($post_id, '_elementor_css');
            delete_post_meta($post_id, '_elementor_edit_mode');
        }
        update_post_meta($post_id, '_page_generator_output_mode', $elementor_mode ? 'elementor-native-tree' : 'gutenberg-native-blocks');
        update_post_meta($post_id, '_page_generator_render_length', strlen($rendered_html));
        update_post_meta($post_id, '_page_generator_render_hash', md5($rendered_html));
        return [
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
            'outputMode' => $elementor_mode ? 'elementor-native-tree' : 'gutenberg-native-blocks',
            'blockCount' => substr_count($block_content, '<!-- wp:'),
            'contentHash' => md5($block_content),
        ];
    }

    public function compare_page() {
        $this->verify_request();
        $post_id = absint($_POST['postId'] ?? 0);
        if (!$post_id || !current_user_can('edit_post', $post_id)) {
            wp_send_json_error('Немає права порівнювати цю сторінку.');
        }
        $url = esc_url_raw(wp_unslash($_POST['url'] ?? ''));
        $source_attachment_id = absint($_POST['sourceAttachmentId'] ?? 0);
        $schema = json_decode(wp_unslash($_POST['schema'] ?? ''), true);
        $width = absint($_POST['width'] ?? 0);
        $height = absint($_POST['height'] ?? 0);
        if (!$url || !$this->is_same_site_url($url) || !$source_attachment_id || !$width || !$height || $width > 10000 || $height > 10000 || $width * $height > 40000000 || !is_array($schema)) {
            wp_send_json_error('Для порівняння потрібні URL сторінки цього сайту, доступний attachment зображення та коректні розміри до 40 мегапікселів.');
        }
        $runner = __DIR__ . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'screenshot-runner.js';
        $node = defined('PAGE_GENERATOR_NODE_PATH') ? PAGE_GENERATOR_NODE_PATH : 'node';
        if (!file_exists($runner) || !function_exists('shell_exec')) {
            wp_send_json_error('Локальний Playwright runner недоступний. Перевірте Node.js та tools/screenshot-runner.js.');
        }
        $attachment = get_post($source_attachment_id);
        if (!$attachment || $attachment->post_type !== 'attachment' || !current_user_can('edit_post', $source_attachment_id)) {
            wp_send_json_error('Немає доступу до reference image attachment.');
        }
        $source_path = get_attached_file($source_attachment_id);
        $mime_type = get_post_mime_type($source_attachment_id);
        $image_info = $source_path && is_readable($source_path) ? wp_getimagesize($source_path) : false;
        if (!$source_path || !is_readable($source_path) || strpos((string) $mime_type, 'image/') !== 0
            || !$image_info || empty($image_info[0]) || empty($image_info[1])
            || $image_info[0] > 10000 || $image_info[1] > 10000 || $image_info[0] * $image_info[1] > 40000000) {
            wp_send_json_error('Reference attachment відсутній, недоступний або не є зображенням.');
        }
        $tools_directory = __DIR__ . DIRECTORY_SEPARATOR . 'tools';
        $preflight = 'cd ' . escapeshellarg($tools_directory) . ' && ' . escapeshellarg($node) . ' -e '
            . escapeshellarg("const fs=require('fs');const {chromium}=require('playwright');require.resolve('pngjs');if(!fs.existsSync(chromium.executablePath()))process.exit(2);console.log('ready');")
            . ' 2>&1';
        $preflight_output = shell_exec($preflight);
        if (trim((string) $preflight_output) !== 'ready') {
            wp_send_json_error('Node.js, Playwright, pngjs або Chromium недоступні. Установіть tools залежності й Chromium. ' . sanitize_text_field((string) $preflight_output));
        }
        $source_file = wp_tempnam('page-generator-source');
        $schema_file = wp_tempnam('page-generator-schema');
        $cookies_file = wp_tempnam('page-generator-cookies');
        $diff_file = wp_tempnam('page-generator-diff');
        $rendered_file = wp_tempnam('page-generator-rendered');
        if (!$source_file || !$schema_file || !$cookies_file || !$diff_file || !$rendered_file) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file]);
            wp_send_json_error('Не вдалося створити тимчасові файли для Playwright.');
        }
        $auth_cookies = [];
        foreach ($_COOKIE as $cookie_name => $cookie_value) {
            if (strpos($cookie_name, 'wordpress_logged_in_') !== 0 && strpos($cookie_name, 'wordpress_sec_') !== 0) {
                continue;
            }
            if (!is_string($cookie_value)) {
                continue;
            }
            $auth_cookies[] = [
                'name' => $cookie_name,
                'value' => wp_unslash($cookie_value),
                'url' => home_url('/'),
                'secure' => is_ssl(),
                'httpOnly' => true,
            ];
        }
        if (file_put_contents($cookies_file, wp_json_encode($auth_cookies)) === false) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file]);
            wp_send_json_error('Не вдалося підготувати авторизований preview для Playwright.');
        }
        if (!chmod($cookies_file, 0600)) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file]);
            wp_send_json_error('Не вдалося безпечно підготувати авторизований preview для Playwright.');
        }
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $image_editor = wp_get_image_editor($source_path);
        if (is_wp_error($image_editor)) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file]);
            wp_send_json_error('WordPress не може прочитати reference image: ' . $image_editor->get_error_message());
        }
        $png = $image_editor->save($source_file, 'image/png');
        $png_path = is_array($png) ? ($png['path'] ?? '') : '';
        if (is_wp_error($png) || !$png_path || !is_readable($png_path) || file_put_contents($schema_file, wp_json_encode($schema)) === false) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file, $png_path]);
            wp_send_json_error('Не вдалося підготувати файли для Playwright.');
        }
        $width = absint($png['width'] ?? 0);
        $height = absint($png['height'] ?? 0);
        if (!$width || !$height || $width > 10000 || $height > 10000 || $width * $height > 40000000) {
            $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $diff_file, $rendered_file, $png_path]);
            wp_send_json_error('Розміри reference image перевищують підтримувану межу.');
        }
        $command = escapeshellarg($node) . ' ' . escapeshellarg($runner)
            . ' --url ' . escapeshellarg($url)
            . ' --allowed-host ' . escapeshellarg(wp_parse_url(home_url('/'), PHP_URL_HOST))
            . ' --source ' . escapeshellarg($png_path)
            . ' --schema ' . escapeshellarg($schema_file)
            . ' --cookies ' . escapeshellarg($cookies_file)
            . ' --diff ' . escapeshellarg($diff_file)
            . ' --rendered ' . escapeshellarg($rendered_file)
            . ' --width ' . absint($width)
            . ' --height ' . absint($height);
        $output = shell_exec($command);
        $this->remove_temp_files([$source_file, $schema_file, $cookies_file, $png_path]);
        $result = json_decode(trim((string) $output), true);
        if (!is_array($result) || empty($result['success'])) {
            $this->remove_temp_files([$diff_file, $rendered_file]);
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
        $this->remove_temp_files([$diff_file, $rendered_file]);
        wp_send_json_success($result);
    }

    private function remove_temp_files($paths) {
        foreach ($paths as $path) {
            if (is_string($path) && $path !== '' && is_file($path)) {
                if (!unlink($path)) {
                    error_log('Page Generator could not remove temporary file: ' . basename($path));
                }
            }
        }
    }

    private function is_same_site_url($url) {
        $target = wp_parse_url($url);
        $site = wp_parse_url(home_url('/'));
        if (!is_array($target) || !is_array($site) || empty($target['scheme']) || empty($target['host']) || empty($site['host'])) {
            return false;
        }
        if (!in_array(strtolower($target['scheme']), ['http', 'https'], true)
            || !empty($target['user']) || !empty($target['pass'])
            || strtolower($target['host']) !== strtolower($site['host'])) {
            return false;
        }
        $default_port = strtolower($target['scheme']) === 'https' ? 443 : 80;
        return (int) ($target['port'] ?? $default_port) === (int) ($site['port'] ?? $default_port);
    }

    private function render_html($schema) {
        $first_section = !empty($schema['sections'][0]) && is_array($schema['sections'][0]) ? $schema['sections'][0] : [];
        $width = absint($first_section['settings']['sourceWidth'] ?? 0);
        $height = absint($first_section['settings']['sourceHeight'] ?? 0);
        $canvas_style = 'position:relative;container-type:inline-size;width:100%;max-width:' . absint($this->settings()['default_container_width']) . 'px;margin:0 auto;font-family:Arial,sans-serif;color:#334155;';
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
        return $this->native_content($schema);
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

    // Consecutive sections from one source (one screenshot or Figma frame) share a canvas.
    private function group_sections($schema) {
        $groups = [];
        foreach (($schema['sections'] ?? []) as $section) {
            $group_id = (string) ($section['sourceGroup'] ?? 'default');
            if (!$groups || end($groups)['id'] !== $group_id) {
                $groups[] = ['id' => $group_id, 'sections' => []];
            }
            $groups[count($groups) - 1]['sections'][] = $section;
        }
        return $groups;
    }

    private $elementor_canvas_width = 0.0;

    private function serialize_elementor_schema($schema) {
        $models = [];
        foreach ($this->group_sections($schema) as $group) {
            $first_section = $group['sections'][0] ?? [];
            $width = absint($first_section['settings']['sourceWidth'] ?? 0);
            $height = absint($first_section['settings']['sourceHeight'] ?? 0);
            $canvas_box = ['x' => 0, 'y' => 0, 'width' => $width, 'height' => $height];
            $this->elementor_canvas_width = (float) $width;
            $elements = [];
            foreach ($group['sections'] as $section) {
                $elements[] = $this->serialize_elementor_node($section, true, $canvas_box);
            }
            $canvas_settings = [
                // pg-w-N tells assets/canvas-scale.js the width the px layout was built at, so it can zoom the canvas to fit narrower screens.
                'css_classes' => 'page-generator-canvas' . ($width ? ' pg-el-canvas pg-w-' . $width : ''),
                'flex_direction' => 'column',
                'content_width' => 'full',
                'padding' => $this->elementor_box_values(0),
                'flex_gap' => $this->elementor_gap(0),
            ];
            if ($width) {
                $canvas_settings['width'] = ['unit' => 'px', 'size' => $width, 'sizes' => []];
            }
            if ($height) {
                $canvas_settings['min_height'] = ['unit' => 'px', 'size' => $height];
            }
            $models[] = [
                'id' => substr(md5(wp_json_encode($elements)), 0, 7),
                'elType' => 'container',
                'isInner' => false,
                'settings' => $canvas_settings,
                'elements' => $elements,
            ];
        }
        return $models;
    }

    // Single source of truth for the Elementor tree: the browser sends the schema and inserts the returned models as-is.
    public function elementor_tree() {
        $this->verify_request();
        $raw_schema = isset($_POST['schema']) ? wp_unslash($_POST['schema']) : '';
        $schema = json_decode($raw_schema, true);
        if (!is_array($schema) || empty($schema['sections'])) {
            wp_send_json_error('Схема сторінки порожня або пошкоджена. Отримано: ' . json_last_error_msg());
        }
        $validation_errors = $this->validate_schema($schema);
        if ($validation_errors) {
            wp_send_json_error('Схема не пройшла перевірку: ' . implode(' ', $validation_errors));
        }
        wp_send_json_success(['models' => $this->serialize_elementor_schema($schema)]);
    }

    private function serialize_elementor_node($node, $root = false, $parent_bbox = null) {
        $type = sanitize_key($node['type'] ?? 'section');
        $settings = is_array($node['settings'] ?? null) ? $node['settings'] : [];
        $children = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        $id = sanitize_key($node['id'] ?? '') ?: substr(md5(wp_json_encode($node)), 0, 7);
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $text_color = $this->normalize_color($style['color'] ?? ($node['color'] ?? ''));
        $background_color = $this->normalize_color($style['background'] ?? ($node['background'] ?? ''));

        $text_types = ['heading', 'text', 'link', 'logo', 'badge'];
        if (in_array($type, $text_types, true)) {
            $label = (string) ($node['text'] ?? ($node['content'] ?? ''));
            $has_plate = !empty($style['background']) || !empty($node['background']);
            $widget = $this->elementor_text_widget($id, $type, $label, $style, $settings, $text_color, $has_plate);
            if (!$has_plate) {
                return $this->apply_elementor_geometry($widget, $node, $parent_bbox);
            }
            // A filled text node (badge, tag) is a plate: a container carries the fill, radius and border, the text sits centred in it.
            $plate = [
                'id' => $id . 'p',
                'elType' => 'container',
                'isInner' => true,
                'settings' => $this->elementor_plate_settings($style, $node, 'row') + ['flex_justify_content' => 'center', 'flex_align_items' => 'center'],
                'elements' => [$widget],
            ];
            return $this->apply_elementor_geometry($plate, $node, $parent_bbox);
        }
        if ($type === 'button') {
            $widget_settings = [
                'text' => sanitize_text_field($node['text'] ?? ($node['content'] ?? 'Кнопка')),
                'link' => ['url' => esc_url_raw($node['behavior']['url'] ?? '#')],
                'align' => 'justify',
                '_margin' => $this->elementor_box_values(0),
            ] + $this->elementor_typography($style, $settings);
            if ($text_color !== '#ffffff' || !empty($style['color']) || !empty($node['color'])) {
                $widget_settings['button_text_color'] = $text_color;
            }
            if ($background_color !== '#ffffff' || !empty($style['background']) || !empty($node['background'])) {
                $widget_settings['background_color'] = $background_color;
            }
            // The button is as big as its plate on the screenshot: full width, and vertical padding that makes up the height.
            $font = max(10, absint($style['fontSize'] ?? ($settings['fontSize'] ?? 16)));
            $plate_height = (float) ($node['bbox']['height'] ?? 0);
            $pad_y = $plate_height > 0 ? max(0, round(($plate_height - $font * 1.2) / 2, 2)) : 12;
            $widget_settings['text_padding'] = ['unit' => 'px', 'top' => (string) $pad_y, 'right' => '0', 'bottom' => (string) $pad_y, 'left' => '0', 'isLinked' => false];
            if (!empty($style['borderRadius'])) {
                $widget_settings['border_radius'] = $this->elementor_box_values(absint($style['borderRadius']));
            }
            if (!empty($style['borderColor']) && !empty($style['borderWidth'])) {
                $widget_settings['border_border'] = 'solid';
                $widget_settings['border_width'] = $this->elementor_box_values(absint($style['borderWidth']));
                $widget_settings['border_color'] = $this->normalize_color($style['borderColor']);
            }
            return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'widget', 'widgetType' => 'button', 'settings' => $widget_settings, 'elements' => []], $node, $parent_bbox);
        }
        if ($type === 'image') {
            $asset = is_array($node['asset'] ?? null) ? $node['asset'] : [];
            return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'widget', 'widgetType' => 'image', 'settings' => ['image' => ['url' => esc_url_raw($node['url'] ?? ($asset['url'] ?? '')), 'id' => absint($node['attachmentId'] ?? ($asset['id'] ?? 0))]], 'elements' => []], $node, $parent_bbox);
        }
        if ($type === 'icon') {
            // An Elementor icon widget with no icon chosen shows a default star, so an icon without a picture is an empty container.
            $asset = is_array($node['asset'] ?? null) ? $node['asset'] : [];
            $icon_url = $node['url'] ?? ($asset['url'] ?? '');
            if ($icon_url) {
                return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'widget', 'widgetType' => 'image', 'settings' => ['image' => ['url' => esc_url_raw($icon_url), 'id' => absint($node['attachmentId'] ?? ($asset['id'] ?? 0))]], 'elements' => []], $node, $parent_bbox);
            }
            return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'container', 'isInner' => true, 'settings' => $this->elementor_plate_settings($style, $node, 'row'), 'elements' => []], $node, $parent_bbox);
        }
        if ($type === 'form' && $this->wpforms_node_active($node)) {
            // [wpforms] is expanded by the text-editor widget (the HTML widget would print it as is).
            return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => ['editor' => $this->wpforms_embed_html($node), '_margin' => $this->elementor_box_values(0), '_padding' => $this->elementor_box_values(0)], 'elements' => []], $node, $parent_bbox);
        }
        if ($type === 'form' || $type === 'form-field' || $type === 'table') {
            $html = $this->render_node($node);
            $box = is_array($node['bbox'] ?? null) ? $node['bbox'] : null;
            if ($type === 'form' && $box && !empty($box['width']) && !empty($box['height'])) {
                // The widget sits at the form's box, so the form fills it and its fields are placed (in %) inside that box.
                $dimensions = [
                    'width' => (float) $box['width'],
                    'height' => (float) $box['height'],
                    'offsetX' => (float) ($box['x'] ?? 0),
                    'offsetY' => (float) ($box['y'] ?? 0),
                    'fontWidth' => $this->elementor_canvas_width,
                ];
                $html = '<div style="position:relative;width:100%;height:' . round((float) $box['height'], 2) . 'px">' . $this->render_node($node, $dimensions) . '</div>';
            }
            return $this->apply_elementor_geometry(['id' => $id, 'elType' => 'widget', 'widgetType' => 'html', 'settings' => ['html' => $html], 'elements' => []], $node, $parent_bbox);
        }
        $elementor_settings = $this->elementor_plate_settings($style, $node, (($settings['direction'] ?? '') === 'row' ? 'row' : 'column'))
            + ['flex_gap' => $this->elementor_gap(absint($settings['gap'] ?? 0))];
        $model = [
            'id' => $id,
            'elType' => 'container',
            'isInner' => !$root,
            'settings' => $elementor_settings,
            'elements' => array_map(function ($child) use ($node) {
                return $this->serialize_elementor_node($child, false, $node['bbox'] ?? null);
            }, $children),
        ];
        return $this->apply_elementor_geometry($model, $node, $parent_bbox);
    }

    private function elementor_gap($pixels) {
        return ['unit' => 'px', 'column' => (string) $pixels, 'row' => (string) $pixels, 'isLinked' => true];
    }

    private function elementor_box_values($pixels) {
        $value = (string) $pixels;
        return ['unit' => 'px', 'top' => $value, 'right' => $value, 'bottom' => $value, 'left' => $value, 'isLinked' => true];
    }

    // Typography controls shared by the heading, text-editor and button widgets (size, weight and face come from the screenshot).
    private function elementor_typography($style, $settings) {
        $out = [];
        $font = $style['fontSize'] ?? ($settings['fontSize'] ?? null);
        if (is_numeric($font) && $font > 0) {
            $out['typography_typography'] = 'custom';
            $out['typography_font_size'] = ['unit' => 'px', 'size' => max(10, absint($font)), 'sizes' => []];
            $out['typography_line_height'] = ['unit' => 'em', 'size' => 1.2, 'sizes' => []];
        }
        if (!empty($style['fontWeight'])) {
            $out['typography_typography'] = 'custom';
            $out['typography_font_weight'] = (string) absint($style['fontWeight']);
        }
        if (($style['fontFamily'] ?? '') === 'serif') {
            $out['typography_typography'] = 'custom';
            $out['typography_font_family'] = 'Georgia';
        }
        return $out;
    }

    private function elementor_text_widget($id, $type, $label, $style, $settings, $text_color, $has_plate) {
        $has_color = !empty($style['color']);
        $nowrap = strpos($label, "\n") === false;
        $common = [
            '_margin' => $this->elementor_box_values(0),
            '_padding' => $this->elementor_box_values(0),
            '_css_classes' => 'pg-el-text' . ($nowrap ? ' pg-nowrap' : '') . ($type === 'link' ? ' pg-link' : ''),
        ] + $this->elementor_typography($style, $settings);
        if ($type === 'heading') {
            $widget_settings = ['title' => wp_kses_post($label)] + $common;
            if ($has_color) $widget_settings['title_color'] = $text_color;
            return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => $widget_settings, 'elements' => []];
        }
        $widget_settings = ['editor' => '<p>' . nl2br(esc_html($label)) . '</p>'] + $common;
        if ($has_color) $widget_settings['text_color'] = $text_color;
        if ($has_plate) $widget_settings['align'] = 'center';
        return ['id' => $id, 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => $widget_settings, 'elements' => []];
    }

    // Container controls for a filled/bordered surface: no padding, fill, border, radius, shadow.
    private function elementor_plate_settings($style, $node, $direction) {
        $out = [
            'flex_direction' => $direction,
            'content_width' => 'full',
            'padding' => $this->elementor_box_values(0),
        ];
        $fill = $style['background'] ?? ($node['background'] ?? '');
        if ($fill) {
            $out['background_background'] = 'classic';
            $out['background_color'] = $this->normalize_color($fill);
        }
        if (!empty($style['borderRadius'])) {
            $out['border_radius'] = $this->elementor_box_values(absint($style['borderRadius']));
        }
        $border_width = absint($style['borderWidth'] ?? 0);
        if (!empty($style['borderColor']) && $border_width) {
            $out['border_border'] = 'solid';
            $out['border_width'] = $this->elementor_box_values($border_width);
            $out['border_color'] = $this->normalize_color($style['borderColor']);
        }
        $accent_width = absint($style['accentWidth'] ?? 0);
        if (!empty($style['accentColor']) && $accent_width && empty($style['shadow'])) {
            // One border colour per container in Elementor, so the coloured left edge is an inset shadow.
            $out['box_shadow_box_shadow_type'] = 'yes';
            $out['box_shadow_box_shadow_position'] = 'inset';
            $out['box_shadow_box_shadow'] = ['horizontal' => $accent_width, 'vertical' => 0, 'blur' => 0, 'spread' => 0, 'color' => $this->normalize_color($style['accentColor'])];
        } elseif (!empty($style['shadow'])) {
            $out['box_shadow_box_shadow_type'] = 'yes';
            $out['box_shadow_box_shadow'] = ['horizontal' => 0, 'vertical' => 2, 'blur' => 10, 'spread' => 0, 'color' => 'rgba(15,23,42,.08)'];
        }
        return $out;
    }

    private function apply_elementor_geometry($model, $node, $parent_bbox) {
        $bbox = is_array($node['bbox'] ?? null) ? $node['bbox'] : null;
        if (!$bbox || !$parent_bbox || empty($parent_bbox['width']) || empty($parent_bbox['height'])) {
            return $model;
        }
        // Elementor 4.x control keys: containers use position/_offset_x/_offset_y/width,
        // widgets use _position/_offset_x/_offset_y and _element_width + _element_custom_width.
        // A wrong key is silently ignored, which is why items used to fall into normal flow.
        $container = $model['elType'] === 'container';
        $prefix = $container ? '' : '_';
        $model['settings'][$prefix . 'position'] = 'absolute';
        $model['settings']['_offset_x'] = [
            'unit' => 'px',
            'size' => round((float) ($bbox['x'] ?? 0) - (float) ($parent_bbox['x'] ?? 0), 2),
            'sizes' => [],
        ];
        $model['settings']['_offset_y'] = [
            'unit' => 'px',
            'size' => round((float) ($bbox['y'] ?? 0) - (float) ($parent_bbox['y'] ?? 0), 2),
            'sizes' => [],
        ];
        $width = [
            'unit' => 'px',
            'size' => max(1, round((float) ($bbox['width'] ?? 0), 2)),
            'sizes' => [],
        ];
        if ($container) {
            $model['settings']['width'] = $width;
        } else {
            $model['settings']['_element_width'] = 'initial';
            $model['settings']['_element_custom_width'] = $width;
        }
        if (($model['widgetType'] ?? '') === 'image') {
            // The picture fills its box like object-fit:cover does in the block output; without a height it keeps its own proportions.
            $model['settings']['width'] = ['unit' => '%', 'size' => 100, 'sizes' => []];
            $model['settings']['height'] = ['unit' => 'px', 'size' => max(1, round((float) ($bbox['height'] ?? 0), 2)), 'sizes' => []];
            $model['settings']['object-fit'] = 'cover';
        }
        if ($container) {
            $model['settings']['min_height'] = [
                'unit' => 'px',
                'size' => max(1, round((float) ($bbox['height'] ?? 0), 2)),
                'sizes' => [],
            ];
        }
        return $model;
    }

    // Forms are rendered whole from their schema (server-side) so they stay real <form>/<input> elements.
    private function serialize_component_block($node, $dimensions = null, $root_section = false) {
        $attributes = [
            'node' => $node,
            'dimensions' => $dimensions ?: new stdClass(),
            'rootSection' => (bool) $root_section,
        ];
        return '<!-- wp:page-generator/component ' . wp_json_encode($attributes, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' -->' . "\n"
            . '<!-- /wp:page-generator/component -->' . "\n";
    }

    private function render_node($node, $dimensions = null, $root_section = false, $inner_html = null) {
        $type = $node['type'] ?? 'container';
        $block_id = sanitize_html_class($node['id'] ?? wp_generate_uuid4());
        $block_attrs = ' data-block-id="' . esc_attr($block_id) . '" data-block-type="' . esc_attr($type) . '"';
        $children_nodes = !empty($node['children']) && is_array($node['children']) ? $node['children'] : ($node['elements'] ?? []);
        $node_style = is_array($node['style'] ?? null) ? $node['style'] : [];
        if ($type === 'image') {
            $url = $node['url'] ?? ($node['asset']['url'] ?? '');
            $image_style = $dimensions && !empty($node['bbox'])
                ? $this->render_box_position_style($node, $dimensions)
                : $this->render_position_style($node, $dimensions);
            if ($url) {
                return '<div class="page-generator-block page-generator-block-image"' . $block_attrs . ' style="' . esc_attr($image_style) . '">' . "\n" . '<img src="' . esc_url($url) . '" alt="' . esc_attr($node['alt'] ?? ($node['text'] ?? '')) . '" style="width:100%;height:100%;object-fit:cover;">' . "\n" . '</div>';
            }
            return '<div class="page-generator-block page-generator-block-image"' . $block_attrs . ' style="' . esc_attr($image_style) . '"><div class="page-generator-image-placeholder" aria-label="Detected image"></div></div>';
        }
        if ($type === 'icon') {
            $icon_style = ($dimensions && !empty($node['bbox']) ? $this->render_box_position_style($node, $dimensions) : '') . $this->render_surface_style($node);
            return '<span class="page-generator-block page-generator-icon"' . $block_attrs . ' aria-hidden="true" style="' . esc_attr($icon_style) . '"></span>';
        }
        if ($type === 'heading') {
            $text_style = $this->render_position_style($node, $dimensions);
            if (!empty($node_style['color'])) $text_style .= 'color:' . esc_attr($this->normalize_color($node_style['color'])) . ';';
            if (!empty($node_style['fontWeight'])) $text_style .= 'font-weight:' . absint($node_style['fontWeight']) . ';';
            $text_style .= $this->font_family_css($node_style);
            return '<h2 class="page-generator-block page-generator-block-heading"' . $block_attrs . ' style="' . esc_attr($text_style) . '">' . esc_html($node['text'] ?? ($node['content'] ?? '')) . '</h2>';
        }
        if ($type === 'text') {
            $text_style = $this->render_position_style($node, $dimensions);
            if (!empty($node_style['color'])) $text_style .= 'color:' . esc_attr($this->normalize_color($node_style['color'])) . ';';
            if (!empty($node_style['fontWeight'])) $text_style .= 'font-weight:' . absint($node_style['fontWeight']) . ';';
            $text_style .= $this->font_family_css($node_style);
            return '<p class="page-generator-block page-generator-block-text"' . $block_attrs . ' style="' . esc_attr($text_style) . '">' . nl2br(esc_html($node['text'] ?? ($node['content'] ?? ''))) . '</p>';
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
            $link_style = $this->render_position_style($node, $dimensions) . 'text-decoration:none;' . $this->render_surface_style(['style' => array_diff_key($node_style, ['background' => 1])]);
            return '<' . $tag . $href . ' class="page-generator-block page-generator-' . esc_attr($type) . '"' . $block_attrs . ' style="' . esc_attr($link_style) . '">' . esc_html($label) . '</' . $tag . '>';
        }
        if ($type === 'button') {
            $label = $node['text'] ?? ($node['content'] ?? '');
            return '<button type="button" class="page-generator-block page-generator-button-node"' . $block_attrs . ' style="' . esc_attr($this->render_control_style($node, $dimensions)) . '">' . esc_html($label) . '</button>';
        }
        if ($type === 'badge') {
            $label = $node['text'] ?? ($node['content'] ?? '');
            return '<span class="page-generator-block page-generator-badge"' . $block_attrs . ' style="' . esc_attr($this->render_control_style($node, $dimensions)) . '">' . esc_html($label) . '</span>';
        }
        if ($type === 'form-field') {
            $label = $node['label'] ?? '';
            $placeholder = $node['placeholder'] ?? '';
            $field_type = in_array($node['fieldType'] ?? '', ['email', 'phone', 'date', 'text', 'select', 'textarea', 'checkbox'], true) ? $node['fieldType'] : 'text';
            $height = !empty($node['bbox']['height']) ? max(20, absint($node['bbox']['height'])) : 0;
            // Controls are placed by their own box like every other node; without it they fall into the flow and drift.
            $position = $dimensions && !empty($node['bbox']) ? $this->render_box_position_style($node, $dimensions) : '';
            if ($field_type === 'checkbox') {
                return '<label class="page-generator-block page-generator-form-field"' . $block_attrs . ' style="' . esc_attr($position . 'display:flex;align-items:center;gap:' . $this->scaled_px(8) . ';') . '"><input type="checkbox"> ' . esc_html($label) . '</label>';
            }
            // Sizes follow the canvas like everything else: the caption from its measured box, the control text a little smaller.
            $caption_size = max(10, absint(round((float) ($node['labelBox']['height'] ?? 0) * 1.15))) ?: 12;
            $control_size = $this->font_size_css(max(10, min(14, $caption_size)), $dimensions);
            $control_style = 'font-size:' . $control_size . ';width:100%;box-sizing:border-box;margin:0;padding:0 ' . $this->scaled_px(12) . ';' . ($position ? 'height:100%;' : ($height ? 'min-height:' . $height . 'px;' : '')) . $this->render_surface_style($node) . 'border:1px solid #d5dde6;';
            $wrapper = '<label class="page-generator-block page-generator-form-field"' . $block_attrs . ' style="' . esc_attr(($position ?: 'position:relative;') . 'display:flex;flex-direction:column;margin:0;font-size:' . $this->font_size_css($caption_size, $dimensions) . ';') . '">';
            // The caption sits above the control, outside the control's own box.
            $caption = $label !== '' && $label !== 'Поле' ? '<span style="position:absolute;left:0;bottom:100%;margin-bottom:' . $this->scaled_px(6) . ';white-space:nowrap;">' . esc_html($label) . '</span>' : '';
            if ($field_type === 'select') {
                return $wrapper . $caption . '<select style="' . esc_attr($control_style) . '"><option>' . esc_html($placeholder) . '</option></select></label>';
            }
            if ($field_type === 'textarea') {
                return $wrapper . $caption . '<textarea placeholder="' . esc_attr($placeholder) . '" style="' . esc_attr($control_style . 'padding-top:12px;') . '"></textarea></label>';
            }
            $input_type = $field_type === 'phone' ? 'tel' : $field_type;
            return $wrapper . $caption . '<input type="' . esc_attr($input_type) . '" placeholder="' . esc_attr($placeholder) . '" style="' . esc_attr($control_style) . '"></label>';
        }
        if ($type === 'form') {
            $fields = '';
            $form_style = 'display:flex;flex-direction:column;gap:' . $this->scaled_px(16) . ';padding:' . $this->scaled_px(24) . ';box-sizing:border-box;';
            if ($dimensions && !empty($node['bbox'])) {
                $form_style = $this->render_box_position_style($node, $dimensions) . 'display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;padding:' . $this->scaled_px(24) . ';overflow:hidden;';
            }
            $form_style .= $this->render_surface_style(['style' => array_intersect_key($node_style, ['background' => 1, 'borderRadius' => 1])]);
            $has_submit = false;
            // Children carry canvas coordinates, so they are placed relative to the form's own box, which is its containing block.
            $form_dims = $dimensions && !empty($node['bbox']) ? [
                'width' => max(1, (float) ($node['bbox']['width'] ?? 1)),
                'height' => max(1, (float) ($node['bbox']['height'] ?? 1)),
                'offsetX' => (float) ($node['bbox']['x'] ?? 0),
                'offsetY' => (float) ($node['bbox']['y'] ?? 0),
                // cqw is relative to the whole canvas, so text inside the form is still sized against the page width.
                'fontWidth' => (float) ($dimensions['fontWidth'] ?? $dimensions['width'] ?? 0),
            ] : null;
            if ($inner_html !== null) {
                $fields = $inner_html;
            } else foreach ($children_nodes as $child) {
                if (($child['type'] ?? '') === 'button') {
                    $has_submit = true;
                    $button_position = $form_dims && !empty($child['bbox']) ? $this->render_box_position_style($child, $form_dims) : 'width:100%;';
                    $button_style = $button_position . $this->render_surface_style($child) . 'min-height:' . $this->scaled_px(max(36, absint($child['bbox']['height'] ?? 0))) . ';border:0;cursor:pointer;white-space:nowrap;font-size:' . $this->font_size_css(absint($child['style']['fontSize'] ?? 16), $dimensions) . ';';
                    $fields .= "\n" . '<button type="submit" class="page-generator-block page-generator-button-node" style="' . esc_attr($button_style) . '">' . esc_html($child['text'] ?? ($child['content'] ?? '')) . '</button>';
                    continue;
                }
                $fields .= "\n" . $this->render_node($child, $form_dims);
            }
            if (!$has_submit && $inner_html === null) {
                $fields .= "\n" . '<button type="submit" class="page-generator-button-node">Надіслати</button>';
            }
            return '<form class="page-generator-block page-generator-form"' . $block_attrs . ' style="' . esc_attr($form_style) . '">' . "\n" . $fields . "\n" . '</form>';
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
            $table_style = $dimensions && !empty($node['bbox']) ? $this->render_box_position_style($node, $dimensions) . 'height:auto;' : '';
            return '<table class="page-generator-block page-generator-table"' . $block_attrs . ($table_style ? ' style="' . esc_attr($table_style) . '"' : '') . '><tbody>' . $rows . '</tbody></table>';
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
                $child_dimensions['width'] = max(1, (float) ($node['bbox']['width'] ?? $dimensions['width']));
                $child_dimensions['height'] = max(1, (float) ($node['bbox']['height'] ?? $dimensions['height']));
                $child_dimensions['offsetX'] = (float) ($node['bbox']['x'] ?? 0);
                $child_dimensions['offsetY'] = (float) ($node['bbox']['y'] ?? 0);
            }
            if ($inner_html !== null) {
                $children = $inner_html;
            } else foreach ($children_nodes as $child) {
                $children .= "\n" . $this->render_node($child, $child_dimensions);
            }
            if ($type === 'card') {
                $background = $node_style['background'] ?? ($node['settings']['background'] ?? '#ffffff');
                $radius = $node_style['borderRadius'] ?? ($node['settings']['radius'] ?? 0);
                $style .= 'box-sizing:border-box;border-radius:' . absint($radius) . 'px;background:' . $this->normalize_color($background) . ';';
                if (!$dimensions) $style .= 'padding:16px;';
                if (!empty($node_style['borderColor'])) {
                    $style .= 'border:' . max(1, absint($node_style['borderWidth'] ?? 1)) . 'px solid ' . $this->normalize_color($node_style['borderColor']) . ';';
                }
                if (!empty($node_style['accentColor'])) {
                    $style .= 'border-left:' . max(1, absint($node_style['accentWidth'] ?? 4)) . 'px solid ' . $this->normalize_color($node_style['accentColor']) . ';';
                }
                if (!empty($node_style['shadow'])) $style .= 'box-shadow:0 2px 10px rgba(15,23,42,.08);';
            }
            return '<div class="page-generator-block page-generator-' . esc_attr($type) . '"' . $block_attrs . ' style="' . esc_attr($style) . '">' . "\n" . $children . "\n" . '</div>';
        }
        $source_width = absint($node['settings']['sourceWidth'] ?? 0);
        $source_height = absint($node['settings']['sourceHeight'] ?? 0);
        $style = 'display:flex;flex-direction:' . (($node['settings']['direction'] ?? 'column') === 'row' ? 'row' : 'column') . ';gap:' . absint($node['settings']['gap'] ?? 0) . 'px;';
        if ($dimensions && !empty($node['bbox'])) {
            $style = $this->render_box_position_style($node, $dimensions, $root_section);
            if ($root_section) $style .= 'overflow:hidden;';
            $style .= 'display:flex;flex-direction:' . (($node['settings']['direction'] ?? 'column') === 'row' ? 'row' : 'column') . ';gap:' . absint($node['settings']['gap'] ?? 0) . 'px;';
        } else {
            $style .= 'max-width:' . absint($this->settings()['default_container_width']) . 'px;margin:0 auto;';
        }
        $children = '';
        $child_dimensions = $dimensions ?: ($source_width && $source_height ? ['width' => $source_width, 'height' => $source_height] : null);
        if ($root_section && $child_dimensions) {
            $child_dimensions['width'] = max(1, (float) ($node['bbox']['width'] ?? $child_dimensions['width']));
            $child_dimensions['height'] = max(1, (float) ($node['bbox']['height'] ?? $child_dimensions['height']));
            $child_dimensions['offsetX'] = (float) ($node['bbox']['x'] ?? 0);
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

    private function render_surface_style($node) {
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $css = '';
        if (!empty($style['background'])) $css .= 'background:' . $this->normalize_color($style['background']) . ';';
        if (!empty($style['color'])) $css .= 'color:' . $this->normalize_color($style['color']) . ';';
        if (!empty($style['borderRadius'])) $css .= 'border-radius:' . absint($style['borderRadius']) . 'px;';
        if (!empty($style['fontWeight'])) $css .= 'font-weight:' . absint($style['fontWeight']) . ';';
        $css .= $this->font_family_css($style);
        return $css;
    }

    private function render_control_style($node, $dimensions) {
        $style = is_array($node['style'] ?? null) ? $node['style'] : [];
        $font_size = $style['fontSize'] ?? ($node['settings']['fontSize'] ?? 16);
        $position = $dimensions && !empty($node['bbox']) ? $this->render_box_position_style($node, $dimensions) : '';
        return $position . 'display:flex;align-items:center;justify-content:center;margin:0;padding:0 8px;border:0;white-space:nowrap;cursor:pointer;font-size:' . max(10, absint($font_size)) . 'px;' . $this->render_surface_style($node);
    }

    private function render_position_style($node, $dimensions) {
        $settings = $node['settings'] ?? [];
        $bbox = $node['bbox'] ?? [];
        $style = $node['style'] ?? [];
        $x = $settings['x'] ?? ($bbox['x'] ?? 0);
        $y = $settings['y'] ?? ($bbox['y'] ?? 0);
        $node_width_value = $settings['width'] ?? ($bbox['width'] ?? 0);
        $font_size = $style['fontSize'] ?? ($settings['fontSize'] ?? 16);
        if (!$dimensions || (!$bbox && !isset($settings['x']) && !isset($settings['y']))) return '';
        $width = max(1, absint($dimensions['width']));
        $height = max(1, absint($dimensions['height']));
        $left = $this->clamp_percent(((float) $x - (float) ($dimensions['offsetX'] ?? 0)) / $width * 100);
        $top = $this->clamp_percent(((float) $y - (float) ($dimensions['offsetY'] ?? 0)) / $height * 100);
        $node_width = $this->clamp_percent((float) $node_width_value / $width * 100, 1, 100);
        return 'position:absolute;left:' . $left . '%;top:' . $top . '%;width:' . max(1, $node_width) . '%;margin:0;font-size:' . $this->font_size_css($font_size, $dimensions) . ';line-height:1.2;white-space:nowrap;';
    }

    // Font sizes come from the screenshot in source pixels and scale with the canvas, like positions do.
    private function font_family_css($style) {
        return (($style['fontFamily'] ?? '') === 'serif') ? "font-family:Georgia,'Times New Roman',serif;" : '';
    }

    // A source-pixel length that scales with the canvas (--pg-k is one source pixel in screen pixels).
    private function scaled_px($pixels) {
        return 'calc(' . (0 + $pixels) . ' * var(--pg-k, 1px))';
    }

    private function font_size_css($font_size, $dimensions) {
        $source_width = (float) ($dimensions['fontWidth'] ?? $dimensions['width'] ?? 0);
        if ($source_width <= 0) return max(10, absint($font_size)) . 'px';
        $scaled = round(max(1, (float) $font_size) / $source_width * 100, 4);
        // No pixel floor: the whole canvas scales with its width, and a floor would make small text overlap on narrow screens.
        return $scaled . 'cqw';
    }

    private function render_box_position_style($node, $dimensions, $root_section = false) {
        $bbox = $node['bbox'] ?? [];
        $width = max(1, (float) ($dimensions['width'] ?? 1));
        $height = max(1, (float) ($dimensions['height'] ?? 1));
        $offset_x = $root_section ? 0 : (float) ($dimensions['offsetX'] ?? 0);
        $offset_y = $root_section ? 0 : (float) ($dimensions['offsetY'] ?? 0);
        $left = $this->clamp_percent((((float) ($bbox['x'] ?? 0) - $offset_x) / $width) * 100);
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
        if (!current_user_can('upload_files')) {
            wp_send_json_error('Недостатньо прав для завантаження медіафайлів.', 403);
        }
        if (empty($_FILES['asset'])) {
            wp_send_json_error('Файл не надійшов.');
        }
        $max_upload_mb = $this->settings()['max_upload_size_mb'];
        if (empty($_FILES['asset']['size']) || (int) $_FILES['asset']['size'] > $max_upload_mb * MB_IN_BYTES) {
            wp_send_json_error('Файл порожній або перевищує встановлений ліміт у ' . $max_upload_mb . ' MB.');
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
