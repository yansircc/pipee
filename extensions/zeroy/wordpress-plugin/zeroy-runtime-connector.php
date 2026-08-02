<?php
/**
 * Plugin Name: zeroY Runtime Connector
 * Description: Locale runtime kernel and typed Connector for Agent-authored WordPress themes.
 * Version: 3.1.0
 * Requires PHP: 8.1
 */

defined('ABSPATH') || exit;

define('ZEROY_RUNTIME_VERSION', '5.5.0');
define('ZEROY_THEME_SCHEMA_CONTRACT', 'zeroy/theme-schema@1');
define('ZEROY_RUNTIME_SITE_ID_OPTION', 'zeroy_runtime_site_id');
define('ZEROY_RUNTIME_CONNECTION_KEY_OPTION', 'zeroy_runtime_connection_key');
define('ZEROY_RUNTIME_SCHEMA_META', '_zeroy_runtime_schema_id');
define('ZEROY_RUNTIME_CANONICAL_REVISION_META', '_zeroy_runtime_canonical_revision');
define('ZEROY_RUNTIME_CANONICAL_ROUTE_META', '_zeroy_runtime_canonical_route');
define('ZEROY_RUNTIME_TEMPLATE_CONTENT_META', '_zeroy_runtime_template_content');
define('ZEROY_RUNTIME_DATABASE_VERSION', '5.5.0');
define('ZEROY_RUNTIME_DATABASE_VERSION_OPTION', 'zeroy_runtime_database_version');

require_once __DIR__ . '/includes/runtime.php';
require_once __DIR__ . '/includes/zcss/contract.php';
require_once __DIR__ . '/includes/zcss/canonical-json.php';
require_once __DIR__ . '/includes/zcss/decoder.php';
require_once __DIR__ . '/includes/zcss/color.php';
require_once __DIR__ . '/includes/zcss/fluid-scale.php';
require_once __DIR__ . '/includes/zcss/tokens.php';
require_once __DIR__ . '/includes/zcss/primitives.php';
require_once __DIR__ . '/includes/zcss/compiler.php';
require_once __DIR__ . '/includes/zcss/css-ast.php';
require_once __DIR__ . '/includes/zcss/style-surface.php';
require_once __DIR__ . '/includes/theme/contract.php';
require_once __DIR__ . '/includes/theme/artifact-store.php';
require_once __DIR__ . '/includes/theme/php-lint.php';
require_once __DIR__ . '/includes/site-logic/contract.php';
require_once __DIR__ . '/includes/site-logic/artifact-store.php';
require_once __DIR__ . '/includes/site-logic/migrations.php';
require_once __DIR__ . '/includes/site-logic/observation.php';
require_once __DIR__ . '/includes/site-logic/runtime.php';
require_once __DIR__ . '/includes/theme/contract-compiler.php';
require_once __DIR__ . '/includes/site-release/store.php';
require_once __DIR__ . '/includes/site-release/snapshot-projection.php';
require_once __DIR__ . '/includes/site-release/snapshot-compiler.php';
require_once __DIR__ . '/includes/site-release/static-verifier.php';
require_once __DIR__ . '/includes/zcss/verification.php';
require_once __DIR__ . '/includes/site-release/scenario-compiler.php';
require_once __DIR__ . '/includes/site-release/candidate-runtime.php';
require_once __DIR__ . '/includes/site-release/draft.php';
require_once __DIR__ . '/includes/site-release/draft-compiler.php';
require_once __DIR__ . '/includes/site-release/draft-inspection.php';
require_once __DIR__ . '/includes/site-release/browser-smoke.php';
require_once __DIR__ . '/includes/site-release/browser-evidence.php';
require_once __DIR__ . '/includes/site-release/proof.php';
require_once __DIR__ . '/includes/site-release/preparation.php';
require_once __DIR__ . '/includes/site-release/activation.php';
require_once __DIR__ . '/includes/site-release/hard-cut-migration.php';
require_once __DIR__ . '/includes/site-release/stable-shell.php';
require_once __DIR__ . '/includes/site-release/request-runtime.php';
require_once __DIR__ . '/includes/site-release/rest.php';
require_once __DIR__ . '/includes/routes.php';
require_once __DIR__ . '/includes/rest.php';

register_activation_hook(__FILE__, 'zeroy_runtime_activate');
register_deactivation_hook(__FILE__, 'zeroy_runtime_deactivate');
// Upgrade work may write canonical posts while repairing route identity. WordPress
// defines its functionality constants only after plugins_loaded, so upgrades must
// run at init rather than during plugin loading.
add_action('init', 'zeroy_runtime_maybe_upgrade', 1);
