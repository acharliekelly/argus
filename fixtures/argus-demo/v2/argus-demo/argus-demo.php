<?php
/**
 * Plugin Name: Argus Demo
 * Description: Deterministic update fixture for the Argus maintenance demo.
 * Version: 2.0.0
 * Update URI: http://fixture.argus.test:8080/argus-demo
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('wp_footer', static function (): void {
    echo '<aside class="argus-demo-banner argus-demo-banner-v2">Argus demo plugin v2 introduced an intentional visual regression.</aside>';
});

add_action('wp_enqueue_scripts', static function (): void {
    wp_register_style('argus-demo', false, [], '2.0.0');
    wp_enqueue_style('argus-demo');
    wp_add_inline_style(
        'argus-demo',
        '.argus-demo-banner{position:fixed;inset:0;z-index:999999;display:grid;place-items:center;margin:0;padding:48px;background:#b00020;color:#fff;font:800 38px/1.2 sans-serif;text-align:center}'
    );
});

add_filter('http_request_host_is_external', static function (bool $external, string $host): bool {
    return $host === 'fixture.argus.test' ? true : $external;
}, 10, 2);

add_filter('update_plugins_fixture.argus.test', static function ($update, array $plugin_data, string $plugin_file) {
    return false;
}, 10, 3);
