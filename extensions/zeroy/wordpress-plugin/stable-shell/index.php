<?php

defined('ABSPATH') || exit;

wp_die('The request was not projected from an active zeroY SiteRelease.', 'zeroY render unavailable', ['response' => 503]);
