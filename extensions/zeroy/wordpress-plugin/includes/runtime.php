<?php

/**
 * Runtime composition root. Domain behavior is partitioned by its fact owner;
 * this file contains no runtime behavior.
 */

defined("ABSPATH") || exit;

/**
 * Release artifacts are executable delivery inputs, not public static files.
 *
 * WordPress serves everything below WP_CONTENT_DIR directly on most hosts.
 * Keeping immutable artifacts there makes a private Preview readable merely by
 * guessing its content hash. The storage owner is therefore one directory
 * above ABSPATH; the request runtime is the only byte-serving boundary.
 */
function zeroy_runtime_private_storage_root(): string
{
    return rtrim(wp_normalize_path(dirname(rtrim(ABSPATH, '/'))), '/') . '/zeroy-runtime';
}

/** The old public root exists only so the one-time hard-cut migration can remove it. */
function zeroy_runtime_legacy_public_storage_root(): string
{
    return rtrim(wp_normalize_path(WP_CONTENT_DIR), '/') . '/zeroy-runtime';
}

require_once __DIR__ . '/foundation.php';
require_once __DIR__ . '/concurrency.php';
require_once __DIR__ . '/localization/translation-profile.php';
require_once __DIR__ . '/site-config.php';
require_once __DIR__ . '/theme/schema-errors.php';
require_once __DIR__ . '/localization/policy-contract.php';
require_once __DIR__ . '/theme/schema-template-content.php';
require_once __DIR__ . '/theme/authoring-contract.php';
require_once __DIR__ . '/theme/schema-runtime.php';
require_once __DIR__ . '/theme/schema-collections.php';
require_once __DIR__ . '/canonical.php';
require_once __DIR__ . '/localization/subject-port.php';
require_once __DIR__ . '/localization/policy-compiler.php';
require_once __DIR__ . '/localization/template-content.php';
require_once __DIR__ . '/localization/subject-post.php';
require_once __DIR__ . '/localization/subject-term.php';
require_once __DIR__ . '/localization/subject-menu.php';
require_once __DIR__ . '/localization/subject-site-copy.php';
require_once __DIR__ . '/localization/subject-media.php';
require_once __DIR__ . '/localization/locale-overlay-store.php';
require_once __DIR__ . '/localization/overlay-reconciliation/contract.php';
require_once __DIR__ . '/localization/overlay-reconciliation/planning.php';
require_once __DIR__ . '/localization/overlay-reconciliation/writer.php';
require_once __DIR__ . '/localization/overlay-reconciliation/candidate.php';
require_once __DIR__ . '/localization/locale-resolver.php';
require_once __DIR__ . '/localization/translation-job.php';
require_once __DIR__ . '/localization/coverage.php';
require_once __DIR__ . '/query.php';
require_once __DIR__ . '/inspection.php';
require_once __DIR__ . '/lifecycle.php';
