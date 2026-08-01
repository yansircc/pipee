<?php

/**
 * Runtime composition root. Domain behavior is partitioned by its fact owner;
 * this file contains no runtime behavior.
 */

defined("ABSPATH") || exit;

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
