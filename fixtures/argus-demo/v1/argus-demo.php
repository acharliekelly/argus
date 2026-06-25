<?php
/**
 * Plugin Name: Argus Demo
 * Description: Deterministic update fixture for the Argus maintenance demo.
 * Version: 1.0.0
 * Update URI: http://fixture.argus.test:8080/argus-demo
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('wp_footer', static function (): void {
    echo '<aside class="argus-demo-banner argus-demo-banner-v1">Argus demo plugin v1 is active.</aside>';
});

add_action('wp_enqueue_scripts', static function (): void {
    wp_register_style('argus-demo', false, [], '1.0.0');
    wp_enqueue_style('argus-demo');
    wp_add_inline_style(
        'argus-demo',
        '.argus-demo-banner{max-width:960px;margin:24px auto;padding:16px;background:#e7f5ed;color:#173b2c;border:2px solid #2b7a55;border-radius:8px;font:600 16px/1.4 sans-serif}'
    );
});

add_filter('http_request_host_is_external', static function (bool $external, string $host): bool {
    return $host === 'fixture.argus.test' ? true : $external;
}, 10, 2);

add_filter('update_plugins_fixture.argus.test', static function ($update, array $plugin_data, string $plugin_file) {
    if ($plugin_file !== 'argus-demo/argus-demo.php') {
        return $update;
    }

    return [
        'version' => '2.0.0',
        'package' => 'http://fixture.argus.test:8080/argus-demo-v2.zip',
        'url' => 'http://fixture.argus.test:8080/argus-demo'
    ];
}, 10, 3);
