// A line of text sits in a box measured on the screenshot. The page's font is rarely the screenshot's, so the line can come out wider than its
// box and run into the next one. Each such line is shrunk until it fits its box (never enlarged): the fit is measured on the real font here,
// where an estimate made from the screenshot cannot know the metrics. Lines that already fit are left alone.
(function () {
    'use strict';
    if (document.body && document.body.classList.contains('elementor-editor-active')) return;
    var SLACK = 1.02;
    var FLOOR = .6;

    // Gutenberg canvas: the box is the block's min-width; a wider line makes the block wider, and a CSS variable scales its font size.
    function fitBlock(element) {
        element.style.removeProperty('--pg-fit');
        var box = parseFloat(getComputedStyle(element).minWidth);
        if (!box || box < 4) return;
        for (var pass = 0; pass < 3; pass += 1) {
            var width = element.offsetWidth;
            if (width <= box * SLACK) break;
            var current = parseFloat(element.style.getPropertyValue('--pg-fit')) || 1;
            element.style.setProperty('--pg-fit', String(Math.max(FLOOR, current * box / width)));
        }
    }

    // Elementor canvas: the widget has the box width, the text inside it is one line that may stick out; its own font size is scaled.
    function fitWidget(widget) {
        var text = widget.querySelector('.elementor-heading-title, p');
        if (!text) return;
        if (text.hasAttribute('data-pg-fit')) { text.style.removeProperty('font-size'); text.removeAttribute('data-pg-fit'); }
        var box = widget.clientWidth;
        if (!box || box < 4) return;
        var base = parseFloat(getComputedStyle(text).fontSize);
        var scale = 1;
        for (var pass = 0; pass < 3; pass += 1) {
            var width = text.scrollWidth;
            if (width <= box * SLACK) break;
            scale = Math.max(FLOOR, scale * box / width);
            text.style.fontSize = (base * scale) + 'px';
            text.setAttribute('data-pg-fit', '1');
            if (scale <= FLOOR) break;
        }
    }

    // Gutenberg button: the link is as wide as the block and centres a one-line label; a label wider than the plate is shrunk to fit it.
    function fitButton(element) {
        element.style.removeProperty('--pg-fit');
        var link = element.querySelector('.wp-block-button__link');
        if (!link) return;
        var style = getComputedStyle(link);
        var room = link.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (!room || room < 4) return;
        var range = document.createRange();
        for (var pass = 0; pass < 3; pass += 1) {
            range.selectNodeContents(link);
            var width = range.getBoundingClientRect().width;
            if (width <= room * SLACK) break;
            var current = parseFloat(element.style.getPropertyValue('--pg-fit')) || 1;
            element.style.setProperty('--pg-fit', String(Math.max(FLOOR, current * room / width)));
        }
    }

    // Elementor button: the widget has the plate width; the label inside is scaled the same way.
    function fitElementorButton(widget) {
        var button = widget.querySelector('.elementor-button');
        var label = widget.querySelector('.elementor-button-text');
        if (!button || !label) return;
        if (button.hasAttribute('data-pg-fit')) { button.style.removeProperty('font-size'); button.removeAttribute('data-pg-fit'); }
        var room = widget.clientWidth - 8;
        if (room < 4) return;
        // Elementor buttons animate their size (transition: all): measured mid-way the fit would chase a moving value.
        button.style.setProperty('transition', 'none', 'important');
        var base = parseFloat(getComputedStyle(button).fontSize);
        var scale = 1;
        var range = document.createRange();
        for (var pass = 0; pass < 3; pass += 1) {
            range.selectNodeContents(label);
            var width = range.getBoundingClientRect().width;
            if (width <= room * SLACK) break;
            scale = Math.max(FLOOR, scale * room / width);
            // The kit's button size can be !important, which a plain inline value would lose to.
            button.style.setProperty('font-size', (base * scale) + 'px', 'important');
            button.setAttribute('data-pg-fit', '1');
            if (scale <= FLOOR) break;
        }
        button.getBoundingClientRect();
        button.style.removeProperty('transition');
    }

    function fitAll() {
        Array.prototype.forEach.call(document.querySelectorAll('.page-generator-canvas .pg-abs.wp-block-buttons'), fitButton);
        Array.prototype.forEach.call(document.querySelectorAll('.page-generator-canvas .elementor-widget-button'), fitElementorButton);
        Array.prototype.forEach.call(document.querySelectorAll('.page-generator-canvas .pg-abs.pg-text'), fitBlock);
        Array.prototype.forEach.call(document.querySelectorAll('.page-generator-canvas .pg-el-text.pg-nowrap, .pg-el-flow .pg-el-text.pg-nowrap'), fitWidget);
    }

    window.PageGeneratorFit = fitAll;
    var timer = null;
    function later() { window.clearTimeout(timer); timer = window.setTimeout(fitAll, 60); }
    fitAll();
    document.addEventListener('DOMContentLoaded', fitAll);
    window.addEventListener('load', fitAll);
    window.addEventListener('resize', later);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
}());
