(function ($) {
    'use strict';
    var analysisPromise = null;

    function registerEditorBlocks() {
        if (!PageGeneratorConfig.registerBlocks || !window.wp || !wp.blocks || !wp.element || !wp.blockEditor) return;
        var createElement = wp.element.createElement;
        var InnerBlocks = wp.blockEditor.InnerBlocks;
        [
            {
                name: 'page-generator/component',
                title: 'Page Generator component',
                attributes: {
                    node: { type: 'object' },
                    dimensions: { type: 'object' },
                    rootSection: { type: 'boolean', default: false }
                }
            },
            {
                name: 'page-generator/canvas',
                title: 'Page Generator canvas',
                attributes: {
                    width: { type: 'number', default: 0 },
                    height: { type: 'number', default: 0 }
                }
            }
        ].forEach(function (block) {
            if (wp.blocks.getBlockType(block.name)) return;
            wp.blocks.registerBlockType(block.name, {
                apiVersion: 2,
                title: block.title,
                category: 'design',
                attributes: block.attributes,
                supports: { html: false },
                edit: function (props) {
                    var node = props.attributes.node || {};
                    var label = String(node.text || node.content || node.label || '');
                    var type = node.type || (block.name === 'page-generator/canvas' ? 'canvas' : 'component');
                    var children = [
                        createElement('span', { className: 'page-generator-block-type', key: 'type' }, type)
                    ];
                    if (label) children.push(createElement('div', { className: 'page-generator-block-text', key: 'text' }, label));
                    children.push(createElement(InnerBlocks, { key: 'inner' }));
                    return createElement('div', {
                        className: 'page-generator-block-editor-preview is-' + String(type).replace(/[^a-z0-9-]/gi, '')
                    }, children);
                },
                save: function () {
                    return createElement(InnerBlocks.Content, null);
                }
            });
        });
    }

    registerEditorBlocks();

    function getNodeChildren(node) {
        if (node && Array.isArray(node.children) && node.children.length) return node.children;
        if (node && Array.isArray(node.elements)) return node.elements;
        return [];
    }

    function loadScreenshotEngines() {
        if (analysisPromise) return analysisPromise;
        analysisPromise = new Promise(function (resolve, reject) {
            var timeout = setTimeout(function () {
                reject(new Error('OCR/OpenCV не завантажилися за 45 секунд. Перевірте доступ до CDN або мережеві блокування.'));
            }, 45000);
            function finish(callback) {
                return function () {
                    clearTimeout(timeout);
                    callback.apply(this, arguments);
                };
            }
            function load(src, done) {
                var script = document.createElement('script');
                script.src = src;
                script.onload = done;
                script.onerror = finish(function () {
                    reject(new Error('Не вдалося завантажити ' + src));
                });
                document.head.appendChild(script);
            }

            if (window.Tesseract && window.cv) {
                finish(resolve)();
                return;
            }
            var waitForCv = function () {
                if (!window.cv) {
                    finish(reject)(new Error('OpenCV.js не ініціалізований.'));
                    return;
                }
                if (window.cv.getBuildInformation) {
                    finish(resolve)();
                    return;
                }
                window.cv.onRuntimeInitialized = finish(resolve);
            };
            var loadCv = function () {
                if (window.cv) { waitForCv(); return; }
                load('https://docs.opencv.org/4.8.0/opencv.js', waitForCv);
            };
            if (window.Tesseract) loadCv();
            else load('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js', loadCv);
        }).catch(function (error) {
            analysisPromise = null;
            throw error;
        });
        return analysisPromise;
    }

    // Splits a region (default: the whole page) into bands at vertical gaps between its elements.
    function deriveContentBands(elements, analysis, extent) {
        var from = extent ? extent.y : 0;
        var to = extent ? extent.y + extent.height : analysis.height;
        var boxes = (elements || []).map(function (node) {
            var box = node.bbox || node.settings || {};
            return { y: Number(box.y || 0), height: Number(box.height || 0) };
        }).filter(function (box) { return box.height > 0; }).sort(function (a, b) { return a.y - b.y; });
        if (boxes.length < 2) return [];
        var groups = [];
        boxes.forEach(function (box) {
            var last = groups[groups.length - 1];
            var lastBottom = last ? last.bottom : 0;
            // Real section gaps on 2x-wide captures are ~80–100 px (0.03 × width); 0.058 merged the whole page into one band.
            if (!last || box.y - lastBottom > Math.max(32, analysis.width * .025)) {
                groups.push({ top: box.y, bottom: box.y + box.height });
            } else {
                last.bottom = Math.max(last.bottom, box.y + box.height);
            }
        });
        if (groups.length < 2) return [];
        var bands = [];
        groups.forEach(function (group, index) {
            var previous = index ? groups[index - 1] : null;
            var next = groups[index + 1] || null;
            var y = previous ? Math.round((previous.bottom + group.top) / 2) : from;
            var bottom = next ? Math.round((group.bottom + next.top) / 2) : to;
            if (bottom - y >= analysis.width * .04) {
                bands.push({ y: y, height: bottom - y, background: sampleBandColor(analysis.canvas, y, bottom - y) });
            }
        });
        return bands;
    }

    // Band background = most common colour on its left and right edges (the page-wide palette hides a dark footer).
    function sampleBandColor(canvas, y, height) {
        if (!canvas || height <= 0) return '#ffffff';
        var context = canvas.getContext('2d', { willReadFrequently: true });
        var top = Math.max(0, Math.floor(y));
        var bottom = Math.min(canvas.height, Math.floor(y + height));
        var step = Math.max(1, Math.floor((bottom - top) / 40));
        var counts = {};
        for (var row = top; row < bottom; row += step) {
            [2, canvas.width - 3].forEach(function (column) {
                var pixel = context.getImageData(column, row, 1, 1).data;
                var key = (pixel[0] >> 3) + ',' + (pixel[1] >> 3) + ',' + (pixel[2] >> 3);
                counts[key] = counts[key] || { n: 0, rgb: [pixel[0], pixel[1], pixel[2]] };
                counts[key].n += 1;
            });
        }
        var best = Object.keys(counts).sort(function (a, b) { return counts[b].n - counts[a].n; })[0];
        return best ? normalizeHexColor(rgbToHex(counts[best].rgb), '#ffffff') : '#ffffff';
    }

    function openPageGenerator() {
        $('#page-generator-modal').remove();
        $('body').append(
            '<div id="page-generator-modal" class="page-generator-modal">' +
                '<div class="page-generator-panel">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center"><h2>Page Generator <small style="color:#94a3b8;font-size:11px">v' + (PageGeneratorConfig.build || 'unknown') + '</small></h2><button type="button" class="page-generator-close page-generator-button">Закрити</button></div>' +
                    '<div class="page-generator-tabs">' +
                        '<button type="button" class="page-generator-tab is-active" data-view="figma">Figma</button>' +
                        '<button type="button" class="page-generator-tab" data-view="screenshots">Скріншоти</button>' +
                        '<button type="button" class="page-generator-tab" data-view="settings">Налаштування</button>' +
                    '</div>' +
                    '<div class="page-generator-view is-active" data-view="figma">' +
                        '<label class="page-generator-field">Посилання на Figma<input id="pg-figma-url" type="url" placeholder="https://www.figma.com/design/..."></label>' +
                        '<button type="button" id="pg-scan-figma" class="page-generator-button page-generator-button-primary">Знайти фрейми</button>' +
                        '<label class="page-generator-field">Фрейми<select id="pg-figma-frames" multiple size="6"></select></label>' +
                        '<button type="button" id="pg-import-figma" class="page-generator-button page-generator-button-primary" disabled>Імпортувати структуру</button>' +
                    '</div>' +
                    '<div class="page-generator-view" data-view="screenshots">' +
                        '<div id="pg-dropzone" class="page-generator-dropzone" role="button" tabindex="0"><strong>Перетягніть сюди один або кілька скріншотів</strong><span>або натисніть, щоб вибрати файли</span><input id="pg-images" type="file" accept="image/*" multiple hidden></div>' +
                        '<div id="pg-file-roles" class="page-generator-file-roles"></div>' +
                        '<label class="page-generator-field">Опис поведінки та структури (необов’язково)<textarea id="pg-source-description" rows="6" placeholder="Наприклад: у верхньому меню є кнопка Категорії з випадаючим меню: техніка, товари для дому, будівельні матеріали та іграшки. Кнопка Про нас відкриває меню з FAQ та контактами."></textarea></label>' +
                        '<p class="page-generator-note">Опис не надсилається у зовнішні AI-сервіси. Плагін використовує локальний словник UI-компонентів і зберігає оригінальний текст у схемі.</p>' +
                        '<button type="button" id="pg-build-screenshot" class="page-generator-button page-generator-button-primary" disabled>Побудувати схему зі скріншотів</button>' +
                    '</div>' +
                    '<div class="page-generator-view" data-view="settings">' +
                        '<p class="page-generator-note">Швидкі налаштування зберігаються на сервері й застосовуються до наступних імпортів.</p>' +
                        '<label class="page-generator-field">Figma Personal Access Token<input id="pg-settings-token" type="password" autocomplete="off" placeholder="Вставте token, якщо потрібно змінити"><span class="page-generator-note" id="pg-token-status"></span></label>' +
                        '<div class="page-generator-settings-grid">' +
                            '<label class="page-generator-field">Термін token (днів)<input id="pg-settings-token-days" type="number" min="1" max="3650" value="' + (PageGeneratorConfig.tokenTotalDays || 90) + '"></label>' +
                            '<label class="page-generator-field">Ширина контейнера (px)<input id="pg-settings-width" type="number" min="320" max="2400" value="' + (PageGeneratorConfig.containerWidth || 1200) + '"></label>' +
                        '</div>' +
                        '<label class="page-generator-field">Мови OCR<input id="pg-settings-ocr" type="text"></label>' +
                        '<button type="button" id="pg-save-settings" class="page-generator-button page-generator-button-primary">Зберегти швидкі налаштування</button>' +
                    '</div>' +
                    '<div id="pg-output-actions" style="display:none;margin-top:12px"><button type="button" id="pg-create-page" class="page-generator-button page-generator-button-primary">Оновити поточну WordPress Page</button> <button type="button" id="pg-insert-elementor" class="page-generator-button">Вставити в Elementor</button></div>' +
                    '<div id="pg-schema-preview" class="page-generator-schema-preview" style="display:none"><strong>Дерево сторінки</strong><pre id="pg-schema-tree"></pre></div>' +
                    '<div id="pg-schema-editor" class="page-generator-schema-editor" style="display:none"><label class="page-generator-field">Редагування Page Schema<textarea id="pg-schema-json" rows="10"></textarea></label><button type="button" id="pg-apply-schema" class="page-generator-button">Застосувати зміни дерева</button></div>' +
                    '<div id="pg-status" class="page-generator-status"></div>' +
                '</div>' +
            '</div>'
        );
        $('#pg-settings-ocr').val(PageGeneratorConfig.ocrLanguages || 'ukr+eng');
        if (!PageGeneratorConfig.canManageSettings) {
            $('.page-generator-tab[data-view="settings"], .page-generator-view[data-view="settings"]').remove();
        }
        if (!PageGeneratorConfig.canUploadFiles) {
            $('.page-generator-tab[data-view="screenshots"], .page-generator-view[data-view="screenshots"]').remove();
        }
        bindModal();
        if (PageGeneratorConfig.tokenConfigured) {
            $('#pg-token-status').text('Token уже збережений; нове поле змінить його. Дійсний до ' + PageGeneratorConfig.tokenExpiresAt + '.');
        } else {
            $('#pg-token-status').text('Token ще не налаштований.');
        }
    }

    function bindModal() {
        $('.page-generator-close').on('click', function () { $('#page-generator-modal').remove(); });
        $('.page-generator-tab').on('click', function () {
            $('.page-generator-tab').removeClass('is-active');
            $(this).addClass('is-active');
            $('.page-generator-view').removeClass('is-active');
            $('.page-generator-view[data-view="' + $(this).data('view') + '"]').addClass('is-active');
        });
        $('#pg-scan-figma').on('click', scanFigma);
        $('#pg-import-figma').on('click', importFigma);
        $('#pg-images').on('change', uploadImages);
        $('#pg-dropzone').on('click', function (event) {
            if (event.target !== this && !$(event.target).is('strong, span')) return;
            $('#pg-images').trigger('click');
        });
        $('#pg-dropzone').on('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                $('#pg-images').trigger('click');
            }
        });
        $('#pg-dropzone').on('dragenter dragover', function (event) {
            event.preventDefault();
            event.stopPropagation();
            $(this).addClass('is-dragover');
        });
        $('#pg-dropzone').on('dragleave', function (event) {
            if (event.target === this) $(this).removeClass('is-dragover');
        });
        $('#pg-dropzone').on('drop', function (event) {
            event.preventDefault();
            event.stopPropagation();
            $(this).removeClass('is-dragover');
            var files = event.originalEvent.dataTransfer.files;
            if (files && files.length) processSelectedFiles(files);
        });
        $('#pg-create-page').on('click', createPage);
        $('#pg-apply-schema').on('click', applySchemaEdits);
        $('#pg-insert-elementor').on('click', insertIntoElementor);
        $('#pg-build-screenshot').on('click', buildScreenshotSchema);
        $('#pg-save-settings').on('click', saveSettings);
    }

    function request(action, data) {
        data.action = action;
        data.nonce = PageGeneratorConfig.nonce;
        return $.post(PageGeneratorConfig.ajaxUrl, data);
    }

    function saveSettings() {
        $('#pg-status').text('Збереження налаштувань...');
        request('page_generator_save_settings', {
            figmaToken: $('#pg-settings-token').val(),
            figmaTokenTotalDays: $('#pg-settings-token-days').val(),
            ocrLanguages: $('#pg-settings-ocr').val(),
            defaultContainerWidth: $('#pg-settings-width').val()
        }).done(function (response) {
            if (!response.success) {
                $('#pg-status').text(response.data || 'Не вдалося зберегти налаштування.');
                return;
            }
            $('#pg-settings-token').val('');
            PageGeneratorConfig.tokenConfigured = response.data.tokenConfigured;
            PageGeneratorConfig.tokenExpiresAt = response.data.tokenExpiresAt;
            PageGeneratorConfig.tokenTotalDays = response.data.tokenTotalDays;
            PageGeneratorConfig.ocrLanguages = response.data.ocrLanguages;
            PageGeneratorConfig.containerWidth = response.data.containerWidth;
            $('#pg-status').text(response.data.tokenConfigured
                ? 'Налаштування збережено. Token дійсний до ' + response.data.tokenExpiresAt + '.'
                : 'Налаштування збережено без Figma token.');
        }).fail(function () {
            $('#pg-status').text('Не вдалося виконати запит збереження.');
        });
    }

    function scanFigma() {
        $('#pg-status').text('Сканування Figma...');
        request('page_generator_scan_figma', { url: $('#pg-figma-url').val() })
            .done(function (response) {
                if (!response.success) { $('#pg-status').text(response.data || 'Помилка Figma.'); return; }
                var $select = $('#pg-figma-frames').empty().data('file-key', response.data.fileKey);
                response.data.frames.forEach(function (frame) {
                    $select.append($('<option>').val(frame.id).text(frame.page_name + ' / ' + frame.name));
                });
                $('#pg-import-figma').prop('disabled', response.data.frames.length === 0);
                $('#pg-status').text('Знайдено фреймів: ' + response.data.frames.length);
            }).fail(function () { $('#pg-status').text('Не вдалося виконати AJAX-запит.'); });
    }

    function importFigma() {
        var ids = $('#pg-figma-frames').val() || [];
        $('#pg-status').text('Імпорт структури...');
        request('page_generator_import_figma', {
            fileKey: $('#pg-figma-frames').data('file-key'),
            nodeIds: ids.join(',')
        }).done(function (response) {
            if (!response.success) { $('#pg-status').text(response.data || 'Помилка імпорту.'); return; }
            $('#page-generator-modal').data('schema', response.data.page);
            $('#pg-output-actions').show();
            $('#pg-status').text('Схему імпортовано. Оберіть спосіб виводу.');
        }).fail(function () { $('#pg-status').text('Не вдалося виконати імпорт.'); });
    }

    function createPage() {
        var schema = $('#page-generator-modal').data('schema');
        if (!schema || !Array.isArray(schema.sections) || !schema.sections.length) {
            $('#pg-status').text('Немає готової схеми для створення сторінки.');
            return;
        }
        var $button = $('#pg-create-page');
        var postId = getCurrentPostId();
        if (!postId) {
            $('#pg-status').text('Не знайдено ID поточної WordPress Page.');
            return;
        }
        $button.prop('disabled', true);
        $('#pg-status').text('Оновлення поточної WordPress Page...');
        request('page_generator_create_page', {
            postId: postId,
            title: schema.title,
            schema: JSON.stringify(schema),
            editorMode: window.elementor ? 'elementor' : 'gutenberg'
        }).done(function (response) {
            if (!response.success) {
                $('#pg-status').text(response.data || 'WordPress не оновив поточну Page.');
                return;
            }
            if (response.data.mode !== 'update-current-page') {
                $('#pg-status').text('Сервер повернув неправильний режим: нове створення Page заборонено.');
                return;
            }
            $('#pg-status').html('Поточну WordPress Page оновлено як ' + response.data.status + '. Режим: ' + (response.data.outputMode || 'gutenberg') + '. Блоків: ' + (response.data.blockCount || 0) + '. Рендер: ' + response.data.renderLength + ' символів' + (response.data.elementorMode ? ' (native Elementor tree; HTML fallback лише для складних вузлів)' : '') + '.<br>Порівняння screenshot через Playwright...');
            compareRenderedPage(response.data.compareUrl || response.data.viewUrl, schema, postId).then(function (result) {
                $('#page-generator-modal').data('schema', schema);
                $('#pg-status').html('Page оновлено.<br><br>Візуальна відповідність: <strong>' + result.visualSimilarity.toFixed(2) + '%</strong><br>Перцептивна відповідність: <strong>' + Number(result.perceptualSimilarity || 0).toFixed(2) + '%</strong><br>Змістова відповідність: <strong>' + Number(result.contentSimilarity || 0).toFixed(2) + '%</strong>' + (result.worstZone ? ' <span class="page-generator-note">(найгірша зона: колонка ' + (result.worstZone.column + 1) + ', рядок ' + (result.worstZone.row + 1) + ' — ' + Number(result.worstZone.similarity).toFixed(0) + '%)</span>' : '') + '<br>Текстова відповідність: <strong>' + result.textSimilarity.toFixed(2) + '%</strong><br>DOM-відповідність: <strong>' + result.domSimilarity.toFixed(2) + '%</strong><br><span class="page-generator-note">Reference: ' + result.referenceSize + ', rendered: ' + result.renderedSize + ', tokens: ' + result.sourceTokenCount + ' → ' + result.renderedTokenCount + ', nodes: ' + result.sourceNodeCount + ' → ' + result.renderedNodeCount + '.</span>' + (result.renderedUrl ? '<br><a href="' + result.renderedUrl + '" target="_blank" rel="noopener">Відкрити rendered screenshot</a>' : '') + (result.diffUrl ? '<br><a href="' + result.diffUrl + '" target="_blank" rel="noopener">Відкрити diff screenshot</a>' : '') + '<br><br>Найбільші розбіжності:<br>' + (result.differences.length ? result.differences.map(function (item) { return '- ' + item; }).join('<br>') : '- не виявлено') + '<br><br><button type="button" id="pg-finish" class="page-generator-button page-generator-button-primary">Готово</button>');
                $('#pg-finish').on('click', function () { $('#page-generator-modal').remove(); });
            }).catch(function (error) {
                var updated = 'Поточну WordPress Page оновлено як ' + response.data.status + '.<br>Screenshot-порівняння не виконано: ' + error.message;
                var finish = '<br><button type="button" id="pg-finish" class="page-generator-button page-generator-button-primary">Готово</button>';
                $('#pg-status').html(updated + '<br>DOM-порівняння в браузері...');
                compareInBrowser(response.data.compareUrl || response.data.viewUrl, schema).then(function (result) {
                    $('#pg-status').html(updated + '<br><br>DOM-відповідність (без Playwright): <strong>' + result.score + '%</strong><br><span class="page-generator-note">' + result.details + '</span>' + finish);
                }).catch(function (domError) {
                    $('#pg-status').html(updated + '<br>DOM-порівняння теж не виконано: ' + domError.message + finish);
                }).then(function () {
                    $('#pg-finish').on('click', function () { $('#page-generator-modal').remove(); });
                });
            });
        }).fail(function (xhr) {
            var message = 'AJAX-запит оновлення поточної Page не виконано.';
            if (xhr.responseJSON && xhr.responseJSON.data) message += ' ' + xhr.responseJSON.data;
            else if (xhr.responseText) message += ' Сервер повернув неочікувану відповідь.';
            $('#pg-status').text(message);
        }).always(function () {
            $button.prop('disabled', false);
        });
    }

    function getCurrentPostId() {
        if (PageGeneratorConfig.currentPostId) return Number(PageGeneratorConfig.currentPostId);
        if (window.elementor && window.elementor.documents && window.elementor.documents.getCurrent) {
            var document = window.elementor.documents.getCurrent();
            if (document && document.id) return Number(document.id);
            if (document && document.model && document.model.id) return Number(document.model.id);
        }
        if (window.elementor && window.elementor.config && window.elementor.config.document && window.elementor.config.document.id) {
            return Number(window.elementor.config.document.id);
        }
        return 0;
    }

    function compareRenderedPage(url, schema, postId) {
        var section = schema.sections && schema.sections[0];
        var source = section && section.source ? section.source : {};
        var width = section && section.settings ? Number(section.settings.sourceWidth || 0) : 0;
        var height = section && section.settings ? Number(section.settings.sourceHeight || 0) : 0;
        if (!url || (!source.url && !source.attachmentId) || !width || !height) {
            return Promise.reject(new Error('Для Playwright-порівняння потрібні URL сторінки, reference image та його розміри. Отримано: URL=' + (url ? 'так' : 'ні') + ', reference=' + ((source.url || source.attachmentId) ? 'так' : 'ні') + ', розмір=' + (width && height ? width + 'x' + height : 'відсутній') + '.'));
        }
        return request('page_generator_compare_page', {
            postId: postId,
            url: url,
            sourceUrl: source.url,
            sourceAttachmentId: source.attachmentId || 0,
            schema: JSON.stringify(schema),
            width: width,
            height: height
        }).then(function (response) {
            if (!response.success) throw new Error(response.data || 'Playwright не виконав порівняння.');
            return response.data;
        }, function (xhr) {
            // jQuery rejects with the XHR object, not an Error: without this the status line shows "undefined".
            var reason = xhr && xhr.responseJSON && xhr.responseJSON.data ? xhr.responseJSON.data : (xhr && xhr.status ? 'HTTP ' + xhr.status + (xhr.statusText ? ' ' + xhr.statusText : '') : 'мережева помилка або запит перервано');
            throw new Error('Запит порівняння не пройшов: ' + reason);
        });
    }

    // Fallback when the Playwright runner is unavailable: loads the same-origin preview in a hidden frame and scores its DOM.
    function compareInBrowser(url, schema) {
        return new Promise(function (resolve, reject) {
            if (!url) {
                reject(new Error('Немає URL сторінки.'));
                return;
            }
            var section = schema.sections && schema.sections[0];
            var width = Number(section && section.settings && section.settings.sourceWidth) || Number(schema.containerWidth) || 1200;
            var frame = document.createElement('iframe');
            var timeout = setTimeout(function () { done(new Error('Сторінка не завантажилася за 30 секунд.')); }, 30000);
            function done(error, result) {
                clearTimeout(timeout);
                frame.remove();
                if (error) reject(error); else resolve(result);
            }
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + width + 'px;height:900px;border:0;';
            frame.onload = function () {
                try {
                    var doc = frame.contentDocument;
                    if (!doc || !doc.body) {
                        // Usually the preview opened on another origin (scheme, host or port differ from this admin page).
                        var frameOrigin = '';
                        try { frameOrigin = frame.contentWindow.location.origin; } catch (ignored) { frameOrigin = 'невідомо'; }
                        throw new Error('Немає доступу до документа сторінки (сторінка відкрилась з ' + frameOrigin + ', адмінка з ' + window.location.origin + ').');
                    }
                    var root = doc.querySelector('[data-page-generator="canvas"], .page-generator-canvas');
                    if (!root) throw new Error('Полотно Page Generator на сторінці не знайдено.');
                    done(null, compareDomFeatures(root, schema));
                } catch (error) {
                    done(error);
                }
            };
            frame.src = url;
            document.body.appendChild(frame);
        });
    }

    function compareDomFeatures(body, schema) {
        var sourceText = [];
        var sourceRegions = 0;
        var sourceColors = schema.tokens && schema.tokens.colors ? schema.tokens.colors : [];
        var collectText = function (nodes) {
            (nodes || []).forEach(function (node) {
                if (node.text || node.content) sourceText.push(node.text || node.content);
                collectText(getNodeChildren(node));
            });
        };
        (schema.sections || []).forEach(function (section) {
            sourceRegions += (section.detectedRegions || []).length;
            collectText(getNodeChildren(section));
        });
        var renderedText = body.innerText || '';
        var sourceTokens = tokenize(sourceText.join(' '));
        var renderedTokens = tokenize(renderedText);
        var textScore = overlapScore(sourceTokens, renderedTokens);
        var domTree = extractDomTree(body);
        var renderedElements = body.querySelectorAll('section, h1, h2, h3, h4, p, img, button, a, table, form, input, select, textarea');
        var elementCount = renderedElements.length;
        var regionScore = sourceRegions ? Math.min(1, elementCount / sourceRegions) : (elementCount ? 1 : 0);
        var colorScore = compareRenderedColors(renderedElements, sourceColors);
        var score = Math.round((textScore * 55) + (regionScore * 25) + (colorScore * 20));
        return {
            score: Math.min(100, score),
            details: 'DOM-вузлів ' + domTree.length + ', текст ' + Math.round(textScore * 100) + '%, структура ' + Math.round(regionScore * 100) + '%, кольори ' + Math.round(colorScore * 100) + '%'
        };
    }

    function extractDomTree(root) {
        var nodes = [];
        function visit(element, depth) {
            if (depth > 8 || !element || element.nodeType !== 1) return;
            var text = (element.childElementCount === 0 ? (element.textContent || '') : '').trim().slice(0, 160);
            var rect = element.getBoundingClientRect();
            nodes.push({
                tag: element.tagName.toLowerCase(),
                depth: depth,
                text: text,
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            });
            Array.prototype.forEach.call(element.children, function (child) {
                visit(child, depth + 1);
            });
        }
        visit(root, 0);
        return nodes;
    }

    function tokenize(value) {
        return value.toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi, ' ').trim().split(/\s+/).filter(Boolean);
    }

    function overlapScore(source, rendered) {
        if (!source.length) return rendered.length ? 0 : 1;
        var renderedSet = {};
        rendered.forEach(function (token) { renderedSet[token] = true; });
        var matches = source.filter(function (token) { return renderedSet[token]; }).length;
        return matches / source.length;
    }

    function compareRenderedColors(elements, sourceColors) {
        if (!sourceColors.length || !elements.length) return sourceColors.length ? 0 : 1;
        var renderedColors = {};
        Array.prototype.forEach.call(elements, function (element) {
            var styles = element.ownerDocument.defaultView.getComputedStyle(element);
            renderedColors[normalizeColor(styles.color)] = true;
            renderedColors[normalizeColor(styles.backgroundColor)] = true;
            renderedColors[normalizeColor(styles.borderColor)] = true;
        });
        var matches = sourceColors.filter(function (color) {
            return renderedColors[normalizeColor(color)];
        }).length;
        return matches / sourceColors.length;
    }

    function normalizeColor(color) {
        var value = String(color || '').replace(/\s+/g, '').toLowerCase();
        var hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
            var raw = hex[1].length === 3 ? hex[1].split('').map(function (part) { return part + part; }).join('') : hex[1];
            return 'rgb(' + parseInt(raw.slice(0, 2), 16) + ',' + parseInt(raw.slice(2, 4), 16) + ',' + parseInt(raw.slice(4, 6), 16) + ')';
        }
        return value.replace(/^rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)$/, 'rgb($1,$2,$3)');
    }

    function insertIntoElementor() {
        var schema = $('#page-generator-modal').data('schema');
        var root = window.elementor && window.elementor.documents && window.elementor.documents.getCurrent
            ? window.elementor.documents.getCurrent().container : null;
        if (!schema || !root || !window.$e || !window.$e.run) {
            $('#pg-status').text('Активний контейнер Elementor не знайдено.');
            return;
        }
        $('#pg-status').text('Підготовка схеми для Elementor...');
        request('page_generator_elementor_tree', { schema: JSON.stringify(schema), postId: getCurrentPostId() || 0 })
            .done(function (response) {
                if (!response.success) {
                    $('#pg-status').text(response.data || 'Не вдалося підготувати схему для Elementor.');
                    return;
                }
                Promise.all(response.data.models.map(function (model) {
                    return window.$e.run('document/elements/create', { container: root, model: model });
                })).then(function () {
                    $('#pg-status').text('Схему вставлено в Elementor.');
                }).catch(function () {
                    $('#pg-status').text('Не вдалося вставити схему в Elementor.');
                });
            }).fail(function () { $('#pg-status').text('Не вдалося виконати запит для Elementor.'); });
    }

    function randomId() {
        return Math.random().toString(36).slice(2, 9);
    }

    function uploadImages(event) {
        processSelectedFiles(event.target.files || []);
    }

    function processSelectedFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
            return file.type.indexOf('image/') === 0;
        });
        if (!files.length) return;
        var completed = 0;
        var failed = 0;
        var uploaded = [];
        $('#pg-status').text('Завантаження assets: 0/' + files.length);
        files.forEach(function (file) {
            var form = new FormData();
            form.append('action', 'page_generator_upload_asset');
            form.append('nonce', PageGeneratorConfig.nonce);
            form.append('asset', file, file.name);
            $.ajax({ url: PageGeneratorConfig.ajaxUrl, method: 'POST', data: form, processData: false, contentType: false })
                .done(function (response) {
                    if (response.success) uploaded.push({ file: file, data: response.data });
                    else failed += 1;
                })
                .fail(function () { failed += 1; })
                .always(function () {
                    completed += 1;
                    $('#pg-status').text('Завантаження assets: ' + completed + '/' + files.length);
                    if (completed === files.length) {
                        $('#page-generator-modal').data('uploaded-images', uploaded);
                        renderFileRoles(uploaded);
                        $('#pg-build-screenshot').prop('disabled', uploaded.length === 0);
                        if (failed) {
                            $('#pg-status').text('Завантажено ' + uploaded.length + ' з ' + files.length + ' файлів; не вдалося завантажити ' + failed + '. Перевірте тип, розмір файлів і права на медіафайли.');
                        }
                    }
                });
        });
    }

    // Each uploaded file is either a section of the page (screenshots stack, as before) or the page's mobile layout. "Авто" calls a
    // file mobile when it is clearly narrower than the others.
    function renderFileRoles(uploaded) {
        var $box = $('#pg-file-roles').empty();
        if (uploaded.length < 2) return;
        uploaded.forEach(function (item, index) {
            item.role = item.role || 'auto';
            var $select = $('<select>')
                .append($('<option value="auto">').text('Авто'))
                .append($('<option value="desktop">').text('Секція сторінки'))
                .append($('<option value="mobile">').text('Мобільний макет'))
                .val(item.role)
                .on('change', function () { uploaded[index].role = $(this).val(); });
            $box.append($('<label class="page-generator-field">').text(item.file.name + ' — ').append($select));
        });
    }

    function splitByBreakpoint(analyses, uploaded) {
        var widest = Math.max.apply(null, analyses.map(function (item) { return item.width; }));
        var desktop = [];
        var mobile = [];
        analyses.forEach(function (analysis, index) {
            var role = (uploaded[index] && uploaded[index].role) || 'auto';
            var narrow = analyses.length > 1 && analysis.width <= widest * .6;
            (role === 'mobile' || (role === 'auto' && narrow) ? mobile : desktop).push(analysis);
        });
        // Only mobile screenshots: there is nothing to pair them with, so they are an ordinary page.
        return desktop.length ? { desktop: desktop, mobile: mobile } : { desktop: mobile, mobile: [] };
    }

    function buildScreenshotSchema() {
        var uploaded = $('#page-generator-modal').data('uploaded-images') || [];
        if (!uploaded.length) return;
        $('#pg-build-screenshot').prop('disabled', true);
        $('#pg-status').text('Завантаження OCR/OpenCV...');
        loadScreenshotEngines().then(function () {
            return Promise.all(uploaded.map(function (item) {
                return analyzeScreenshot(item.file, item.data);
            }));
        }).then(function (analyses) {
            var split = splitByBreakpoint(analyses, uploaded);
            var schema = buildScreenshotPageSchema(split.desktop, $('#pg-source-description').val());
            if (split.mobile.length) {
                // The mobile screenshots become a second layout of the same page, shown below the mobile breakpoint.
                schema.variants = { mobile: { sections: buildScreenshotPageSchema(split.mobile, $('#pg-source-description').val()).sections } };
            }
            return uploadBackdrops(schema).then(function () { return { schema: schema, analyses: analyses }; });
        }).then(function (built) {
            var schema = built.schema, analyses = built.analyses;
            $('#page-generator-modal').data('schema', schema);
            $('#pg-output-actions').show();
            $('#pg-schema-tree').text(formatSchemaTree(schema));
            $('#pg-schema-preview').show();
            $('#pg-schema-json').val(JSON.stringify(schema, null, 2));
            $('#pg-schema-editor').show();
            var nodeStats = getSchemaNodeStats(schema);
            var resolutionAdvice = [];
            analyses.forEach(function (item) {
                window.PageGeneratorDetectors.assessResolution(item.width, item.words).forEach(function (line) {
                    resolutionAdvice.push((analyses.length > 1 && item.file ? item.file.name + ': ' : '') + line);
                });
            });
            var advice = resolutionAdvice.length ? '<br><span class="page-generator-warning">' + resolutionAdvice.map(function (line) { return $('<div>').text(line).html(); }).join('<br>') + '</span>' : '';
            var warning = advice + (nodeStats.unclassified ? '<br><span class="page-generator-warning">Не класифіковано: ' + nodeStats.unclassified + ' регіонів. Це ще не повне дерево.</span>' : '');
            $('#pg-status').html('Аналіз завершено по етапах: геометрія → секції → семантика → стилі → assets.<br>OCR-слів: ' + analyses.reduce(function (total, item) { return total + item.words.length; }, 0) + ', нормалізованих областей: ' + analyses.reduce(function (total, item) { return total + item.boxes.length; }, 0) + ', вузлів у дереві: ' + nodeStats.total + ', класифікованих: ' + nodeStats.classified + '.' + warning + '<br><span class="page-generator-note">Таблиця: ' + nodeStats.tables + ', форма: ' + nodeStats.forms + ', кнопки: ' + nodeStats.buttons + ', фото: ' + nodeStats.images + ', невпевнені вузли: ' + nodeStats.lowConfidence + '.</span>');
        }).catch(function (error) {
            $('#pg-status').text('Помилка аналізу: ' + error.message);
        }).finally(function () {
            $('#pg-build-screenshot').prop('disabled', false);
        });
    }

    // Each detected backdrop grid is painted into a smooth picture (the grid is bilinearly stretched), uploaded, and replaced by its URL.
    function uploadBackdrops(schema) {
        var targets = [];
        var collect = function (sections) {
            (sections || []).forEach(function (section) {
                if (section.style && section.style.backdrop) targets.push(section);
            });
        };
        collect(schema.sections);
        if (schema.variants && schema.variants.mobile) collect(schema.variants.mobile.sections);
        return Promise.all(targets.map(function (section, index) {
            var grid = section.style.backdrop;
            delete section.style.backdrop;
            return new Promise(function (resolve) {
                var small = document.createElement('canvas');
                small.width = grid.cols;
                small.height = grid.rows;
                var context = small.getContext('2d');
                var image = context.createImageData(grid.cols, grid.rows);
                for (var i = 0; i < grid.cols * grid.rows; i += 1) {
                    image.data[i * 4] = grid.pixels[i * 3];
                    image.data[i * 4 + 1] = grid.pixels[i * 3 + 1];
                    image.data[i * 4 + 2] = grid.pixels[i * 3 + 2];
                    image.data[i * 4 + 3] = 255;
                }
                context.putImageData(image, 0, 0);
                var width = Math.min(960, Math.round(section.bbox.width / 2)), height = Math.max(8, Math.round(width * section.bbox.height / section.bbox.width));
                var out = document.createElement('canvas');
                out.width = width;
                out.height = height;
                var ctx = out.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.filter = 'blur(' + Math.max(2, Math.round(grid.cell / 4)) + 'px)';
                ctx.drawImage(small, -grid.cell / 2, -grid.cell / 2, width + grid.cell, height + grid.cell);
                out.toBlob(function (blob) {
                    if (!blob) { resolve(); return; }
                    var form = new FormData();
                    form.append('action', 'page_generator_upload_asset');
                    form.append('nonce', PageGeneratorConfig.nonce);
                    form.append('asset', blob, 'detected-backdrop-' + index + '.jpg');
                    $.ajax({ url: PageGeneratorConfig.ajaxUrl, method: 'POST', data: form, processData: false, contentType: false })
                        .done(function (response) {
                            if (response.success) section.style.backgroundImage = { url: response.data.url, attachmentId: response.data.id };
                            resolve();
                        })
                        .fail(function () { resolve(); });
                }, 'image/jpeg', .9);
            });
        }));
    }

    function analyzeScreenshot(file, uploadedData) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(new Error('Не вдалося прочитати ' + file.name)); };
            reader.onload = function () {
                var image = new Image();
                image.onerror = function () { reject(new Error('Файл не є коректним зображенням.')); };
                image.onload = function () {
                    var canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    var context = canvas.getContext('2d', { willReadFrequently: true });
                    context.drawImage(image, 0, 0);
                    var pixelData = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    var surfaces = window.PageGeneratorDetectors.classifySurfaces(
                        window.PageGeneratorDetectors.detectSurfaces(pixelData, canvas.width, canvas.height),
                        canvas.width, pixelData, canvas.height
                    );
                    Promise.all([
                        recognizeScreenshot(canvas),
                        detectScreenshotRegions(canvas)
                    ]).then(function (results) {
                        return recognizePlates(canvas, surfaces, results[0]).then(function (extraWords) {
                            results[0] = results[0].concat(extraWords);
                            return results;
                        });
                    }).then(function (results) {
                        results[0] = results[0].filter(function (word) { return !window.PageGeneratorDetectors.isRuleWord(word); });
                        mergePhotoRegions(canvas, results[1], window.PageGeneratorDetectors.detectPhotoRegions(pixelData, canvas.width, canvas.height, results[0]));
                        var softBoxes = dropSoftBackdropPhotos(pixelData, canvas, results[1], results[0], surfaces);
                        return recognizeOverBackdrop(canvas, softBoxes, results[0]).then(function (extra) {
                            results[0] = results[0].concat(extra);
                            return results;
                        });
                    }).then(function (results) {
                        var found = window.PageGeneratorDetectors.findIcons(pixelData, canvas.width, canvas.height, results[0]);
                        results[0] = results[0].filter(function (word) { return found.droppedWords.indexOf(word) === -1; });
                        var iconCandidates = found.icons.filter(function (icon) {
                            // The blob is the plate itself (a small button or badge), not a picture on it.
                            var isPlate = surfaces.some(function (surface) {
                                return ['button', 'badge', 'input'].indexOf(surface.kind) !== -1 && boxOverlapRatio(icon, surface) > .6;
                            });
                            return !isPlate && !results[1].boxes.some(function (photo) {
                                return photo.kind === 'photo-candidate' && photo.width > 150 && photo.height > 150 && centerInside(icon, photo);
                            });
                        });
                        return uploadIconCrops(canvas, iconCandidates).then(function (icons) {
                            results.icons = icons;
                            return results;
                        });
                    }).then(function (results) {
                        return uploadDetectedCrops(canvas, results[1].boxes).then(function (assets) {
                            results[1].boxes.forEach(function (box, index) { if (assets[index]) box.asset = assets[index]; });
                            resolve({
                            icons: results.icons || [],
                            file: file,
                            data: uploadedData,
                            width: canvas.width,
                            height: canvas.height,
                            words: results[0],
                            boxes: results[1].boxes,
                            surfaces: surfaces,
                            sections: results[1].sections,
                            colors: results[1].colors,
                            canvas: canvas
                            });
                        });
                    }).catch(reject);
                };
                image.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    // A busy gradient (mesh, glow) with a headline on it looks like a picture to the contour pass, and its text would be baked into a cropped image.
    // A "photo" whose background, with the words taken out, is a smooth soft backdrop is no photo: it stays a background and its text stays text.
    function dropSoftBackdropPhotos(pixelData, canvas, regionResult, words, surfaces) {
        var tools = window.PageGeneratorDetectors;
        var dropped = [];
        var rects = (words || []).concat((surfaces || []).filter(function (surface) { return ['button', 'badge', 'input'].indexOf(surface.kind) !== -1; })).map(function (word) { return { x: word.x - 6, y: word.y - 6, width: word.width + 12, height: word.height + 12 }; });
        var touching = function (rect, box) { return rect.x < box.x + box.width && rect.x + rect.width > box.x && rect.y < box.y + box.height && rect.y + rect.height > box.y; };
        for (var index = regionResult.boxes.length - 1; index >= 0; index -= 1) {
            var box = regionResult.boxes[index];
            if (box.kind !== 'photo-candidate' || box.width < 160 || box.height < 80) continue;
            // Smooth inside (the words taken out)...
            var smooth = tools.detectBackdrop(pixelData, canvas.width, canvas.height, box, rects.filter(function (rect) { return touching(rect, box); }), false, .05, 0, .4);
            if (!smooth) continue;
            // ...and sitting on a backdrop that varies: a logo or banner on a flat page is smooth too, and stays a picture.
            var top = Math.max(0, box.y - 60);
            var around = { x: 0, y: top, width: canvas.width, height: Math.min(canvas.height, box.y + box.height + 60) - top };
            var surround = tools.detectBackdrop(pixelData, canvas.width, canvas.height, around, rects.filter(function (rect) { return touching(rect, around); }), false, .3);
            if (surround) {
                regionResult.boxes.splice(index, 1);
                // The text is read over the whole strip, not just the box: the box can start inside the first letter.
                dropped.push({ box: around, backdrop: surround, plates: (surfaces || []).filter(function (surface) { return ['button', 'badge', 'input'].indexOf(surface.kind) !== -1 && touching(surface, around); }) });
            }
        }
        return dropped;
    }

    // Text sitting on a soft backdrop (white headline on a gradient) defeats the plain OCR pass. Here the backdrop is subtracted first, so the
    // letters are the only thing left: dark ink on white, which Tesseract reads. Words that are already known are not added twice.
    function recognizeOverBackdrop(canvas, softBoxes, words) {
        if (!softBoxes.length) return Promise.resolve([]);
        return Tesseract.createWorker(PageGeneratorConfig.ocrLanguages || 'ukr+eng').then(function (worker) {
            var found = [];
            var chain = worker.setParameters({ tessedit_pageseg_mode: '6' });
            softBoxes.slice(0, 8).forEach(function (soft) {
                chain = chain.then(function () {
                    var box = soft.box;
                    var grid = soft.backdrop;
                    var scale = Math.min(3, Math.max(1, Math.round(2400 / Math.max(box.width, 1))));
                    var width = Math.round(box.width * scale);
                    var height = Math.round(box.height * scale);
                    var onPlate = function (px, py) { return (soft.plates || []).some(function (plate) { return px >= plate.x - 2 && px <= plate.x + plate.width + 2 && py >= plate.y - 2 && py <= plate.y + plate.height + 2; }); };
                    var source = canvas.getContext('2d', { willReadFrequently: true }).getImageData(box.x, box.y, box.width, box.height).data;
                    var crop = document.createElement('canvas');
                    crop.width = width;
                    crop.height = height;
                    var context = crop.getContext('2d');
                    var image = context.createImageData(width, height);
                    var sample = function (gx, gy) {
                        var cx = Math.max(0, Math.min(grid.cols - 1, gx)), cy = Math.max(0, Math.min(grid.rows - 1, gy));
                        var o = (cy * grid.cols + cx) * 3;
                        return [grid.pixels[o], grid.pixels[o + 1], grid.pixels[o + 2]];
                    };
                    for (var y = 0; y < height; y += 1) {
                        var sy = Math.min(box.height - 1, Math.floor(y / scale));
                        var fy = sy / grid.cell - .5, y0 = Math.floor(fy), ty = fy - y0;
                        for (var x = 0; x < width; x += 1) {
                            var sx = Math.min(box.width - 1, Math.floor(x / scale));
                            var fx = sx / grid.cell - .5, x0 = Math.floor(fx), tx = fx - x0;
                            var a = sample(x0, y0), b = sample(x0 + 1, y0), c = sample(x0, y0 + 1), d = sample(x0 + 1, y0 + 1);
                            var so = (sy * box.width + sx) * 4;
                            var distance = 0;
                            for (var k = 0; k < 3; k += 1) {
                                var back = (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty;
                                distance += Math.abs(source[so + k] - back);
                            }
                            // Letters differ strongly from the backdrop; anti-aliasing and noise do not. A hard cut gives Tesseract clean black on white.
                            var value = distance > 90 ? 0 : (distance < 45 ? 255 : 255 - (distance - 45) * 5.6);
                            if (onPlate(box.x + sx, box.y + sy)) value = 255;
                            var o = (y * width + x) * 4;
                            image.data[o] = value; image.data[o + 1] = value; image.data[o + 2] = value; image.data[o + 3] = 255;
                        }
                    }
                    context.putImageData(image, 0, 0);
                    return worker.recognize(crop).then(function (result) {
                        (result.data.words || []).forEach(function (word) {
                            var text = String(word.text || '').trim();
                            if (!text || word.confidence < 45 || !/[A-Za-zА-Яа-яІіЇїЄєҐґ0-9]{2}/.test(text)) return;
                            var item = {
                                text: text,
                                x: Math.round(box.x + word.bbox.x0 / scale), y: Math.round(box.y + word.bbox.y0 / scale),
                                width: Math.round((word.bbox.x1 - word.bbox.x0) / scale), height: Math.round((word.bbox.y1 - word.bbox.y0) / scale),
                                confidence: word.confidence
                            };
                            var known = (words || []).concat(found).some(function (other) { return boxOverlapRatio(item, other) > .4; });
                            if (!known && item.height >= 8) found.push(item);
                        });
                    });
                });
            });
            return chain.then(function () { return worker.terminate(); }).then(function () { return found; });
        });
    }

    // Pixel-detected pictures replace the contour fragments they swallow; a picture the contour pass already found whole is kept as it is.
    function mergePhotoRegions(canvas, regionResult, photos) {
        var boxes = regionResult.boxes;
        var added = [];
        photos.forEach(function (photo) {
            var duplicate = boxes.some(function (box) { return box.kind === 'photo-candidate' && boxOverlapRatio(box, photo) > .5; });
            if (duplicate) return;
            var area = photo.width * photo.height;
            for (var index = boxes.length - 1; index >= 0; index -= 1) {
                var box = boxes[index];
                if (box.width * box.height <= area * 1.1 && centerInside(box, photo)) boxes.splice(index, 1);
            }
            added.push({
                x: photo.x, y: photo.y, width: photo.width, height: photo.height,
                variance: 9999, background: sampleRegionBackground(canvas, photo), kind: 'photo-candidate',
                photo: true, textLike: false, rounded: 0, gradient: false, uniform: 0
            });
        });
        added.reverse().forEach(function (box) { boxes.unshift(box); });
    }

    // Icons and logos cut out of the screenshot, uploaded as media assets (capped so a very busy page does not flood the server).
    function uploadIconCrops(canvas, icons) {
        var limited = icons.slice(0, 40);
        return Promise.all(limited.map(function (icon, index) {
            return new Promise(function (resolve) {
                var crop = document.createElement('canvas');
                crop.width = icon.width;
                crop.height = icon.height;
                crop.getContext('2d').drawImage(canvas, icon.x, icon.y, icon.width, icon.height, 0, 0, crop.width, crop.height);
                crop.toBlob(function (blob) {
                    if (!blob) { resolve(null); return; }
                    var form = new FormData();
                    form.append('action', 'page_generator_upload_asset');
                    form.append('nonce', PageGeneratorConfig.nonce);
                    form.append('asset', blob, 'detected-icon-' + index + '.png');
                    $.ajax({ url: PageGeneratorConfig.ajaxUrl, method: 'POST', data: form, processData: false, contentType: false })
                        .done(function (response) { resolve(response.success ? response.data : null); })
                        .fail(function () { resolve(null); });
                }, 'image/png');
            });
        })).then(function (assets) {
            return limited.map(function (icon, index) {
                return assets[index] ? Object.assign({}, icon, { asset: assets[index] }) : null;
            }).filter(Boolean);
        });
    }

    function uploadDetectedCrops(canvas, boxes) {
        var candidates = boxes.map(function (box, index) {
            return { box: box, index: index };
        }).filter(function (item) {
            return item.box.kind === 'photo-candidate' && item.box.width >= 70 && item.box.height >= 45;
        }).slice(0, 12);
        if (!candidates.length) return Promise.resolve({});
        return Promise.all(candidates.map(function (item) {
            return new Promise(function (resolve, reject) {
                var crop = document.createElement('canvas');
                crop.width = item.box.width;
                crop.height = item.box.height;
                crop.getContext('2d').drawImage(canvas, item.box.x, item.box.y, item.box.width, item.box.height, 0, 0, crop.width, crop.height);
                crop.toBlob(function (blob) {
                    if (!blob) { resolve(null); return; }
                    var form = new FormData();
                    form.append('action', 'page_generator_upload_asset');
                    form.append('nonce', PageGeneratorConfig.nonce);
                    form.append('asset', blob, 'detected-region-' + item.index + '.png');
                    $.ajax({ url: PageGeneratorConfig.ajaxUrl, method: 'POST', data: form, processData: false, contentType: false })
                        .done(function (response) {
                            if (!response.success) {
                                reject(new Error(response.data || 'Сервер відхилив завантаження виявленого зображення.'));
                                return;
                            }
                            resolve(response.data);
                        })
                        .fail(function () { reject(new Error('Не вдалося завантажити виявлене зображення.')); });
                }, 'image/png');
            });
        })).then(function (results) {
            var assets = {};
            candidates.forEach(function (item, index) { if (results[index]) assets[item.index] = results[index]; });
            return assets;
        });
    }

    function pixelsToCanvas(prepared) {
        var target = document.createElement('canvas');
        target.width = prepared.width;
        target.height = prepared.height;
        target.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(prepared.data), prepared.width, prepared.height), 0, 0);
        return target;
    }

    // The input is judged from its decoded pixels (not its file format): text size picks the enlargement, small text gets
    // two differently-processed passes whose words are merged by confidence.
    function recognizeScreenshot(canvas) {
        var tools = window.PageGeneratorDetectors;
        var image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        var prepared = tools.prepareForOcr(image.data, canvas.width, canvas.height);
        var variants = [prepared];
        if (prepared.scale > 1 && prepared.textHeight > 0 && prepared.textHeight < 16) {
            variants.push(tools.prepareForOcr(image.data, canvas.width, canvas.height, { sharpen: false, scale: prepared.scale }));
        }
        return Tesseract.createWorker(PageGeneratorConfig.ocrLanguages || 'ukr+eng')
            .then(function (worker) {
                var passes = [];
                var chain = Promise.resolve();
                variants.forEach(function (variant) {
                    chain = chain.then(function () {
                        return worker.recognize(pixelsToCanvas(variant)).then(function (result) {
                            passes.push((result.data.words || []).filter(function (word) {
                                return word.text && word.confidence >= 25;
                            }).map(function (word) {
                                return {
                                    text: word.text.trim(),
                                    x: Math.round(word.bbox.x0 / variant.scale),
                                    y: Math.round(word.bbox.y0 / variant.scale),
                                    width: Math.round((word.bbox.x1 - word.bbox.x0) / variant.scale),
                                    height: Math.round((word.bbox.y1 - word.bbox.y0) / variant.scale),
                                    confidence: word.confidence
                                };
                            }));
                        });
                    });
                });
                return chain.then(function () {
                    return worker.terminate();
                }).then(function () {
                    return passes.length > 1 ? tools.mergeWordPasses(passes) : passes[0];
                });
            });
    }

    // Light text on a coloured plate (buttons, badges) is missed by the page-wide OCR pass, so each plate is read on its own,
    // recoloured to dark-on-white by its distance from the plate fill.
    // Extent of the glyphs on a plate: pixels clearly different from the fill, away from rounded corners.
    function findInkBox(canvas, plate) {
        var margin = Math.max(3, Math.round(Math.min(plate.width, plate.height) * .12));
        var width = plate.width - margin * 2;
        var height = plate.height - margin * 2;
        if (width < 4 || height < 4) return null;
        var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(plate.x + margin, plate.y + margin, width, height).data;
        var minX = width, maxX = -1, minY = height, maxY = -1;
        for (var y = 0; y < height; y += 1) {
            for (var x = 0; x < width; x += 1) {
                var offset = (y * width + x) * 4;
                if (Math.abs(data[offset] - plate.fill[0]) + Math.abs(data[offset + 1] - plate.fill[1]) + Math.abs(data[offset + 2] - plate.fill[2]) > 90) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        return { x: plate.x + margin + minX, y: plate.y + margin + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    }

    function recognizePlates(canvas, surfaces, words) {
        var plates = (surfaces || []).filter(function (surface) {
            if (surface.kind !== 'button' && surface.kind !== 'badge') return false;
            return !words.some(function (word) {
                return word.x >= surface.x - 2 && word.y >= surface.y - 2 &&
                    word.x + word.width <= surface.x + surface.width + 2 && word.y + word.height <= surface.y + surface.height + 2;
            });
        }).slice(0, 40);
        if (!plates.length) return Promise.resolve([]);
        return Tesseract.createWorker(PageGeneratorConfig.ocrLanguages || 'ukr+eng').then(function (worker) {
            var found = [];
            var chain = worker.setParameters({ tessedit_pageseg_mode: '7' });
            plates.forEach(function (plate) {
                chain = chain.then(function () {
                    var scale = Math.min(4, Math.max(2, Math.ceil(70 / plate.height)));
                    var crop = document.createElement('canvas');
                    crop.width = Math.round(plate.width * scale);
                    crop.height = Math.round(plate.height * scale);
                    var context = crop.getContext('2d', { willReadFrequently: true });
                    var region = canvas.getContext('2d', { willReadFrequently: true }).getImageData(plate.x, plate.y, plate.width, plate.height);
                    context.putImageData(new ImageData(
                        window.PageGeneratorDetectors.resampleLanczos(region.data, plate.width, plate.height, crop.width, crop.height),
                        crop.width, crop.height
                    ), 0, 0);
                    var image = context.getImageData(0, 0, crop.width, crop.height);
                    for (var index = 0; index < image.data.length; index += 4) {
                        var distance = Math.abs(image.data[index] - plate.fill[0]) + Math.abs(image.data[index + 1] - plate.fill[1]) + Math.abs(image.data[index + 2] - plate.fill[2]);
                        var value = 255 - Math.min(255, distance * 1.2);
                        image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value;
                    }
                    context.putImageData(image, 0, 0);
                    return worker.recognize(crop).then(function (result) {
                        var ink = findInkBox(canvas, plate);
                        if (!ink) return;
                        var read = (result.data.words || []).filter(function (word) {
                            if (!word.text || word.confidence < 30) return false;
                            var cx = plate.x + (word.bbox.x0 + word.bbox.x1) / 2 / scale;
                            var cy = plate.y + (word.bbox.y0 + word.bbox.y1) / 2 / scale;
                            return cx >= ink.x - 4 && cx <= ink.x + ink.width + 4 && cy >= ink.y - 4 && cy <= ink.y + ink.height + 4;
                        });
                        if (!read.length) return;
                        found.push({
                            text: read.map(function (word) { return word.text.trim(); }).join(' '),
                            x: ink.x, y: ink.y, width: ink.width, height: ink.height,
                            confidence: read.reduce(function (sum, word) { return sum + word.confidence; }, 0) / read.length
                        });
                    });
                });
            });
            return chain.then(function () { return worker.terminate(); }).then(function () { return found; });
        });
    }

    function detectScreenshotRegions(canvas) {
        return new Promise(function (resolve) {
            var source = cv.imread(canvas);
            var gray = new cv.Mat();
            var edges = new cv.Mat();
            var contours = new cv.MatVector();
            var hierarchy = new cv.Mat();
            cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
            cv.Canny(gray, edges, 25, 75, 3, false);
            var kernel = cv.Mat.ones(3, 3, cv.CV_8U);
            cv.dilate(edges, edges, kernel);
            cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
            var boxes = [];
            for (var index = 0; index < contours.size(); index += 1) {
                var rect = cv.boundingRect(contours.get(index));
                if (rect.width >= 45 && rect.height >= 28 && rect.width < canvas.width * .98 && rect.height < canvas.height * .98) {
                    boxes.push({
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        variance: calculateRegionVariance(canvas, rect),
                        background: sampleRegionBackground(canvas, rect)
                    });
                }
            }
            var pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            boxes = normalizeRegions(boxes, canvas, pixels);
            var colorCounts = {};
            for (var pixel = 0; pixel < pixels.length; pixel += 16) {
                var red = Math.min(255, Math.round(pixels[pixel] / 32) * 32);
                var green = Math.min(255, Math.round(pixels[pixel + 1] / 32) * 32);
                var blue = Math.min(255, Math.round(pixels[pixel + 2] / 32) * 32);
                var color = '#' + [red, green, blue].map(function (value) {
                    return value.toString(16).padStart(2, '0');
                }).join('');
                colorCounts[color] = (colorCounts[color] || 0) + 1;
            }
            source.delete(); gray.delete(); edges.delete(); contours.delete(); hierarchy.delete(); kernel.delete();
            resolve({
                boxes: boxes,
                allRegions: boxes.allRegions || boxes,
                sections: window.PageGeneratorDetectors.detectBands(pixels, canvas.width, canvas.height),
                colors: Object.keys(colorCounts).sort(function (a, b) { return colorCounts[b] - colorCounts[a]; }).slice(0, 12)
            });
        });
    }

    function normalizeRegions(boxes, canvas, pixelData) {
        var filtered = boxes.filter(function (box) {
            return box.width * box.height >= canvas.width * canvas.width * .002 &&
                box.width <= canvas.width * .92 &&
                box.height <= canvas.height * .92;
        });
        filtered.forEach(function (box) {
            box.photo = window.PageGeneratorDetectors.isPhotographic(pixelData, canvas.width, box);
        });
        // Controls (selects, inputs) sit inside a bigger card, so nested regions are kept aside for control detection.
        var allRegions = filtered.map(function (box) {
            box.uniform = edgeUniformity(canvas, box);
            return box;
        });
        filtered = removeNestedRegions(filtered);
        filtered = mergeNearbyRegions(filtered, canvas);
        var kept = filtered
            .sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); })
            .slice(0, 120)
            .map(function (box) {
                box.kind = window.PageGeneratorDetectors.isPhotographic(pixelData, canvas.width, box) ? 'photo-candidate' : 'surface-candidate';
                box.textLike = box.width < canvas.width * .55 && box.height < canvas.width * .18 && box.variance < 45;
                box.rounded = estimateRoundedCorners(canvas, box);
                box.gradient = window.PageGeneratorDetectors.detectLinearGradient(pixelData, canvas.width, canvas.height, box);
                box.uniform = edgeUniformity(canvas, box);
                return box;
            });
        kept.allRegions = allRegions;
        return kept;
    }

    function removeNestedRegions(boxes) {
        var ordered = boxes.slice().sort(function (a, b) {
            return (a.width * a.height) - (b.width * b.height);
        });
        return ordered.filter(function (candidate, index) {
            var candidateArea = candidate.width * candidate.height;
            return !ordered.some(function (outer, outerIndex) {
                if (outerIndex === index) return false;
                var outerArea = outer.width * outer.height;
                if (outerArea <= candidateArea * 1.35) return false;
                if (outer.width > 0 && outer.height > 0 &&
                    (outer.width > candidate.width * 3 || outer.height > candidate.height * 3)) {
                    return false;
                }
                // A photo sitting on a card or banner is content, not an edge artefact; only a photo inside another photo is dropped.
                if (candidate.photo && !outer.photo) return false;
                return candidate.x >= outer.x - 2 &&
                    candidate.y >= outer.y - 2 &&
                    candidate.x + candidate.width <= outer.x + outer.width + 2 &&
                    candidate.y + candidate.height <= outer.y + outer.height + 2;
            });
        });
    }

    function mergeNearbyRegions(boxes, canvas) {
        var result = [];
        boxes.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (box) {
            var target = result.find(function (current) {
                var horizontalGap = Math.max(current.x - (box.x + box.width), box.x - (current.x + current.width), 0);
                var verticalGap = Math.max(current.y - (box.y + box.height), box.y - (current.y + current.height), 0);
                var overlaps = horizontalGap === 0 && verticalGap === 0;
                var aligned = Math.abs(current.y - box.y) <= Math.max(10, Math.min(current.height, box.height) * .2) ||
                    Math.abs(current.x - box.x) <= Math.max(10, Math.min(current.width, box.width) * .2);
                return overlaps && aligned;
            });
            if (!target) {
                result.push(box);
                return;
            }
            var right = Math.max(target.x + target.width, box.x + box.width);
            var bottom = Math.max(target.y + target.height, box.y + box.height);
            target.x = Math.min(target.x, box.x);
            target.y = Math.min(target.y, box.y);
            target.width = right - target.x;
            target.height = bottom - target.y;
            target.variance = Math.max(target.variance, box.variance);
        });
        return result;
    }

    // Share of the plate's border pixels that match its dominant colour. Text sits in the middle, so it does not lower this value
    // the way it lowers whole-region variance (a green button with white text still reads as one plate).
    function edgeUniformity(canvas, box) {
        var width = Math.max(1, Math.floor(box.width));
        var height = Math.max(1, Math.floor(box.height));
        if (width < 6 || height < 6) return 0;
        var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(box.x, box.y, width, height).data;
        var inset = Math.max(1, Math.min(6, Math.floor(Math.min(width, height) * .12)));
        var counts = {};
        var total = 0;
        var take = function (x, y) {
            var offset = (y * width + x) * 4;
            var key = (data[offset] >> 4) + ',' + (data[offset + 1] >> 4) + ',' + (data[offset + 2] >> 4);
            counts[key] = (counts[key] || 0) + 1;
            total += 1;
        };
        var stepX = Math.max(1, Math.floor(width / 60));
        var stepY = Math.max(1, Math.floor(height / 40));
        for (var x = inset; x < width - inset; x += stepX) { take(x, inset); take(x, height - 1 - inset); }
        for (var y = inset; y < height - inset; y += stepY) { take(inset, y); take(width - 1 - inset, y); }
        var dominant = Math.max.apply(null, Object.keys(counts).map(function (key) { return counts[key]; }).concat([0]));
        return total ? dominant / total : 0;
    }

    function rgbGap(a, b) {
        return Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
    }

    function toHex(pixel) {
        return '#' + pixel.map(function (value) { return Math.round(value).toString(16).padStart(2, '0'); }).join('');
    }

    // Reads the pixel grid of a small region once; callers index it with (x, y) relative to the region.
    function readRegion(canvas, x, y, width, height) {
        // getImageData returns transparent black outside the canvas, so the region is clamped first.
        var left = Math.max(0, Math.floor(x));
        var top = Math.max(0, Math.floor(y));
        var w = Math.max(1, Math.min(canvas.width - left, Math.floor(x + width) - left));
        var h = Math.max(1, Math.min(canvas.height - top, Math.floor(y + height) - top));
        var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(left, top, w, h).data;
        return {
            width: w,
            height: h,
            at: function (px, py) {
                var offset = (Math.min(h - 1, Math.max(0, py)) * w + Math.min(w - 1, Math.max(0, px))) * 4;
                return [data[offset], data[offset + 1], data[offset + 2]];
            }
        };
    }

    // Fill, border and left accent of a card. The card's fill is its interior (not the page behind it). The border is the
    // first line just inside the detected edge that differs from both the page and the fill; the accent is the saturated bar
    // at the left edge. Detected edges are often a few pixels off the real line, so the search scans instead of using offsets.
    function sampleCardEdges(canvas, box) {
        var edges = {};
        var midX = Math.round(box.x + box.width / 2);
        var midY = Math.round(box.y + box.height / 2);
        var page = readRegion(canvas, midX, box.y - 8, 1, 1).at(0, 0);
        var inside = readRegion(canvas, midX, box.y + box.height - 10, 1, 1).at(0, 0);
        edges.background = toHex(inside);
        var column = readRegion(canvas, midX, box.y - 3, 1, 12);
        for (var row = 0; row < column.height; row += 1) {
            var line = column.at(0, row);
            if (rgbGap(line, page) >= 6 && rgbGap(line, inside) >= 6) {
                edges.borderColor = toHex(line);
                edges.borderWidth = 1;
                break;
            }
        }
        var strip = readRegion(canvas, box.x - 2, midY - 2, 24, 5);
        var start = -1;
        var accentWidth = 0;
        for (var x = 0; x < strip.width; x += 1) {
            var pixel = strip.at(x, 2);
            var saturated = Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]) >= 80;
            if (saturated && rgbGap(pixel, inside) >= 80) {
                if (start < 0) start = x;
                accentWidth += 1;
            } else if (start >= 0) {
                break;
            }
        }
        if (start >= 0 && accentWidth >= 2 && accentWidth <= 16) {
            edges.accentColor = toHex(strip.at(start, 2));
            edges.accentWidth = accentWidth;
        }
        return edges;
    }

    // A checkbox is a small outlined square at the start of its label. OCR boxes can include the square, so the search
    // starts a little left of the label and takes the first ink blob. Returns the square's box or null.
    function findCheckboxBeside(canvas, label) {
        var size = Math.max(14, label.height);
        var region = readRegion(canvas, label.x - size * .5, label.y - size * .4, size * 3, label.height + size * .8);
        var background = region.at(0, 0);
        var inked = function (x, y) { return rgbGap(region.at(x, y), background) >= 30; };
        var columnHasInk = [];
        for (var x = 0; x < region.width; x += 1) {
            var any = false;
            for (var y = 0; y < region.height && !any; y += 1) any = inked(x, y);
            columnHasInk.push(any);
        }
        var left = columnHasInk.indexOf(true);
        if (left < 0) return null;
        var right = left;
        while (right + 1 < region.width && columnHasInk[right + 1]) right += 1;
        var top = region.height, bottom = -1;
        for (var px = left; px <= right; px += 1) {
            for (var py = 0; py < region.height; py += 1) {
                if (inked(px, py)) { top = Math.min(top, py); bottom = Math.max(bottom, py); }
            }
        }
        if (bottom < 0) return null;
        var width = right - left + 1;
        var height = bottom - top + 1;
        var ratio = width / height;
        if (width < size * .6 || height < size * .6 || width > size * 1.6 || ratio < .7 || ratio > 1.4) return null;
        // A checkbox is a closed outline: all four sides are inked and the inside is the background.
        var sideRun = function (fixed, from, to, horizontal) {
            var count = 0;
            for (var i = from; i <= to; i += 1) {
                if (horizontal ? inked(i, fixed) : inked(fixed, i)) count += 1;
            }
            return count / Math.max(1, to - from + 1);
        };
        if (sideRun(top, left, right, true) < .7 || sideRun(bottom, left, right, true) < .7 ||
            sideRun(left, top, bottom, false) < .7 || sideRun(right, top, bottom, false) < .7) return null;
        if (rgbGap(region.at(Math.round((left + right) / 2), Math.round((top + bottom) / 2)), background) >= 20) return null;
        // The whole inside has to be empty, not just its centre pixel: four coloured squares (a Microsoft-style logo) leave a blank cross in the middle.
        var inset = Math.max(3, Math.round(Math.min(width, height) * .25));
        var interior = 0;
        var interiorInked = 0;
        for (var iy = top + inset; iy <= bottom - inset; iy += 1) {
            for (var ix = left + inset; ix <= right - inset; ix += 1) {
                interior += 1;
                if (inked(ix, iy)) interiorInked += 1;
            }
        }
        if (interior && interiorInked / interior > .1) return null;
        return { x: Math.round(label.x - size * .5 + left), y: Math.round(label.y - size * .4 + top), width: width, height: height };
    }

    // A select has a chevron on its right edge: a few dark pixels in a narrow column, not a long text run.
    function hasChevron(canvas, box) {
        var region = readRegion(canvas, box.x + box.width - Math.min(44, box.width * .15), box.y + 4, Math.min(44, box.width * .15), Math.max(1, box.height - 8));
        var background = region.at(0, 0);
        var ink = 0;
        var minX = region.width, maxX = -1;
        for (var y = 0; y < region.height; y += 1) {
            for (var x = 0; x < region.width; x += 1) {
                if (rgbGap(region.at(x, y), background) >= 90) {
                    ink += 1;
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                }
            }
        }
        return ink >= 6 && ink <= 400 && maxX >= 0 && maxX - minX <= 24;
    }

    function estimateRoundedCorners(canvas, box) {
        var context = canvas.getContext('2d', { willReadFrequently: true });
        var sample = 5;
        var points = [
            [box.x + sample, box.y + sample],
            [box.x + box.width - sample - 1, box.y + sample],
            [box.x + sample, box.y + box.height - sample - 1],
            [box.x + box.width - sample - 1, box.y + box.height - sample - 1]
        ];
        var center = context.getImageData(
            Math.min(canvas.width - 1, box.x + Math.floor(box.width / 2)),
            Math.min(canvas.height - 1, box.y + Math.floor(box.height / 2)), 1, 1
        ).data;
        var different = points.filter(function (point) {
            var pixel = context.getImageData(Math.max(0, point[0]), Math.max(0, point[1]), 1, 1).data;
            return Math.abs(pixel[0] - center[0]) + Math.abs(pixel[1] - center[1]) + Math.abs(pixel[2] - center[2]) > 35;
        }).length;
        return different >= 2 ? 6 : 0;
    }

    function hexToRgb(value) {
        var match = String(value || '').replace('#', '').match(/^([0-9a-f]{6})$/i);
        return match ? [parseInt(match[1].slice(0, 2), 16), parseInt(match[1].slice(2, 4), 16), parseInt(match[1].slice(4, 6), 16)] : [255, 255, 255];
    }

    function sampleRegionBackground(canvas, rect) {
        var context = canvas.getContext('2d', { willReadFrequently: true });
        var points = [
            [rect.x + 2, rect.y + 2],
            [rect.x + rect.width - 3, rect.y + 2],
            [rect.x + 2, rect.y + rect.height - 3],
            [rect.x + rect.width - 3, rect.y + rect.height - 3],
            [rect.x + Math.floor(rect.width / 2), rect.y + 2],
            [rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 3]
        ];
        var counts = {};
        points.forEach(function (point) {
            var x = Math.max(0, Math.min(canvas.width - 1, Math.floor(point[0])));
            var y = Math.max(0, Math.min(canvas.height - 1, Math.floor(point[1])));
            var pixel = context.getImageData(x, y, 1, 1).data;
            var color = rgbToHex([pixel[0], pixel[1], pixel[2]]);
            counts[color] = (counts[color] || 0) + 1;
        });
        return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || '#ffffff';
    }

    function colorDistance(first, second) {
        return Math.sqrt(Math.pow(first[0] - second[0], 2) + Math.pow(first[1] - second[1], 2) + Math.pow(first[2] - second[2], 2));
    }

    function rgbToHex(rgb) {
        return '#' + rgb.map(function (value) {
            var channel = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 255;
            return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0');
        }).join('');
    }

    function normalizeHexColor(value, fallback) {
        var color = String(value || '').trim().toLowerCase();
        if (/^#[0-9a-f]{3}$/.test(color)) {
            return '#' + color.slice(1).split('').map(function (part) { return part + part; }).join('');
        }
        if (/^#[0-9a-f]{6}$/.test(color)) return color;
        return fallback || '#ffffff';
    }

    function calculateRegionVariance(canvas, rect) {
        var context = canvas.getContext('2d', { willReadFrequently: true });
        var step = Math.max(1, Math.floor(Math.min(rect.width, rect.height) / 10));
        var samples = [];
        var redSum = 0;
        var greenSum = 0;
        var blueSum = 0;
        for (var x = rect.x + 4; x < rect.x + rect.width - 4; x += step) {
            for (var y = rect.y + 4; y < rect.y + rect.height - 4; y += step) {
                var pixel = context.getImageData(x, y, 1, 1).data;
                samples.push(pixel);
                redSum += pixel[0];
                greenSum += pixel[1];
                blueSum += pixel[2];
            }
        }
        if (!samples.length) return 0;
        var redMean = redSum / samples.length;
        var greenMean = greenSum / samples.length;
        var blueMean = blueSum / samples.length;
        var variance = samples.reduce(function (total, pixel) {
            return total + Math.pow(pixel[0] - redMean, 2) + Math.pow(pixel[1] - greenMean, 2) + Math.pow(pixel[2] - blueMean, 2);
        }, 0);
        return Math.sqrt(variance / samples.length);
    }

    function buildScreenshotPageSchema(analyses, description) {
        var hints = parseDescription(description || '');
        var sections = [];
        analyses.forEach(function (analysis) {
            analysis.sourceGroup = randomId();
            var groups = groupWordsIntoLines(analysis.words);
            var lineHeights = groups.map(function (line) { return line.height; }).sort(function (a, b) { return a - b; });
            analysis.medianLine = lineHeights.length ? lineHeights[Math.floor(lineHeights.length / 2)] : 16;
            var textElements = groups.map(function (line) {
                var text = normalizeOcrText(line.words.map(function (word) { return word.text; }).join(' '));
                if (!isUsableOcrText(text, line.words)) return null;
                var node = {
                    id: randomId(),
                    type: line.height >= analysis.medianLine * 1.45 ? 'heading' : 'text',
                    role: line.height >= analysis.medianLine * 1.45 ? 'heading' : 'paragraph',
                    content: text,
                    text: text,
                    bbox: { x: line.x, y: line.y, width: line.width, height: line.height },
                    settings: { x: line.x, y: line.y, width: line.width, height: line.height, fontSize: Math.max(10, Math.round(line.height * .9)) },
                    style: {
                        fontSize: Math.max(10, Math.round(line.height * .9)),
                        fontWeight: fontWeightFromInk(measureInkDensity(analysis.canvas, line)),
                        color: sampleTextColor(analysis.canvas, line, '#334155')
                    },
                    children: [],
                    elements: [],
                    behavior: { type: 'none' },
                    confidence: line.words.length ? line.words.reduce(function (sum, word) { return sum + Number(word.confidence || 0); }, 0) / line.words.length / 100 : 0,
                    source: { detectedBy: ['ocr'], manual: false }
                };
                var typeface = detectLineTypeface(analysis.canvas, line, node.style.fontWeight);
                if (typeface && typeface.serif) node.style.fontFamily = 'serif';
                node = classifyTextNode(node, analysis);
                return node;
            }).filter(function (node) { return node !== null; });
            markMenuRuns(textElements, analysis);
            var semantic = analyzeLayout(analysis, textElements);
            semantic.elements = buildRecursiveTree(semantic.elements, analysis);
            // OCR on a photo returns its scenery as words; the photo itself is the element, so those words are dropped.
            var photos = collectPhotoBoxes(semantic.elements, []);
            semantic.elements = pruneTextOnPhotos(semantic.elements, photos);
            textElements = textElements.filter(function (node) { return !isInsidePhoto(node.bbox, photos); });
            splitIntoSections(analysis, semantic, analysis.data, textElements).forEach(function (section) {
                sections.push(section);
            });
        });
        return {
            version: 2,
            title: 'Imported screenshot page',
            containerWidth: Number(PageGeneratorConfig.containerWidth || 1200),
            tokens: { colors: analyses[0] ? analyses[0].colors : [], typography: [] },
            source: 'screenshot',
            description: description || '',
            hints: hints,
            sections: sections
        };
    }

    function collectPhotoBoxes(nodes, found) {
        (nodes || []).forEach(function (node) {
            if (node.type === 'image' && node.bbox) found.push(node.bbox);
            collectPhotoBoxes(node.children || [], found);
        });
        return found;
    }

    function isInsidePhoto(box, photos) {
        if (!box) return false;
        var centerX = Number(box.x || 0) + Number(box.width || 0) / 2;
        var centerY = Number(box.y || 0) + Number(box.height || 0) / 2;
        return photos.some(function (photo) {
            return centerX >= photo.x && centerX <= photo.x + photo.width && centerY >= photo.y && centerY <= photo.y + photo.height;
        });
    }

    function pruneTextOnPhotos(nodes, photos) {
        return (nodes || []).filter(function (node) {
            if (['text', 'heading', 'link', 'badge'].indexOf(node.type) !== -1 && isInsidePhoto(node.bbox, photos)) return false;
            if (node.type === 'image') {
                node.text = '';
                node.content = '';
            }
            var kept = node.type === 'image' ? [] : pruneTextOnPhotos(node.children || node.elements || [], photos);
            node.children = kept;
            node.elements = kept;
            return true;
        });
    }

    function markMenuRuns(textElements, analysis) {
        var bands = analysis.sections || [];
        var nearEdge = function (box) {
            if (bands.length < 3) return box.y < analysis.width * .5 || box.y > analysis.height - analysis.width * .5;
            var center = box.y + box.height / 2;
            var index = bands.findIndex(function (band) { return center >= band.y && center < band.y + band.height; });
            return index === 0 || (index >= bands.length - 2 && index > 0 && isDarkBackground(bands[index].background));
        };
        var candidates = textElements.filter(function (node) {
            var box = node.bbox || {};
            var insideControl = (analysis.surfaces || []).some(function (surface) {
                return (surface.kind === 'button' || surface.kind === 'input' || surface.kind === 'badge') &&
                    box.x >= surface.x && box.y >= surface.y && box.x + box.width <= surface.x + surface.width && box.y + box.height <= surface.y + surface.height;
            });
            return node.type !== 'button' && !insideControl && nearEdge(box);
        });
        window.PageGeneratorDetectors.detectLineRuns(candidates.map(function (node) {
            return { x: node.bbox.x, y: node.bbox.y, width: node.bbox.width, height: node.bbox.height, node: node };
        })).forEach(function (run) {
            var sizes = run.items.map(function (item) { return Number(item.node.style && item.node.style.fontSize || 0); })
                .filter(Boolean).sort(function (a, b) { return a - b; });
            var runSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
            run.items.forEach(function (item) {
                if (runSize) {
                    item.node.style.fontSize = runSize;
                    item.node.settings.fontSize = runSize;
                }
                item.node.type = 'link';
                item.node.role = 'navigation-item';
                item.node.behavior = { type: 'unknown' };
                item.node.confidence = Math.max(item.node.confidence || 0, .7);
                item.node.detection = { detectedBy: ['ocr', 'line-run'], manual: false, axis: run.axis };
            });
        });
    }

    // Background of a text box = most common colour in a thin ring just outside it (inside, glyphs touch the edges).
    function ringBackground(canvas, box) {
        var context = canvas.getContext('2d', { willReadFrequently: true });
        var gap = 4;
        var x0 = Math.max(0, Math.floor(box.x) - gap);
        var y0 = Math.max(0, Math.floor(box.y) - gap);
        var x1 = Math.min(canvas.width - 1, Math.ceil(box.x + box.width) + gap);
        var y1 = Math.min(canvas.height - 1, Math.ceil(box.y + box.height) + gap);
        var counts = {};
        var take = function (x, y) {
            var pixel = context.getImageData(x, y, 1, 1).data;
            var key = (pixel[0] >> 2) + ',' + (pixel[1] >> 2) + ',' + (pixel[2] >> 2);
            counts[key] = counts[key] || { n: 0, color: [pixel[0], pixel[1], pixel[2]] };
            counts[key].n += 1;
        };
        var step = Math.max(1, Math.floor((x1 - x0) / 40));
        for (var x = x0; x <= x1; x += step) { take(x, y0); take(x, y1); }
        for (var y = y0; y <= y1; y += Math.max(1, Math.floor((y1 - y0) / 12))) { take(x0, y); take(x1, y); }
        var best = Object.keys(counts).sort(function (a, b) { return counts[b].n - counts[a].n; })[0];
        return best ? counts[best].color : [255, 255, 255];
    }

    // Font weight from the screenshot: how much of the text box is solid ink. Bold glyphs cover noticeably more of the
    // box than regular ones at the same size, so the density is compared with fixed bands.
    // Density bands calibrated on the lab6 reference: bold labels ~0.4-0.5, bold headings ~0.3-0.35, regular body ~0.2-0.28.
    function fontWeightFromInk(density) {
        if (density >= .42) return 700;
        if (density >= .3) return 600;
        return 400;
    }

    function detectLineTypeface(canvas, line, fontWeight) {
        var x = Math.max(0, Math.floor(line.x)), y = Math.max(0, Math.floor(line.y));
        var width = Math.min(canvas.width - x, Math.ceil(line.width)), height = Math.min(canvas.height - y, Math.ceil(line.height));
        if (width < 20 || height < 10) return null;
        var pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, width, height).data;
        return window.PageGeneratorDetectors.classifyTypeface(pixels, width, { x: 0, y: 0, width: width, height: height }, Number(fontWeight) >= 600);
    }

    function measureInkDensity(canvas, box) {
        if (!canvas || !box) return 0;
        var x = Math.max(0, Math.floor(box.x || 0));
        var y = Math.max(0, Math.floor(box.y || 0));
        var width = Math.min(canvas.width - x, Math.max(1, Math.ceil(box.width || 1)));
        var height = Math.min(canvas.height - y, Math.max(1, Math.ceil(box.height || 1)));
        if (width <= 1 || height <= 1) return 0;
        var pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, width, height).data;
        var background = ringBackground(canvas, box);
        var ink = 0;
        for (var index = 0; index < pixels.length; index += 4) {
            if (colorDistance([pixels[index], pixels[index + 1], pixels[index + 2]], background) >= 120) ink += 1;
        }
        return ink / (width * height);
    }

    function sampleTextColor(canvas, box, fallback) {
        if (!canvas || !box) return fallback;
        var x = Math.max(0, Math.floor(box.x || 0));
        var y = Math.max(0, Math.floor(box.y || 0));
        var width = Math.min(canvas.width - x, Math.max(1, Math.ceil(box.width || 1)));
        var height = Math.min(canvas.height - y, Math.max(1, Math.ceil(box.height || 1)));
        if (width <= 0 || height <= 0) return fallback;
        var pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, width, height).data;
        var background = ringBackground(canvas, box);
        var ink = [];
        for (var index = 0; index < pixels.length; index += 4) {
            var distance = colorDistance([pixels[index], pixels[index + 1], pixels[index + 2]], background);
            if (distance >= 24) ink.push({ distance: distance, color: [pixels[index], pixels[index + 1], pixels[index + 2]] });
        }
        if (!ink.length) return fallback;
        ink.sort(function (a, b) { return b.distance - a.distance; });
        var core = ink.slice(0, Math.max(1, Math.ceil(ink.length * .15)));
        var sum = core.reduce(function (total, item) {
            return [total[0] + item.color[0], total[1] + item.color[1], total[2] + item.color[2]];
        }, [0, 0, 0]);
        var inkColor = sum.map(function (value) { return Math.round(value / core.length); });
        if (colorDistance(inkColor, background) < 60) {
            var lightBackground = background[0] * .299 + background[1] * .587 + background[2] * .114 > 140;
            return lightBackground ? '#1f2937' : '#f8fafc';
        }
        return normalizeHexColor(rgbToHex(inkColor), fallback);
    }

    // Pixels of the whole screenshot, read once per analysis.
    function analysisPixels(analysis) {
        if (!analysis.pixels) {
            analysis.pixels = analysis.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, analysis.width, analysis.height).data;
        }
        return analysis.pixels;
    }

    // Everything that sits on a band's background (words, plates, pictures): these cells are not background.
    function foregroundRects(analysis, top, height) {
        var rects = [];
        var add = function (box, pad) {
            if (box.y + box.height < top || box.y > top + height) return;
            rects.push({ x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 });
        };
        (analysis.words || []).forEach(function (word) { add(word, 6); });
        (analysis.surfaces || []).forEach(function (surface) { if (['button', 'badge', 'input'].indexOf(surface.kind) !== -1) add(surface, 4); });
        // A "photo" spanning most of the band is the backdrop itself (the contour pass mistakes a busy gradient for a picture).
        (analysis.boxes || []).forEach(function (box) { if (box.kind === 'photo-candidate' && (box.width < analysis.width * .8 || box.height < height * .8)) add(box, 2); });
        return rects;
    }

    // Bands are cut wherever the colour changes, so a gradient background arrives as several slices. Neighbouring bands whose union is
    // one linear ramp are joined back into a single band (the longest such run starting at each band).
    function mergeGradientBands(analysis, bands) {
        var tools = window.PageGeneratorDetectors;
        var pixels = analysisPixels(analysis);
        var merged = [];
        var index = 0;
        while (index < bands.length) {
            var best = null;
            for (var end = index + 1; end < bands.length && end < index + 8; end += 1) {
                var previous = bands[end - 1];
                if (Math.abs(bands[end].y - (previous.y + previous.height)) > 2) break;
                var top = bands[index].y;
                var height = bands[end].y + bands[end].height - top;
                if (height < 120) continue;
                var span = { x: 0, y: top, width: analysis.width, height: height };
                var ramp = tools.detectLinearGradient(pixels, analysis.width, analysis.height, span)
                    || tools.detectBackdrop(pixels, analysis.width, analysis.height, span, foregroundRects(analysis, top, height), true, undefined, undefined, .01);
                if (ramp) best = { end: end, y: top, height: height };
            }
            if (best) {
                merged.push({ y: best.y, height: best.height, background: bands[index].background });
                index = best.end + 1;
            } else {
                merged.push(bands[index]);
                index += 1;
            }
        }
        return merged;
    }

    function splitIntoSections(analysis, semantic, uploadedData, textElements) {
        var detected = mergeGradientBands(analysis, (analysis.sections || []).filter(function (band) { return band.height >= analysis.width * .02; }));
        // A colour band can hold a whole page body (same background), so each band is also split at its own content gaps.
        var bands = detected.length < 2 ? deriveContentBands(semantic.elements, analysis) : detected.reduce(function (all, band) {
            var inside = semantic.elements.filter(function (node) {
                var box = node.bbox || node.settings || {};
                var center = (box.y || 0) + (box.height || 0) / 2;
                return center >= band.y && center < band.y + band.height;
            });
            var parts = deriveContentBands(inside, analysis, band);
            return all.concat(parts.length ? parts : [band]);
        }, []);
        if (bands.length < 2) bands = [{ y: 0, height: analysis.height, background: semantic.background }];
        var sections = bands.map(function (band, index) {
            var children = semantic.elements.filter(function (node) {
                var box = node.bbox || node.settings || {};
                var center = (box.y || 0) + (box.height || 0) / 2;
                return center >= band.y && center < band.y + band.height;
            });
            var type = classifyBand(band, children, analysis, index, bands.length);
            var scopedText = (textElements || []).filter(function (node) {
                var box = node && (node.bbox || node.settings);
                if (!box) return false;
                var center = Number(box.y || 0) + Number(box.height || 0) / 2;
                return center >= band.y && center < band.y + band.height;
            });
            children = classifyStructuredContent(children, scopedText, analysis, type, band);
            // A band that fades from one colour to another keeps its ramp (the solid background stays as the fallback).
            var bandGradient = band.height >= 120 ? window.PageGeneratorDetectors.detectLinearGradient(analysisPixels(analysis), analysis.width, analysis.height, { x: 0, y: band.y, width: analysis.width, height: band.height }) : null;
            // A soft multi-colour backdrop (mesh/radial) becomes a picture behind the section; the ramp above wins when one fits.
            var backdrop = !bandGradient && band.height >= 160 ? window.PageGeneratorDetectors.detectBackdrop(analysisPixels(analysis), analysis.width, analysis.height, { x: 0, y: band.y, width: analysis.width, height: band.height }, foregroundRects(analysis, band.y, band.height), false) : null;
            return {
                id: randomId(),
                sourceGroup: analysis.sourceGroup,
                type: type,
                inner: false,
                settings: { direction: 'column', gap: 16, sourceWidth: analysis.width, sourceHeight: analysis.height },
                source: index === 0 ? { url: uploadedData.url, attachmentId: uploadedData.id, fileName: analysis.file ? analysis.file.name : '' } : null,
                detectedRegions: analysis.boxes.filter(function (box) { return box.y >= band.y && box.y < band.y + band.height; }),
                elements: children,
                children: children,
                layout: semantic.layout,
                background: band.background || semantic.background,
                bands: [band],
                bbox: { x: 0, y: band.y, width: analysis.width, height: band.height },
                style: bandGradient ? { background: band.background || semantic.background, gradient: bandGradient } : (backdrop ? { background: band.background || semantic.background, backdrop: backdrop } : { background: band.background || semantic.background }),
                behavior: { type: 'none' },
                confidence: type === 'section' ? .55 : .72,
                detection: { detectedBy: ['opencv', 'ocr', 'color-analysis', 'section-bands'], manual: false }
            };
        }).filter(function (section) { return section.children.length || section.type === 'footer'; });
        if (sections.length) {
            sections[0].source = {
                url: uploadedData.url,
                attachmentId: uploadedData.id,
                fileName: uploadedData.fileName || (analysis.file ? analysis.file.name : '')
            };
        }
        return sections.length ? sections : [{
            id: randomId(), sourceGroup: analysis.sourceGroup, type: semantic.type, inner: false,
            settings: { direction: 'column', gap: 16, sourceWidth: analysis.width, sourceHeight: analysis.height },
            source: { url: uploadedData.url, attachmentId: uploadedData.id, fileName: uploadedData.fileName || (analysis.file ? analysis.file.name : '') },
            detectedRegions: analysis.boxes, elements: semantic.elements, children: semantic.elements,
            layout: semantic.layout, background: semantic.background, bands: analysis.sections || [],
            bbox: { x: 0, y: 0, width: analysis.width, height: analysis.height },
            style: { background: semantic.background }, behavior: { type: 'none' },
            confidence: semantic.confidence, detection: { detectedBy: ['opencv', 'ocr', 'color-analysis'], manual: false }
        }];
    }

    function isDarkBackground(color) {
        var rgb = hexToRgb(color);
        return rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 < 90;
    }

    function classifyBand(band, children, analysis, index, total) {
        var text = children.map(function (node) { return node.text || node.content || ''; }).join(' ').toLowerCase();
        if (index === 0 && children.length >= 2) return 'header';
        if (index >= total - 2 && total >= 3 && isDarkBackground(band.background)) return 'footer';
        if (inputSurfaces(analysis, band).length >= 2) return 'form-section';
        // Only table headers and alert titles identify those bands; card labels such as "Рівень шуму" or a "Перевищення" badge do not.
        if (/таблиц|дата і час/.test(text)) return 'table-section';
        if (/увага|alert/.test(text)) return 'alert-section';
        return 'section';
    }

    function analyzeLayout(analysis, textElements) {
        var width = analysis.width;
        var height = analysis.height;
        var background = analysis.colors && analysis.colors.length ? analysis.colors[0] : '#ffffff';
        var elements = [];
        var textByRegion = analysis.boxes.map(function (box) {
            return textElements.filter(function (item) {
                if (!item) return false;
                var settings = item.settings || {};
                var centerX = settings.x + settings.width / 2;
                var centerY = settings.y + settings.height / 2;
                return centerX >= box.x && centerX <= box.x + box.width && centerY >= box.y && centerY <= box.y + box.height;
            });
        });
        var usedText = {};
        var rows = groupRegions(analysis.boxes).filter(function (row) {
            return isUsableRegionRow(row, analysis);
        });
        rows.forEach(function (row) {
            var repeated = row.length >= 2 && similarRegions(row);
            if (repeated) {
                var items = row.map(function (box) {
                    var index = analysis.boxes.indexOf(box);
                    var content = (textByRegion[index] || []).map(function (item) {
                        return item;
                    });
                    var itemType = content.length ? classifyRegionContent(content, box) :
                        (box.kind === 'photo-candidate' ? 'image' : 'surface');
                    if (itemType === 'surface') {
                        return null;
                    }
                    content.forEach(function (item) { usedText[item.id] = true; });
                    var itemChildren = content;
                    var itemNode = {
                        id: randomId(),
                        type: itemType === 'image' ? 'image' : 'card',
                        role: itemType === 'image' ? 'image' : 'content-card',
                        content: content.length ? content[0].content : '',
                        text: content.map(function (item) { return item.text; }).join(' '),
                        asset: box.asset || null,
                        url: box.asset ? box.asset.url : '',
                        bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
                        settings: {
                            x: box.x, y: box.y, width: box.width, height: box.height,
                            background: sampleRegionColor(analysis, box),
                            radius: box.rounded || 0,
                            gradient: box.gradient,
                            variance: box.variance
                        },
                        style: Object.assign({
                            background: sampleRegionColor(analysis, box),
                            borderRadius: box.rounded || 0,
                            gradient: box.gradient
                        }, itemType === 'image' ? {} : sampleCardEdges(analysis.canvas, box)),
                        children: itemChildren,
                        elements: itemChildren,
                        behavior: { type: 'none' },
                        confidence: itemType === 'image' ? 0.68 : 0.72,
                        detection: { detectedBy: ['opencv', 'ocr', 'texture-analysis'], regionIndex: index, manual: false }
                    };
                    return itemNode;
                }).filter(function (item) { return item !== null; });
                if (items.length < 2) return;
                var gridNode = {
                    id: randomId(),
                    type: items.some(function (item) { return item.type === 'image'; }) ? 'gallery' : 'grid',
                    role: items.some(function (item) { return item.type === 'image'; }) ? 'image-gallery' : 'card-grid',
                    settings: { direction: 'row', columns: items.length, gap: estimateGap(row), x: row[0].x, y: row[0].y, width: row.reduce(function (sum, item) { return sum + item.width; }, 0) },
                    bbox: groupBoundingBox(row),
                    style: { gap: estimateGap(row) },
                    children: items,
                    elements: items,
                    behavior: { type: 'none' },
                    confidence: similarRegions(row) ? 0.78 : 0.52,
                    source: { detectedBy: ['opencv', 'repetition-analysis'], manual: false }
                };
                elements.push(gridNode);
            }
        });
        var representedBoxes = [];
        elements.forEach(function (node) {
            getNodeChildren(node).forEach(function (child) {
                if (child.detection && child.detection.regionIndex !== undefined) representedBoxes.push(child.detection.regionIndex);
            });
        });
        (analysis.boxes || []).forEach(function (box, index) {
            if (representedBoxes.indexOf(index) !== -1) return;
            var regionText = textByRegion[index] || [];
            var isVisual = box.kind === 'photo-candidate';
            if (!isVisual) return;
            var visualType = box.kind === 'photo-candidate' && box.asset ? 'image' : 'card';
            var visualChildren = regionText.slice();
            visualChildren.forEach(function (item) { usedText[item.id] = true; });
            elements.push({
                id: randomId(),
                type: visualType,
                role: visualType === 'image' ? 'image' : 'content-card',
                text: visualChildren.map(function (item) { return item.text; }).join(' '),
                content: visualChildren.length ? visualChildren[0].content : '',
                asset: box.asset || null,
                url: box.asset ? box.asset.url : '',
                bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
                settings: { x: box.x, y: box.y, width: box.width, height: box.height },
                style: Object.assign({
                    background: sampleRegionColor(analysis, box),
                    borderRadius: box.rounded || 0
                }, visualType === 'image' ? {} : sampleCardEdges(analysis.canvas, box)),
                children: visualChildren,
                elements: visualChildren,
                behavior: { type: 'none' },
                confidence: visualType === 'image' ? .7 : .62,
                detection: {
                    detectedBy: ['opencv', 'texture-analysis', 'spatial-ownership'],
                    regionIndex: index,
                    manual: false
                }
            });
        });
        addSurfaceCards(analysis, textElements, elements, usedText);
        textElements.forEach(function (item) {
            if (!usedText[item.id]) elements.push(item);
        });
        var iconImages = (analysis.icons || []).map(function (icon) {
            return {
                id: randomId(),
                type: 'image',
                role: 'icon',
                asset: icon.asset,
                url: icon.asset.url,
                text: '',
                content: '',
                bbox: { x: icon.x, y: icon.y, width: icon.width, height: icon.height },
                settings: { x: icon.x, y: icon.y, width: icon.width, height: icon.height },
                style: {},
                children: [],
                elements: [],
                behavior: { type: 'none' },
                confidence: .66,
                detection: { detectedBy: ['pixel-analysis', 'icon-blob'], manual: false }
            };
        });
        iconImages.forEach(function (node) { elements.push(node); });
        (analysis.boxes || []).filter(function (box) {
            return !iconImages.some(function (node) { return centerInside(box, node.bbox) || centerInside(node.bbox, box); });
        }).filter(function (box) {
            return box.width <= analysis.width * .12 && box.height <= analysis.width * .12 &&
                box.width >= 10 && box.height >= 10 && !textByRegion[analysis.boxes.indexOf(box)].length;
        }).filter(function (box) {
            var overlapsText = textElements.some(function (item) {
                var textBox = nodeBox(item);
                return centerInside(textBox, box) || centerInside(box, textBox);
            });
            var insideControl = (analysis.surfaces || []).some(function (surface) {
                return ['button', 'badge', 'input'].indexOf(surface.kind) !== -1 && centerInside(box, surface);
            });
            return !overlapsText && !insideControl;
        }).filter(function (box) {
            return !(analysis.boxes || []).some(function (photo) {
                return photo.kind === 'photo-candidate' && photo.width > 150 && photo.height > 150 &&
                    centerInside(box, photo) && photo !== box;
            });
        }).forEach(function (box) {
            elements.push({
                id: randomId(),
                type: 'icon',
                role: box.rounded ? 'icon-button' : 'icon',
                bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
                settings: { x: box.x, y: box.y, width: box.width, height: box.height },
                style: Object.assign({ background: box.background || '#ffffff', borderRadius: box.rounded || 0 }, box.borderColor ? { borderColor: box.borderColor, borderWidth: 1 } : {}),
                children: [],
                elements: [],
                behavior: { type: box.rounded ? 'click' : 'none' },
                confidence: .58,
                detection: { detectedBy: ['opencv', 'shape-analysis'], manual: false }
            });
        });
        elements.sort(function (a, b) { return (a.settings && a.settings.y || 0) - (b.settings && b.settings.y || 0); });
        var type = classifySection(textElements, analysis);
        var classifiedElements = classifySectionChildren(elements, type, analysis);
        return { elements: classifiedElements, layout: 'semantic-component-tree', background: background, type: type, confidence: type === 'section' ? 0.48 : 0.7 };
    }

    function boxOverlapRatio(first, second) {
        var left = Math.max(first.x, second.x);
        var top = Math.max(first.y, second.y);
        var right = Math.min(first.x + first.width, second.x + second.width);
        var bottom = Math.min(first.y + first.height, second.y + second.height);
        if (right <= left || bottom <= top) return 0;
        var shared = (right - left) * (bottom - top);
        return shared / (first.width * first.height + second.width * second.height - shared);
    }

    // Cards come from flat-colour plates, so they do not depend on contour filters that drop near-full-width blocks.
    function addSurfaceCards(analysis, textElements, elements, usedText) {
        var cards = (analysis.surfaces || []).filter(function (surface) {
            return surface.kind === 'card' && surface.width < analysis.width * .99;
        });
        var area = function (box) { return box.width * box.height; };
        cards.slice().sort(function (a, b) { return area(b) - area(a); }).forEach(function (surface) {
            var exists = elements.some(function (node) {
                return ['card', 'image', 'grid', 'gallery'].indexOf(node.type) !== -1 && boxOverlapRatio(nodeBox(node), surface) > .7;
            });
            if (exists) return;
            var content = textElements.filter(function (item) {
                if (usedText[item.id]) return false;
                var box = nodeBox(item);
                if (!centerInside(box, surface)) return false;
                var owner = cards.filter(function (card) { return centerInside(box, card); })
                    .sort(function (a, b) { return area(a) - area(b); })[0];
                return owner === surface;
            });
            if (!content.length) return;
            content.forEach(function (item) { usedText[item.id] = true; });
            elements.push({
                id: randomId(),
                type: 'card',
                role: 'content-card',
                text: '',
                content: '',
                bbox: { x: surface.x, y: surface.y, width: surface.width, height: surface.height },
                settings: { x: surface.x, y: surface.y, width: surface.width, height: surface.height },
                style: { background: surface.background, borderRadius: surface.rounded || 0 },
                children: content,
                elements: content,
                behavior: { type: 'none' },
                confidence: .7,
                detection: { detectedBy: ['surface-geometry', 'spatial-ownership'], manual: false }
            });
        });
    }

    function isUsableRegionRow(row, analysis) {
        if (!row || row.length < 2) return false;
        var maxWidth = analysis.width * .45;
        var maxHeight = analysis.width * .35;
        var usable = row.filter(function (box) {
            return box.width >= 45 && box.height >= 28 &&
                box.width <= maxWidth && box.height <= maxHeight &&
                (box.kind === 'photo-candidate' || box.textLike || box.variance < 90);
        });
        return usable.length >= 2;
    }

    // Controls detectFormFields misses: a checkbox (small square + label) and a lone select (wide field with a chevron).
    // Their label and placeholder text nodes are absorbed into the control so they are not drawn twice.
    function findStandaloneControls(analysis, textElements, scope, sectionType) {
        var nodes = [];
        var absorbed = {};
        var inScope = function (item) { return !scope || boxIntersectsScope(item, scope); };
        var itemOf = function (node) { return node.bbox || node.settings || null; };
        var textOf = function (node) { return node.text || node.content || ''; };
        textElements.forEach(function (node) {
            var item = itemOf(node);
            if (!textOf(node).trim() || !item || !inScope(item)) return;
            var check = findCheckboxBeside(analysis.canvas, item);
            if (!check) return;
            absorbed[node.id] = true;
            nodes.push(makeControlNode('checkbox', textOf(node), '', {
                x: check.x, y: Math.min(check.y, item.y),
                width: item.x + item.width - check.x, height: Math.max(check.height, item.height)
            }, '#ffffff'));
        });
        (analysis.allRegions || analysis.boxes || []).forEach(function (box) {
            if (!inScope(box) || box.kind === 'photo-candidate') return;
            if (box.width < analysis.width * .2 || box.height < 24 || box.height > 90) return;
            if ((box.uniform || 0) < .8 || !hasChevron(analysis.canvas, box)) return;
            var inside = textElements.filter(function (node) {
                var item = itemOf(node);
                return item && !absorbed[node.id] && centerInside(item, box);
            });
            var label = textElements.filter(function (node) {
                var item = itemOf(node);
                return item && !absorbed[node.id] && item.y + item.height <= box.y + 4 &&
                    box.y - (item.y + item.height) < Math.max(35, box.height * 2) &&
                    Math.abs(item.x - box.x) < Math.max(40, box.width * .25);
            }).sort(function (a, b) { return (itemOf(b).y + itemOf(b).height) - (itemOf(a).y + itemOf(a).height); })[0];
            inside.concat(label ? [label] : []).forEach(function (node) { absorbed[node.id] = true; });
            var fill = readRegion(analysis.canvas, box.x + 4, box.y + box.height / 2 - 2, 4, 4).at(1, 1);
            nodes.push(makeControlNode('select', label ? textOf(label) : 'Поле', inside.map(textOf).join(' ').trim(), box, toHex(fill)));
        });
        if (sectionType !== 'form-section') {
            findChevronSelects(analysis, textElements, absorbed, inScope).forEach(function (found) {
                var label = textElements.filter(function (node) {
                    var item = itemOf(node);
                    return item && !absorbed[node.id] && item.y + item.height <= found.box.y + 4 &&
                        found.box.y - (item.y + item.height) < Math.max(35, found.box.height * 2) &&
                        Math.abs(item.x - found.box.x) < Math.max(40, found.box.width * .25);
                }).sort(function (a, b) { return (itemOf(b).y + itemOf(b).height) - (itemOf(a).y + itemOf(a).height); })[0];
                absorbed[found.node.id] = true;
                if (label) absorbed[label.id] = true;
                nodes.push(makeControlNode('select', label ? textOf(label) : 'Поле', textOf(found.node).trim(), found.box, found.fill));
            });
        }
        return { nodes: nodes, absorbed: absorbed };
    }

    // Fallback for a select the region detector did not outline: a text value with a chevron to its right, inside a
    // bordered field. The field is measured from the text and the chevron, then both vertical borders are checked.
    function findChevronSelects(analysis, textElements, absorbed, inScope) {
        var canvas = analysis.canvas;
        var found = [];
        var itemOf = function (node) { return node.bbox || node.settings || null; };
        textElements.forEach(function (node) {
            var item = itemOf(node);
            if (!item || absorbed[node.id] || !(node.text || node.content || '').trim() || !inScope(item)) return;
            if (item.width > analysis.width * .5) return;
            var height = Math.round(Math.max(item.height * 2.6, 40));
            var top = Math.round(item.y + item.height / 2 - height / 2);
            var scan = readRegion(canvas, item.x + item.width + 4, top, analysis.width * .6, height);
            var background = scan.at(0, 0);
            var inkColumn = function (x) {
                var count = 0;
                for (var y = 0; y < scan.height; y += 1) if (rgbGap(scan.at(x, y), background) >= 90) count += 1;
                return count;
            };
            var chevronLeft = -1;
            for (var x = 0; x < scan.width && chevronLeft < 0; x += 1) {
                var inked = inkColumn(x);
                if (inked >= 3 && inked <= 40) chevronLeft = x;
            }
            if (chevronLeft < 0) return;
            var chevronRight = chevronLeft;
            while (chevronRight + 1 < scan.width && chevronRight - chevronLeft < 24 && inkColumn(chevronRight + 1) > 0) chevronRight += 1;
            if (chevronRight - chevronLeft > 20) return;
            var fieldLeft = Math.round(item.x - 31);
            var borderLine = function (x) {
                var column = readRegion(canvas, x - 1, top, 3, height);
                var lined = 0;
                for (var y = 0; y < column.height; y += 1) {
                    if (rgbGap(column.at(1, y), column.at(0, y)) >= 8 || rgbGap(column.at(1, y), column.at(2, y)) >= 8) lined += 1;
                }
                return lined / Math.max(1, column.height) >= .6;
            };
            // The right edge is estimated from the chevron, so the real line is searched for close to that estimate.
            var estimatedRight = Math.round(item.x + item.width + 4 + chevronRight + 14);
            var fieldRight = -1;
            for (var offset = 0; offset <= 10 && fieldRight < 0; offset += 1) {
                if (borderLine(estimatedRight - offset)) fieldRight = estimatedRight - offset;
                else if (offset && borderLine(estimatedRight + offset)) fieldRight = estimatedRight + offset;
            }
            if (fieldRight < 0 || !borderLine(fieldLeft)) return;
            var fill = readRegion(canvas, fieldLeft + 6, top + height - 8, 4, 4).at(1, 1);
            found.push({ node: node, box: { x: fieldLeft, y: top, width: fieldRight - fieldLeft, height: height }, fill: toHex(fill) });
        });
        return found;
    }

    var splitRequiredMark = function (label, placeholder) { return window.PageGeneratorDetectors.splitRequiredMark(label, placeholder); };

    function makeControlNode(fieldType, label, placeholder, bbox, background) {
        var marked = splitRequiredMark(label, placeholder);
        label = marked.label;
        placeholder = marked.placeholder;
        return {
            id: randomId(),
            type: 'form-field',
            fieldType: fieldType,
            role: 'form-field',
            required: marked.required,
            label: label,
            placeholder: placeholder,
            labelBox: null,
            children: [],
            elements: [],
            bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
            settings: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
            style: { background: background, borderRadius: 0 },
            behavior: { type: 'input' },
            confidence: .7,
            detection: { detectedBy: ['opencv', 'control-geometry'], manual: false }
        };
    }

    function classifyStructuredContent(elements, textElements, analysis, sectionType, scope) {
        var controls = findStandaloneControls(analysis, textElements, scope, sectionType);
        if (!controls.nodes.length) return classifyStructuredContentBase(elements, textElements, analysis, sectionType, scope);
        // Text inside a control is the control's value. The same OCR word can also sit inside a card of this band, so the
        // prune runs through the whole subtree and matches by position as well as by id.
        var textTypes = ['text', 'heading', 'link', 'badge'];
        var insideControl = function (node) {
            var item = node.bbox || node.settings;
            return item && textTypes.indexOf(node.type) !== -1 && controls.nodes.some(function (control) { return centerInside(item, control.bbox); });
        };
        var prune = function (nodes) {
            return (nodes || []).filter(function (node) {
                if (controls.absorbed[node.id] || insideControl(node)) return false;
                var shared = node.elements === node.children;
                if (node.children) node.children = prune(node.children);
                if (node.elements) node.elements = shared ? node.children : prune(node.elements);
                return true;
            });
        };
        var rest = prune(elements);
        var restText = textElements.filter(function (node) { return !controls.absorbed[node.id] && !insideControl(node); });
        return classifyStructuredContentBase(rest, restText, analysis, sectionType, scope).concat(controls.nodes);
    }

    function classifyStructuredContentBase(elements, textElements, analysis, sectionType, scope) {
        var formFields = detectFormFields(analysis, textElements, scope);
        var tableEvidence = detectTableEvidence(analysis, textElements, scope);
        var hasVisualComponents = elements.some(function (node) {
            return ['grid', 'gallery', 'card', 'image', 'navigation'].indexOf(node.type) !== -1;
        });
        var textNodeCount = elements.filter(function (node) {
            return Boolean((node.text || node.content || '').trim());
        }).length;
        if (formFields.length >= 2 && sectionType === 'form-section') {
            var withForm = buildFormInElements(elements, formFields);
            if (withForm) return withForm;
        }
        if (formFields.length === 1 && formFields[0].detection.detectedBy.indexOf('outlined-field') !== -1) {
            var field = formFields[0].bbox;
            var submit = collectByType(elements, 'button', []).some(function (button) {
                var box = nodeBox(button);
                return box.y >= field.y + field.height - 4 && box.y - (field.y + field.height) <= field.height * 3 &&
                    box.x < field.x + field.width && box.x + box.width > field.x;
            });
            if (submit) return buildFormInElements(elements, formFields, true);
        }
        if (tableEvidence.isTable && !hasVisualComponents && textNodeCount >= 3) {
            return [makeTableNode(elements, .76)];
        }
        return elements.map(function (node) {
            if (node.type === 'grid') {
                node.children = getNodeChildren(node).map(function (card) {
                    card.children = classifyCardChildren(getNodeChildren(card), card);
                    card.elements = card.children;
                    return card;
                });
                node.elements = node.children;
            }
            return node;
        });
    }

    function classifyCardChildren(children, card) {
        var ordered = children.slice().sort(function (a, b) {
            return (a.bbox && a.bbox.y || a.settings && a.settings.y || 0) - (b.bbox && b.bbox.y || b.settings && b.settings.y || 0);
        });
        return ordered.map(function (child) {
            if (['button', 'badge', 'link', 'image', 'icon', 'form', 'form-field', 'card', 'table'].indexOf(child.type) !== -1) return child;
            child.role = child.type === 'heading' ? 'card-heading' : 'card-paragraph';
            return child;
        });
    }

    function makeStructuredNode(type, role, children, confidence) {
        var node = {
            id: randomId(),
            type: type,
            role: role,
            children: children,
            elements: children,
            bbox: children.length ? groupBoundingBox(children.map(function (child) {
                return child.bbox || child.settings;
            })) : { x: 0, y: 0, width: 0, height: 0 },
            style: {},
            behavior: { type: 'none' },
            confidence: confidence,
            detection: { detectedBy: ['ocr', 'layout-rules'], manual: false }
        };
        return node;
    }

    function nodeBox(node) {
        return node.bbox || node.settings || { x: 0, y: 0, width: 0, height: 0 };
    }

    function centerInside(box, outer) {
        var cx = box.x + box.width / 2;
        var cy = box.y + box.height / 2;
        return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
    }

    function collectByType(nodes, type, found) {
        (nodes || []).forEach(function (node) {
            if (node.type === type) found.push(node);
            collectByType(getNodeChildren(node), type, found);
        });
        return found;
    }

    // The form replaces only what lies inside its own box; headings and descriptions around it are kept.
    function buildFormInElements(elements, fields, keepLoose) {
        var fieldsBox = groupBoundingBox(fields.map(function (field) { return field.bbox; }));
        var wrapper = null;
        elements.forEach(function (node) {
            var box = nodeBox(node);
            var contains = box.x <= fieldsBox.x + 2 && box.y <= fieldsBox.y + 2 &&
                box.x + box.width >= fieldsBox.x + fieldsBox.width - 2 && box.y + box.height >= fieldsBox.y + fieldsBox.height - 2;
            if (contains && node.type === 'card' && (!wrapper || box.width * box.height < nodeBox(wrapper).width * nodeBox(wrapper).height)) wrapper = node;
        });
        var formBox = wrapper ? Object.assign({}, nodeBox(wrapper)) : Object.assign({}, fieldsBox);
        var buttons = collectByType(elements, 'button', []).filter(function (button) {
            var box = nodeBox(button);
            var insideField = fields.some(function (field) { return centerInside(box, field.bbox); });
            return !insideField && centerInside(box, wrapper ? formBox : {
                x: fieldsBox.x - 8, y: fieldsBox.y, width: fieldsBox.width + 16, height: fieldsBox.height + box.height * 3
            });
        });
        if (!wrapper) {
            var all = fields.map(function (field) { return field.bbox; }).concat(buttons.map(nodeBox));
            fields.forEach(function (field) { if (field.labelBox) all.push(field.labelBox); });
            formBox = groupBoundingBox(all);
        }
        var children = fields.concat(buttons);
        if (keepLoose) {
            // Hints and other text inside the form that is neither a field's placeholder nor its label stay with the form instead of vanishing.
            elements.forEach(function (node) {
                var box = nodeBox(node);
                var consumed = node === wrapper || buttons.indexOf(node) !== -1 || node.type === 'card' ||
                    fields.some(function (field) {
                        return centerInside(box, field.bbox) || (field.labelBox && centerInside(box, field.labelBox));
                    });
                if (!consumed && centerInside(box, formBox)) children.push(node);
            });
        }
        children.sort(function (a, b) { return nodeBox(a).y - nodeBox(b).y; });
        var form = makeStructuredNode('form', 'form', children, .72);
        form.bbox = formBox;
        form.settings = { x: formBox.x, y: formBox.y, width: formBox.width, height: formBox.height };
        form.style = wrapper ? Object.assign({}, wrapper.style) : {};
        form.detection = { detectedBy: ['surface-geometry', 'alignment-analysis'], manual: false };
        var kept = elements.filter(function (node) {
            return node !== wrapper && !centerInside(nodeBox(node), formBox);
        });
        kept.push(form);
        return kept.sort(function (a, b) { return nodeBox(a).y - nodeBox(b).y; });
    }

    function inputSurfaces(analysis, scope) {
        return (analysis.surfaces || []).filter(function (surface) {
            return surface.kind === 'input' && (!scope || boxIntersectsScope(surface, scope));
        });
    }

    function loneOutlinedFields(analysis, textElements, scope) {
        return (analysis.surfaces || []).filter(function (surface) {
            if (!surface.outlined || surface.kind === 'input' || (scope && !boxIntersectsScope(surface, scope))) return false;
            var inside = textElements.filter(function (node) {
                return centerInside(node.bbox || node.settings || { x: 0, y: 0, width: 0, height: 0 }, surface);
            });
            if (inside.length !== 1) return false;
            var box = inside[0].bbox || inside[0].settings;
            var centre = box.x + box.width / 2;
            return box.x - surface.x <= Math.max(surface.height, analysis.width * .03) && centre < surface.x + surface.width * .5;
        }).map(function (surface) {
            return Object.assign({}, surface, { lone: true });
        });
    }

    function detectFormFields(analysis, textElements, scope) {
        var surfaceFields = inputSurfaces(analysis, scope);
        var candidates = surfaceFields.length >= 2 ? surfaceFields : (analysis.boxes || []).filter(function (box) {
            if (scope && !boxIntersectsScope(box, scope)) return false;
            var ratio = box.width / Math.max(1, box.height);
            return box.width >= analysis.width * .16 &&
                box.height >= 22 &&
                box.height <= analysis.width * .12 &&
                ratio >= 2 &&
                ratio <= 18 &&
                box.variance < 45;
        });
        // A box whose centre sits on a button plate is that button, not a field (a button under a field is aligned with it in the same column).
        var buttonPlates = (analysis.surfaces || []).filter(function (surface) { return surface.kind === 'button'; });
        candidates = candidates.filter(function (candidate) {
            return !buttonPlates.some(function (plate) { return centerInside(candidate, plate); });
        });
        var aligned = candidates.filter(function (candidate) {
            return candidates.some(function (other) {
                var gapLimit = Math.max(24, candidate.height * 2.5);
                if (candidate.tall && other !== candidate) return other.y < candidate.y + candidate.height && other.y + other.height > candidate.y;
                return other !== candidate &&
                    Math.abs(other.x - candidate.x) <= Math.max(16, candidate.width * .12) &&
                    (Math.abs((other.y + other.height) - candidate.y) <= gapLimit || Math.abs((candidate.y + candidate.height) - other.y) <= gapLimit);
            });
        });
        // A single outlined field has no sibling to confirm it, so it needs its own evidence: a thin line on all four sides, and exactly one
        // line of text inside that starts at the left (a centred line is a button, not a field).
        loneOutlinedFields(analysis, textElements, scope).forEach(function (surface) {
            if (!aligned.some(function (box) { return Math.abs(box.x - surface.x) < 8 && Math.abs(box.y - surface.y) < 8; })) aligned.push(surface);
        });
        return aligned.map(function (box) {
            var labelNode = textElements.filter(function (node) {
                var item = node.bbox || node.settings || {};
                return item.y < box.y && box.y - (item.y + item.height) < Math.max(35, box.height * 2) &&
                    Math.abs(item.x - box.x) < Math.max(40, box.width * .25);
            }).sort(function (a, b) {
                return ((b.bbox || b.settings).y || 0) - ((a.bbox || a.settings).y || 0);
            })[0];
            var label = labelNode ? (labelNode.text || labelNode.content || '') : '';
            var placeholder = textElements.filter(function (node) {
                return centerInside(node.bbox || node.settings || { x: 0, y: 0, width: 0, height: 0 }, box);
            }).sort(function (a, b) {
                return ((a.bbox || a.settings).x || 0) - ((b.bbox || b.settings).x || 0);
            }).map(function (node) { return node.text || node.content || ''; }).join(' ').trim();
            var typical = candidates.map(function (item) { return item.height; }).sort(function (a, b) { return a - b; })[Math.floor(candidates.length / 2)] || box.height;
            var marked = splitRequiredMark(label, placeholder);
            label = marked.label;
            placeholder = marked.placeholder;
            return {
                id: randomId(),
                type: 'form-field',
                fieldType: detectFieldType(label, placeholder, box.height > typical * 1.8),
                role: 'form-field',
                required: marked.required,
                label: label || 'Поле',
                placeholder: placeholder,
                labelBox: labelNode ? Object.assign({}, nodeBox(labelNode)) : null,
                children: [],
                elements: [],
                bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
                settings: { x: box.x, y: box.y, width: box.width, height: box.height },
                style: { background: box.background || '#ffffff', borderRadius: box.rounded || 0 },
                behavior: { type: 'input' },
                confidence: .74,
                detection: { detectedBy: box.lone ? ['surface-geometry', 'outlined-field'] : ['opencv', 'alignment-analysis'], manual: false }
            };
        });
    }

    function detectTableEvidence(analysis, textElements, scope) {
        var boxes = (analysis.boxes || []).filter(function (box) {
            if (scope && !boxIntersectsScope(box, scope)) return false;
            return box.width >= 30 && box.height >= 18 && box.width <= analysis.width * .45;
        });
        var rows = [];
        boxes.forEach(function (box) {
            var row = rows.find(function (candidate) { return Math.abs(candidate.y - box.y) <= Math.max(10, box.height * .35); });
            if (!row) { row = { y: box.y, boxes: [] }; rows.push(row); }
            row.boxes.push(box);
        });
        var regularRows = rows.filter(function (row) { return row.boxes.length >= 2; });
        var columns = regularRows.length ? Math.max.apply(null, regularRows.map(function (row) { return row.boxes.length; })) : 0;
        var text = textElements.map(function (node) { return node.text || node.content || ''; }).join(' ').toLowerCase();
        var keywordScore = /дата|час|місц|рівень|статус|таблиц/.test(text) ? 1 : 0;
        var stableRows = regularRows.filter(function (row) {
            var ordered = row.boxes.slice().sort(function (a, b) { return a.x - b.x; });
            if (ordered.length < 2) return false;
            var gaps = [];
            for (var index = 1; index < ordered.length; index += 1) {
                gaps.push(ordered[index].x - (ordered[index - 1].x + ordered[index - 1].width));
            }
            var averageGap = gaps.reduce(function (sum, value) { return sum + value; }, 0) / gaps.length;
            return gaps.every(function (value) { return Math.abs(value - averageGap) <= Math.max(12, analysis.width * .06); });
        });
        var columnStarts = [];
        stableRows.forEach(function (row) {
            row.boxes.slice().sort(function (a, b) { return a.x - b.x; }).forEach(function (box, index) {
                columnStarts[index] = columnStarts[index] || [];
                columnStarts[index].push(box.x);
            });
        });
        var stableColumns = columnStarts.filter(function (starts) {
            if (starts.length < 3) return false;
            var average = starts.reduce(function (sum, value) { return sum + value; }, 0) / starts.length;
            return starts.filter(function (value) { return Math.abs(value - average) <= Math.max(12, analysis.width * .04); }).length >= starts.length * .7;
        }).length;
        var repeatedWidths = stableRows.length >= 3 && stableRows.every(function (row) {
            var widths = row.boxes.map(function (box) { return box.width; });
            var average = widths.reduce(function (sum, value) { return sum + value; }, 0) / widths.length;
            return widths.every(function (value) { return Math.abs(value - average) / Math.max(1, average) < .45; });
        });
        var isTable = keywordScore > 0 && stableRows.length >= 3 && stableColumns >= 2 && repeatedWidths;
        return { rows: regularRows.length, columns: columns, score: keywordScore + stableRows.length + stableColumns, isTable: isTable };
    }

    function boxIntersectsScope(box, scope) {
        var top = Number(box.y || 0);
        var bottom = top + Number(box.height || 0);
        var scopeTop = Number(scope.y || 0);
        var scopeBottom = scopeTop + Number(scope.height || 0);
        return top < scopeBottom && bottom > scopeTop;
    }

    function detectFieldType(label, placeholder, tall) {
        if (tall) return 'textarea';
        if (/@/.test(placeholder || '')) return 'email';
        if (/^[a-zа-яіїє]{1,4}[\/.\-][a-zа-яіїє]{1,4}[\/.\-][a-zа-яіїє]{2,4}$/i.test((placeholder || '').trim())) return 'date';
        if (/email|електрон/i.test(label)) return 'email';
        if (/телефон|phone/i.test(label)) return 'phone';
        if (/дата|date/i.test(label)) return 'date';
        if (/об.?єкт|тип|оберіть|select/i.test(label)) return 'select';
        if (/опис|коментар|повідомлен/i.test(label)) return 'textarea';
        if (/погодж|згод|checkbox/i.test(label)) return 'checkbox';
        return 'text';
    }

    function makeTableNode(elements, confidence) {
        var cells = [];
        elements.forEach(function (node) {
            if (node.type === 'grid') cells = cells.concat(getNodeChildren(node));
            else if (node.text || node.content) cells.push(node);
        });
        var rows = [];
        cells.sort(function (a, b) {
            var ay = (a.bbox && a.bbox.y) || (a.settings && a.settings.y) || 0;
            var by = (b.bbox && b.bbox.y) || (b.settings && b.settings.y) || 0;
            return ay - by;
        }).forEach(function (cell) {
            var y = (cell.bbox && cell.bbox.y) || (cell.settings && cell.settings.y) || 0;
            var row = rows.find(function (candidate) { return Math.abs(candidate.y - y) <= 18; });
            if (!row) { row = { y: y, cells: [] }; rows.push(row); }
            row.cells.push(cell);
        });
        rows.sort(function (a, b) { return a.y - b.y; });
        return Object.assign(makeStructuredNode('table', 'data-table', cells, confidence), {
            rows: rows.map(function (row) {
                return row.cells.sort(function (a, b) {
                    return ((a.bbox && a.bbox.x) || (a.settings && a.settings.x) || 0) - ((b.bbox && b.bbox.x) || (b.settings && b.settings.x) || 0);
                });
            }),
            columns: rows.length ? Math.max.apply(null, rows.map(function (row) { return row.cells.length; })) : 0
        });
    }

    function buildRecursiveTree(elements, analysis) {
        var nodes = (elements || []).map(function (node) {
            var children = getNodeChildren(node);
            node.children = buildRecursiveTree(children, analysis);
            node.elements = node.children;
            node.confidenceParts = {
                ocr: node.type === 'image' ? 1 : Number(node.confidence || .5),
                geometry: node.bbox ? .8 : .45,
                semantic: node.type && node.type !== 'section' ? Number(node.confidence || .5) : .45,
                style: node.style || node.settings ? .7 : .35
            };
            node.confidence = Math.round((node.confidenceParts.ocr * .35 + node.confidenceParts.geometry * .25 + node.confidenceParts.semantic * .3 + node.confidenceParts.style * .1) * 100) / 100;
            if (!node.behavior) node.behavior = inferBehavior(node);
            return node;
        });
        return nodes.sort(function (a, b) {
            return ((a.bbox && a.bbox.y) || (a.settings && a.settings.y) || 0) - ((b.bbox && b.bbox.y) || (b.settings && b.settings.y) || 0);
        });
    }

    function inferBehavior(node) {
        if (node.type === 'button') return { type: 'click', action: 'unknown' };
        if (node.type === 'navigation') return { type: 'mobile-menu', trigger: 'click' };
        return { type: 'none' };
    }

    function classifyTextNode(node, analysis) {
        var text = (node.text || '').trim();
        var settings = node.settings || {};
        var buttonBox = findButtonBox(node, analysis);
        var badgeBox = buttonBox ? null : findSurfaceAround(node, analysis, 'badge');
        if (buttonBox) {
            node.type = 'button';
            node.role = 'primary-action';
            node.behavior = { type: 'unknown' };
            // The region pass reports a white fill for buttons, so the plate colour is read from its inside, clear of the label.
            var plateFill = toHex(readRegion(analysis.canvas, buttonBox.x + Math.round(buttonBox.width * .08), buttonBox.y + Math.round(buttonBox.height / 2), 4, 4).at(1, 1));
            node.style.background = normalizeHexColor(plateFill || '#ffffff');
            node.style.borderRadius = buttonBox.rounded || 0;
            fitNodeToPlate(node, buttonBox);
            node.detection = {
                detectedBy: ['ocr', 'opencv', 'button-geometry'],
                manual: false,
                visualBox: buttonBox
            };
            node.confidence = .82;
        } else if (badgeBox) {
            node.type = 'badge';
            node.role = 'status-badge';
            node.style.background = normalizeHexColor(badgeBox.background || '#e2e8f0');
            node.style.borderRadius = badgeBox.rounded || 0;
            fitNodeToPlate(node, badgeBox);
            node.detection = { detectedBy: ['ocr', 'surface-geometry'], manual: false, visualBox: badgeBox };
            node.confidence = .74;
        } else if ((settings.height || 0) >= analysis.medianLine * 1.45) {
            node.type = 'heading';
            node.role = 'heading';
        } else {
            node.type = 'text';
            node.role = 'paragraph';
        }
        return node;
    }

    function normalizeOcrText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/^[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ]+/, '')
            .replace(/[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ.,:;!?'"()«»/%+#&*\- ]+$/g, '')
            .trim();
    }

    function isUsableOcrText(text, words) {
        if (!text || text.length < 2) return false;
        var letters = (text.match(/[A-Za-zА-Яа-яІіЇїЄєҐґ]/g) || []).length;
        var symbols = (text.match(/[^A-Za-zА-Яа-яІіЇїЄєҐґ0-9\s]/g) || []).length;
        var confidence = (words || []).reduce(function (sum, word) {
            return sum + Number(word.confidence || 0);
        }, 0) / Math.max(1, (words || []).length);
        var digits = (text.match(/[0-9]/g) || []).length;
        return (letters >= 2 || digits >= 3) && (letters + digits) / Math.max(1, text.length - symbols) >= .35 &&
            (confidence >= 20 || letters >= 5 || digits >= 5);
    }

    function findSurfaceAround(node, analysis, kind) {
        var box = node.bbox || node.settings || {};
        return (analysis.surfaces || []).find(function (candidate) {
            return candidate.kind === kind &&
                box.x >= candidate.x - 3 && box.y >= candidate.y - 3 &&
                box.x + box.width <= candidate.x + candidate.width + 3 &&
                box.y + box.height <= candidate.y + candidate.height + 3;
        }) || null;
    }

    // Controls are positioned by their plate, not by the text inside it; the text is centred in the plate.
    function fitNodeToPlate(node, plate) {
        var fontSize = node.style && node.style.fontSize || node.settings && node.settings.fontSize;
        node.bbox = { x: plate.x, y: plate.y, width: plate.width, height: plate.height };
        node.settings = Object.assign({}, node.settings, {
            x: plate.x, y: plate.y, width: plate.width, height: plate.height, fontSize: fontSize
        });
    }

    function findButtonBox(node, analysis) {
        var box = node.bbox || node.settings || {};
        var surface = (analysis.surfaces || []).find(function (candidate) {
            return candidate.kind === 'button' &&
                box.x >= candidate.x - 3 && box.y >= candidate.y - 3 &&
                box.x + box.width <= candidate.x + candidate.width + 3 &&
                box.y + box.height <= candidate.y + candidate.height + 3 &&
                candidate.height <= box.height * 5;
        });
        if (surface) return surface;
        return (analysis.boxes || []).find(function (candidate) {
            var contains = box.x >= candidate.x && box.y >= candidate.y &&
                box.x + box.width <= candidate.x + candidate.width &&
                box.y + box.height <= candidate.y + candidate.height;
            return contains && candidate.rounded >= 2 && candidate.width >= box.width * 1.08 &&
                candidate.width <= box.width * 3.2 &&
                candidate.height >= box.height * 1.1 && candidate.height <= box.height * 3.5 &&
                (candidate.uniform || 0) >= .8;
        }) || null;
    }

    function classifyRegionContent(content, box) {
        if (box.kind === 'photo-candidate' && !content.length) return 'image';
        if (content.some(function (item) { return item.type === 'button'; })) return 'card';
        return 'card';
    }

    function groupBoundingBox(row) {
        var left = Math.min.apply(null, row.map(function (box) { return box.x; }));
        var top = Math.min.apply(null, row.map(function (box) { return box.y; }));
        var right = Math.max.apply(null, row.map(function (box) { return box.x + box.width; }));
        var bottom = Math.max.apply(null, row.map(function (box) { return box.y + box.height; }));
        return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function classifySectionChildren(elements, sectionType, analysis) {
        if (sectionType !== 'header') return elements;
        var navigation = [];
        var content = [];
        elements.forEach(function (node) {
            var fontSize = Number(node.settings && node.settings.fontSize || 0);
            var shortTopHeading = node.type === 'heading' &&
                node.bbox &&
                node.bbox.y < analysis.width * .2 &&
                (node.text || '').length <= 32 &&
                fontSize <= Math.max(16, analysis.width * .015);
            // The page-wide type is 'header' for the whole screenshot, so only links in the top band belong to the navigation; the rest of the page's links stay in place.
            var topLink = node.type === 'link' && (!node.bbox || node.bbox.y < analysis.width * .2);
            if (topLink || shortTopHeading) {
                navigation.push(node);
            } else {
                content.push(node);
            }
        });
        if (navigation.length < 2) return elements;
        navigation.sort(function (a, b) { return a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x; });
        var firstNavY = navigation[0].bbox.y;
        var logo = content.filter(function (node) {
            return node.type === 'heading' && node.bbox && node.bbox.y < firstNavY;
        }).sort(function (a, b) { return a.bbox.y - b.bbox.y; })[0] || null;
        if (logo) content = content.filter(function (node) { return node !== logo; });
        else logo = navigation.shift();
        var cta = navigation.filter(function (node) {
            return node.type === 'button';
        });
        var ctaNode = cta.length ? cta[cta.length - 1] : null;
        if (ctaNode) navigation = navigation.filter(function (node) { return node !== ctaNode; });
        var navNode = {
            id: randomId(),
            type: 'navigation',
            role: 'navigation',
            bbox: groupBoundingBox(navigation),
            style: { display: 'flex', gap: 16 },
            children: navigation,
            elements: navigation,
            behavior: { type: 'none' },
            confidence: 0.7,
            source: { detectedBy: ['ocr', 'spatial-grouping'], manual: false }
        };
        logo.type = 'logo';
        logo.role = 'brand';
        logo.confidence = Math.max(logo.confidence || 0, 0.68);
        content.unshift(navNode);
        content.unshift(logo);
        if (ctaNode) content.push(ctaNode);
        return content;
    }

    function classifySection(textElements, analysis) {
        var validTextElements = (textElements || []).filter(function (item) { return item !== null; });
        var text = validTextElements.map(function (item) { return item.content || ''; }).join(' ').toLowerCase();
        var topText = validTextElements.filter(function (item) { return (item.settings && item.settings.y || 0) < analysis.width * .3; });
        var hasNavigation = topText.length >= 3 && topText.every(function (item) {
            return (item.settings.width || 0) < analysis.width * .3;
        });
        if (hasNavigation && topText.length >= 4) return 'header';
        if (/таблиц|дата і час|рівень шум|status|статус/.test(text) && analysis.boxes.length >= 3) return 'table-section';
        if (inputSurfaces(analysis).length >= 2) return 'form-section';
        if (/увага|alert|перевищ/.test(text)) return 'alert-section';
        return 'section';
    }

    function groupRegions(boxes) {
        var rows = [];
        boxes.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (box) {
            var row = rows.find(function (candidate) {
                return Math.abs(candidate[0].y - box.y) <= Math.max(12, box.height * .25);
            });
            if (!row) { row = []; rows.push(row); }
            row.push(box);
        });
        return rows.filter(function (row) { return row.length >= 2; });
    }

    function similarRegions(row) {
        var averageWidth = row.reduce(function (sum, box) { return sum + box.width; }, 0) / row.length;
        var averageHeight = row.reduce(function (sum, box) { return sum + box.height; }, 0) / row.length;
        return row.every(function (box) {
            return Math.abs(box.width - averageWidth) / averageWidth < .28 &&
                Math.abs(box.height - averageHeight) / averageHeight < .28;
        });
    }

    function estimateGap(row) {
        var ordered = row.slice().sort(function (a, b) { return a.x - b.x; });
        var gaps = [];
        for (var index = 1; index < ordered.length; index += 1) {
            gaps.push(ordered[index].x - (ordered[index - 1].x + ordered[index - 1].width));
        }
        return gaps.length ? Math.max(0, Math.round(gaps.reduce(function (sum, value) { return sum + value; }, 0) / gaps.length)) : 0;
    }

    function sampleRegionColor(analysis, box) {
        return normalizeHexColor(box.background || (analysis.colors && analysis.colors.length ? analysis.colors[0] : '#ffffff'));
    }

    function formatSchemaTree(schema) {
        var lines = ['Page'];
        (schema.sections || []).forEach(function (section) {
            var sectionLabel = section.type === 'header' ? 'Header' :
                section.type === 'table-section' ? 'Table section' :
                section.type === 'form-section' ? 'Form section' :
                section.type === 'alert-section' ? 'Alert section' : 'Section';
            lines.push('├── ' + sectionLabel + (section.background ? ' (' + section.background + ')' : ''));
            (section.elements || []).forEach(function (node) {
                appendTreeNode(lines, node, 2);
            });
        });
        var mobile = schema.variants && schema.variants.mobile;
        if (mobile) {
            lines.push('Mobile layout');
            (mobile.sections || []).forEach(function (section) {
                lines.push('├── Section');
                (section.elements || []).forEach(function (node) { appendTreeNode(lines, node, 2); });
            });
        }
        return lines.join('\n');
    }

    function getSchemaNodeStats(schema) {
        var total = 0;
        var classified = 0;
        var unclassified = 0;
        var tables = 0;
        var forms = 0;
        var buttons = 0;
        var images = 0;
        var lowConfidence = 0;
        function visit(nodes) {
            (nodes || []).forEach(function (node) {
                total += 1;
                if (node.type && node.type !== 'container' && node.type !== 'section') classified += 1;
                if (node.type === 'unknown' || node.type === 'region') unclassified += 1;
                if (node.type === 'table') tables += 1;
                if (node.type === 'form') forms += 1;
                if (node.type === 'button') buttons += 1;
                if (node.type === 'image' || node.type === 'gallery') images += 1;
                if (typeof node.confidence === 'number' && node.confidence < .5) lowConfidence += 1;
                visit(getNodeChildren(node));
            });
        }

        visit(schema.sections);
        return { total: total, classified: classified, unclassified: unclassified, tables: tables, forms: forms, buttons: buttons, images: images, lowConfidence: lowConfidence };
    }

    function applySchemaEdits() {
        try {
            var schema = JSON.parse($('#pg-schema-json').val());
            if (!schema || !Array.isArray(schema.sections) || !schema.sections.length) throw new Error('Схема не містить sections.');
            $('#page-generator-modal').data('schema', schema);
            $('#pg-schema-tree').text(formatSchemaTree(schema));
            $('#pg-status').text('Зміни Page Schema застосовано. Перевірте дерево перед оновленням Page.');
        } catch (error) {
            $('#pg-status').text('Не вдалося застосувати Page Schema: ' + error.message);
        }
    }

    function appendTreeNode(lines, node, depth) {
        var label = node.type === 'heading' ? 'Heading: ' + node.content :
            node.type === 'text' ? 'Paragraph: ' + node.content :
            node.type === 'button' ? 'Button: ' + node.text :
            node.type === 'badge' ? 'Badge: ' + node.text :
            node.type === 'link' ? 'Link: ' + node.text :
            node.type === 'logo' ? 'Logo: ' + node.text :
            node.type === 'navigation' ? 'Navigation: ' + getNodeChildren(node).length + ' items' :
            node.type === 'grid' ? 'Card grid: ' + (node.settings.columns || 0) + ' columns' :
            node.type === 'gallery' ? 'Gallery grid: ' + (node.settings.columns || 0) + ' columns' :
            node.type.charAt(0).toUpperCase() + node.type.slice(1);
        var confidence = typeof node.confidence === 'number' ? ' [' + Math.round(node.confidence * 100) + '%]' : '';
        lines.push(new Array(depth + 1).join('│   ') + '├── ' + label + confidence);
        getNodeChildren(node).forEach(function (child) { appendTreeNode(lines, child, depth + 1); });
    }

    function parseDescription(description) {
        var normalized = description.toLowerCase();
        var dictionary = [
            { type: 'dropdown', terms: ['випадаюч', 'розкривн', 'dropdown', 'drop-down', 'menu'] },
            { type: 'popup', terms: ['попап', 'popup', 'modal', 'модальн', 'вікно'] },
            { type: 'alert', terms: ['алерт', 'alert', 'повідомлен', 'попереджен'] },
            { type: 'table', terms: ['таблиц', 'table'] },
            { type: 'slider', terms: ['слайдер', 'slider', 'карусел', 'carousel'] },
            { type: 'progress', terms: ['прогрес', 'progress', 'індикатор виконання', 'progress bar'] },
            { type: 'tabs', terms: ['вкладк', 'tabs', 'tab'] },
            { type: 'accordion', terms: ['акордеон', 'accordion', 'питання відповіді', 'faq'] },
            { type: 'form', terms: ['форм', 'form', 'email', 'імейл', 'телефон'] },
            { type: 'search', terms: ['пошук', 'search'] },
            { type: 'cart', terms: ['кошик', 'cart', 'basket'] }
        ];
        return dictionary.filter(function (entry) {
            return entry.terms.some(function (term) { return normalized.indexOf(term) !== -1; });
        }).map(function (entry) {
            return { type: entry.type, source: description };
        });
    }

    function groupWordsIntoLines(words) {
        return window.PageGeneratorDetectors.groupWordsIntoLines(words);
    }

    function injectButton() {
        if ($('.page-generator-topbar-button').length) return;
        var $publish = $('button:contains("Опублікувати"), button:contains("Publish"), .elementor-top-bar__publish').first();
        if ($publish.length) {
            $('<button type="button" class="page-generator-topbar-button page-generator-button page-generator-button-primary">⚡ Page Generator</button>')
                .insertBefore($publish)
                .on('click', openPageGenerator);
            return;
        }
        var $gutenbergToolbar = $('.edit-post-header__settings, .edit-post-header__toolbar, .editor-header__settings').first();
        if (!$gutenbergToolbar.length) return;
        $('<button type="button" class="page-generator-topbar-button page-generator-button page-generator-button-primary">⚡ Page Generator</button>')
            .prependTo($gutenbergToolbar)
            .on('click', openPageGenerator);
    }

    setInterval(injectButton, 500);
}(jQuery));
