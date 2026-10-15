// Elementor output is laid out in px at the screenshot's width. Narrower screens would scroll sideways, so each canvas is zoomed
// to the width available to it (never wider than the configured container width), which scales the whole layout like the block
// output does with container units.
(function () {
    'use strict';
    if (document.body && document.body.classList.contains('elementor-editor-active')) return;
    var maxWidth = (window.PageGeneratorScale && window.PageGeneratorScale.maxWidth) || 1200;

    function fit(canvas) {
        var match = /(?:^|\s)pg-w-(\d+)(?:\s|$)/.exec(canvas.className);
        var source = match ? parseInt(match[1], 10) : 0;
        var parent = canvas.parentElement;
        if (!source || !parent) return;
        var available = Math.min(parent.clientWidth, maxWidth);
        if (available > 0) canvas.style.setProperty('--pg-zoom', (available / source).toFixed(4));
    }

    function fitAll() {
        Array.prototype.forEach.call(document.querySelectorAll('.pg-el-canvas'), fit);
    }

    fitAll();
    document.addEventListener('DOMContentLoaded', fitAll);
    window.addEventListener('load', fitAll);
    window.addEventListener('resize', fitAll);
})();
