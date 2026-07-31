<?php
/**
 * Plugin Name: zeroY Runtime Connector
 * Description: Locale runtime kernel and typed Connector for Agent-authored WordPress themes.
 * Version: 3.0.0
 * Requires PHP: 8.1
 */

defined('ABSPATH') || exit;

define('ZEROY_RUNTIME_VERSION', '4.0.0');
define('ZEROY_THEME_SCHEMA_CONTRACT', 'zeroy/theme-schema@1');
define('ZEROY_RUNTIME_SITE_ID_OPTION', 'zeroy_runtime_site_id');
define('ZEROY_RUNTIME_CONNECTION_KEY_OPTION', 'zeroy_runtime_connection_key');
define('ZEROY_RUNTIME_SCHEMA_META', '_zeroy_runtime_schema_id');
define('ZEROY_RUNTIME_CANONICAL_REVISION_META', '_zeroy_runtime_canonical_revision');
define('ZEROY_RUNTIME_TEMPLATE_CONTENT_META', '_zeroy_runtime_template_content');
define('ZEROY_RUNTIME_DATABASE_VERSION', '4.4.0');
define('ZEROY_RUNTIME_DATABASE_VERSION_OPTION', 'zeroy_runtime_database_version');

require_once __DIR__ . '/includes/runtime.php';
require_once __DIR__ . '/includes/theme/contract.php';
require_once __DIR__ . '/includes/theme/artifact-store.php';
require_once __DIR__ . '/includes/theme/deployment-store.php';
require_once __DIR__ . '/includes/theme/faults.php';
require_once __DIR__ . '/includes/theme/php-lint.php';
require_once __DIR__ . '/includes/theme/retention.php';
require_once __DIR__ . '/includes/theme/repair.php';
require_once __DIR__ . '/includes/theme/bootstrap.php';
require_once __DIR__ . '/includes/theme/initial-deployment.php';
require_once __DIR__ . '/includes/theme/request-runtime.php';
require_once __DIR__ . '/includes/theme/activation.php';
require_once __DIR__ . '/includes/theme/rest.php';
require_once __DIR__ . '/includes/routes.php';
require_once __DIR__ . '/includes/rest.php';

register_activation_hook(__FILE__, 'zeroy_runtime_activate');
register_deactivation_hook(__FILE__, 'zeroy_runtime_deactivate');
// Upgrade work may write canonical posts while repairing route identity. WordPress
// defines its functionality constants only after plugins_loaded, so upgrades must
// run at init rather than during plugin loading.
add_action('init', 'zeroy_runtime_maybe_upgrade', 1);
