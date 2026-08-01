<?php

/** REST composition root. Routes are separated by read, mutation, and registration ownership. */

defined("ABSPATH") || exit;

require_once __DIR__ . '/rest/auth.php';
require_once __DIR__ . '/rest/read.php';
require_once __DIR__ . '/rest/routes.php';
