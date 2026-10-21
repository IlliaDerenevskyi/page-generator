(function (wp) {
    'use strict';
    if (!wp || !wp.hooks || !wp.blocks || !wp.element || !wp.blockEditor || !wp.components || !wp.compose) return;

    var el = wp.element.createElement;
    var Fragment = wp.element.Fragment;
    var InspectorControls = wp.blockEditor.InspectorControls;
    var PanelBody = wp.components.PanelBody;
    var TextControl = wp.components.TextControl;
    var BRIDGED = ['core/group', 'core/paragraph', 'core/heading', 'core/buttons', 'core/image', 'core/table'];
    var BOX_FIELDS = [['x', 'X'], ['y', 'Y'], ['w', 'Ширина'], ['h', 'Висота'], ['fs', 'Розмір шрифту']];

    // Core blocks keep their own markup; the pixel box is only an extra attribute, applied by CSS (frontend and editor alike).
    wp.hooks.addFilter('blocks.registerBlockType', 'page-generator/bridge-attributes', function (settings, name) {
        if (BRIDGED.indexOf(name) === -1) return settings;
        settings.attributes = Object.assign({}, settings.attributes, {
            pgBox: { type: 'object' },
            pgCanvas: { type: 'object' },
            pgFlow: { type: 'object' },
            pgId: { type: 'string' }
        });
        return settings;
    });

    function numeric(value) {
        if (value === '' || value === null || value === undefined) return undefined;
        var number = Number(value);
        return isFinite(number) ? number : undefined;
    }

    function boxVariables(attributes) {
        var style = {};
        var box = attributes.pgBox;
        var canvas = attributes.pgCanvas;
        if (box) {
            ['x', 'y', 'w', 'h', 'fs'].forEach(function (key) {
                if (typeof box[key] === 'number') style['--pg-' + key] = String(box[key]);
            });
        }
        if (canvas) {
            if (typeof canvas.w === 'number') style['--pg-w'] = String(canvas.w);
            if (typeof canvas.h === 'number') style['--pg-h'] = String(canvas.h);
        }
        return style;
    }

    wp.hooks.addFilter('editor.BlockListBlock', 'page-generator/bridge-wrapper', wp.compose.createHigherOrderComponent(function (BlockListBlock) {
        return function (props) {
            var attributes = props.attributes || {};
            if (BRIDGED.indexOf(props.name) === -1 || (!attributes.pgBox && !attributes.pgCanvas)) {
                return el(BlockListBlock, props);
            }
            var classes = [props.className || ''];
            if (attributes.pgBox) {
                classes.push('pg-abs');
                if (props.name === 'core/paragraph' || props.name === 'core/heading') classes.push('pg-text');
            }
            if (attributes.pgCanvas) classes.push('page-generator-canvas');
            var wrapperProps = Object.assign({}, props.wrapperProps, {
                style: Object.assign({}, props.wrapperProps && props.wrapperProps.style, boxVariables(attributes))
            });
            return el(BlockListBlock, Object.assign({}, props, { className: classes.join(' ').trim(), wrapperProps: wrapperProps }));
        };
    }, 'withPageGeneratorWrapper'));

    var SelectControl = wp.components.SelectControl;
    var PADDING_FIELDS = [['Зверху', 0], ['Справа', 1], ['Знизу', 2], ['Зліва', 3]];

    // A block of a flow page: its spacing (top margin, left offset, gap between children, padding) lives in pgFlow, measured from the
    // screenshot when the page was built. Editing it here is remembered in the schema (see includes/flow-spacing.php).
    function flowPanel(props) {
        var flow = props.attributes.pgFlow || {};
        var set = function (patch) { props.setAttributes({ pgFlow: Object.assign({}, flow, patch) }); };
        var controls = [];
        if (!flow.root) {
            controls.push(el(TextControl, {
                key: 'mt', label: 'Відступ зверху (px)', type: 'number', value: flow.mt === undefined ? '' : flow.mt,
                onChange: function (value) { var n = numeric(value); set({ mt: n === undefined ? 0 : n }); }
            }));
            var side = flow.ml === 'c' ? 'c' : (flow.ml === 'r' ? 'r' : 'n');
            controls.push(el(SelectControl, {
                key: 'side', label: 'Положення по горизонталі', value: side,
                options: [{ value: 'n', label: 'Від лівого краю (відступ)' }, { value: 'c', label: 'По центру' }, { value: 'r', label: 'До правого краю' }],
                onChange: function (value) { set({ ml: value === 'n' ? (typeof flow.ml === 'number' ? flow.ml : 0) : value }); }
            }));
            if (side === 'n') {
                controls.push(el(TextControl, {
                    key: 'ml', label: 'Відступ зліва (px)', type: 'number', value: typeof flow.ml === 'number' ? flow.ml : '',
                    onChange: function (value) { var n = numeric(value); set({ ml: n === undefined ? 0 : n }); }
                }));
            }
        }
        if (flow.d) {
            controls.push(el(TextControl, {
                key: 'g', label: 'Проміжок між елементами (px)', type: 'number', value: flow.g === undefined ? '' : flow.g,
                onChange: function (value) { var n = numeric(value); set({ g: n === undefined ? 0 : n }); }
            }));
        }
        if (Array.isArray(flow.p) && flow.p.length === 4) {
            PADDING_FIELDS.forEach(function (field) {
                controls.push(el(TextControl, {
                    key: 'p' + field[1], label: 'Внутрішній відступ: ' + field[0].toLowerCase() + ' (px)', type: 'number', value: flow.p[field[1]],
                    onChange: function (value) {
                        var n = numeric(value);
                        var next = flow.p.slice();
                        next[field[1]] = n === undefined ? 0 : n;
                        set({ p: next });
                    }
                }));
            });
        }
        return controls.length ? el(InspectorControls, null, el(PanelBody, { title: 'Page Generator: відступи', initialOpen: false }, controls)) : null;
    }

    wp.hooks.addFilter('editor.BlockEdit', 'page-generator/bridge-inspector', wp.compose.createHigherOrderComponent(function (BlockEdit) {
        return function (props) {
            var attributes = props.attributes || {};
            if (BRIDGED.indexOf(props.name) !== -1 && props.isSelected && attributes.pgFlow && !attributes.pgBox && !attributes.pgCanvas) {
                var panel = flowPanel(props);
                return panel ? el(Fragment, null, el(BlockEdit, props), panel) : el(BlockEdit, props);
            }
            if (BRIDGED.indexOf(props.name) === -1 || !props.isSelected || (!attributes.pgBox && !attributes.pgCanvas)) {
                return el(BlockEdit, props);
            }
            var isCanvas = Boolean(attributes.pgCanvas);
            var source = isCanvas ? attributes.pgCanvas : attributes.pgBox;
            var key = isCanvas ? 'pgCanvas' : 'pgBox';
            var fields = isCanvas ? [['w', 'Ширина джерела'], ['h', 'Висота джерела']] : BOX_FIELDS;
            var controls = fields.map(function (field) {
                return el(TextControl, {
                    key: field[0],
                    label: field[1] + ' (px)',
                    type: 'number',
                    value: source[field[0]] === undefined ? '' : source[field[0]],
                    onChange: function (value) {
                        var next = Object.assign({}, source);
                        var parsed = numeric(value);
                        if (parsed === undefined) delete next[field[0]]; else next[field[0]] = parsed;
                        var update = {};
                        update[key] = next;
                        props.setAttributes(update);
                    }
                });
            });
            return el(Fragment, null,
                el(BlockEdit, props),
                el(InspectorControls, null,
                    el(PanelBody, { title: isCanvas ? 'Page Generator: полотно' : 'Page Generator: положення', initialOpen: true }, controls)
                )
            );
        };
    }, 'withPageGeneratorInspector'));
}(window.wp));
