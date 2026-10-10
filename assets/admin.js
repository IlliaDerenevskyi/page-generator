(function ($) {
    'use strict';
    $('.pg-settings-tab').hide().first().show();
    $('.nav-tab-wrapper .nav-tab').on('click', function (event) {
        event.preventDefault();
        $('.nav-tab-wrapper .nav-tab').removeClass('nav-tab-active');
        $(this).addClass('nav-tab-active');
        $('.pg-settings-tab').hide();
        $($(this).attr('href')).show();
    });
}(jQuery));
