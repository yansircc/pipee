<?php
/**
 * Plugin Name: zeroY Runtime Connector
 * Description: Locale runtime kernel and typed Connector for Agent-authored WordPress themes.
 * Version: 1.0.0
 * Requires PHP: 8.1
 */

defined('ABSPATH') || exit;

define('ZEROY_RUNTIME_VERSION', '1.0.0');
define('ZEROY_THEME_SCHEMA_CONTRACT', 'zeroy/theme-schema@1');
define('ZEROY_RUNTIME_SITE_ID_OPTION', 'zeroy_runtime_site_id');
define('ZEROY_RUNTIME_CONNECTION_KEY_OPTION', 'zeroy_runtime_connection_key');
define('ZEROY_RUNTIME_SCHEMA_META', '_zeroy_runtime_schema_id');
define('ZEROY_RUNTIME_CANONICAL_REVISION_META', '_zeroy_runtime_canonical_revision');
define('ZEROY_RUNTIME_DATABASE_VERSION', '1.0.1');
define('ZEROY_RUNTIME_DATABASE_VERSION_OPTION', 'zeroy_runtime_database_version');

require_once __DIR__ . '/includes/runtime.php';
require_once __DIR__ . '/includes/routes.php';
require_once __DIR__ . '/includes/rest.php';

register_activation_hook(__FILE__, 'zeroy_runtime_activate');
register_deactivation_hook(__FILE__, 'zeroy_runtime_deactivate');
add_action('plugins_loaded', 'zeroy_runtime_maybe_upgrade', 1);
