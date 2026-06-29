<?php
/**
 * Plugin Name: Argus Regression Fixture
 * Description: Deterministic fixture plugin for Argus named-site integration tests.
 * Version: 1.0.0
 * Update URI: http://argus.local/argus-regression
 */

add_action('wp_footer', function () {
    if (!is_admin()) {
        echo '<p id="argus-regression-fixture">Argus regression fixture v1</p>';
    }
});

add_filter('http_request_host_is_external', function ($external, $host) {
    if ($host === 'update-server') {
        return true;
    }

    return $external;
}, 10, 2);

add_filter('pre_set_site_transient_update_plugins', function ($transient) {
    if (!is_object($transient)) {
        $transient = new stdClass();
    }
    if (!isset($transient->response) || !is_array($transient->response)) {
        $transient->response = [];
    }

    $plugin = plugin_basename(__FILE__);
    $transient->response[$plugin] = (object) [
        'id' => 'argus.local/argus-regression',
        'slug' => 'argus-regression',
        'plugin' => $plugin,
        'new_version' => '2.0.0',
        'package' => 'http://update-server/argus-regression-v2.zip',
        'url' => 'http://argus.local/argus-regression',
    ];

    return $transient;
});
