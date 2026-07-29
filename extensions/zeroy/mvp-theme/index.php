<?php
/**
 * Required WordPress fallback template.
 *
 * zeroY locale routes are rendered by zeroy-mvp-template.php through the
 * Runtime Connector. Keeping this fallback intentionally small makes normal
 * WordPress URLs behave as ordinary theme pages.
 */

defined('ABSPATH') || exit;

get_header();
?>
<main class="zeroy-shell">
  <article class="zeroy-card">
    <div class="zeroy-content">
      <h1>zeroY MVP</h1>
      <p>Open the locale route managed by the zeroY Runtime Connector.</p>
    </div>
  </article>
</main>
<?php
get_footer();
