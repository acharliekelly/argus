<?php
/**
 * Plugin Name: Argus Regression Fixture
 * Description: Deterministic fixture plugin for Argus named-site integration tests.
 * Version: 2.0.0
 * Update URI: http://argus.local/argus-regression
 */

add_action('wp_footer', function () {
    if (!is_admin()) {
        echo '<div id="argus-regression-fixture" style="position: fixed; left: 0; right: 0; bottom: 0; z-index: 99999; min-height: 220px; padding: 40px; background: #b00020; color: #fff; font-size: 48px;">Argus regression fixture v2</div>';
    }
});
