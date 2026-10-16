<?php
// Writes wp-admin cookies for user 1 to a JSON file so benchmark.js can drive the editor without logging in. Development only.
//   php dev-cookies.php [output.json]      (default: .cookies.json next to this file; valid for 12 hours)
// Command line only: the output is a working admin session, so this must never answer a web request.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
define('WP_USE_THEMES', false);
require getenv('WP_LOAD') ?: dirname(__DIR__, 4) . '/wp-load.php';
$expires = time() + 12 * HOUR_IN_SECONDS;
$token = WP_Session_Tokens::get_instance(1)->create($expires);
$host = wp_parse_url(home_url(), PHP_URL_HOST);
$cookies = [
    ['name' => AUTH_COOKIE, 'value' => wp_generate_auth_cookie(1, $expires, 'auth', $token), 'domain' => $host, 'path' => '/wp-admin'],
    ['name' => AUTH_COOKIE, 'value' => wp_generate_auth_cookie(1, $expires, 'auth', $token), 'domain' => $host, 'path' => '/wp-content/plugins'],
    ['name' => LOGGED_IN_COOKIE, 'value' => wp_generate_auth_cookie(1, $expires, 'logged_in', $token), 'domain' => $host, 'path' => '/'],
];
$out = $argv[1] ?? __DIR__ . '/.cookies.json';
file_put_contents($out, wp_json_encode($cookies));
chmod($out, 0600);
echo "cookies written to $out (expire " . gmdate('c', $expires) . ")\n";
