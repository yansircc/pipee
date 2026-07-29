# zeroY Runtime Connector MVP

This package is the smallest vertical slice of the zeroY plan:

```text
Pi extension tool
→ typed REST Connector
→ local WordPress locale draft/publish or active-theme file write
→ browser-visible locale route
```

It intentionally excludes arbitrary canonical-object creation, ACF discovery, LocaleVersion history, search, SEO checks, WebSurface and multi-site persistence. The plugin seeds one canonical object so the first loop can focus on the two mutations that matter: changing theme code and publishing localized content. Those are the next layers after this loop is proven.

## Local demo

1. Symlink or copy wordpress-plugin into a LocalWP site's wp-content/plugins directory.
2. Symlink or copy mvp-theme into wp-content/themes/zeroy-mvp.
3. Activate the theme and plugin.
4. Read the generated connection key:

```sh
locwp wp 10013 -- option get zeroy_mvp_connection_key
```

5. Build the Pi extension, then run it with:

```sh
ZEROY_SITE_URL=http://localhost:10013 \
ZEROY_CONNECTION_KEY=the-key \
pi --extension ./dist/pi/extension.js
```

Visit /zeroy-mvp/ for Chinese. Publish an English draft through the extension, then visit /en/zeroy-mvp/.
