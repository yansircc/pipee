# Examples

Calls use the directly registered atomic tools.

## Observe, then act

Snapshot with `chrome_snapshot`:

```json
{
  "mode": "interactive",
  "query": "refund button"
}
```

Click the returned Action Graph ref with `chrome_click` and verify in the same round trip:

```json
{
  "ref": "@el-27",
  "includeSnapshot": true
}
```

The result has one stable shape:

```json
{
  "action": { "outcome": "effect-observed", "observedChanges": ["page"] },
  "verification": { "status": "observed", "snapshot": {} }
}
```

If the page changes again while the snapshot is being collected, `verification` is
`{ "status": "unavailable", "reason": "..." }`; the `action` receipt is still retained and the
agent must observe again instead of replaying the action.

Expand an omitted action context:

```json
{
  "ref": "@frontier-3"
}
```

Read rendered page content without loading actions:

```json
{
  "view": "content",
  "query": "refund policy",
  "maxChars": 12000
}
```

## Navigate a session-owned tab

```json
{
  "url": "https://example.com/orders/42"
}
```

Navigate, wait for that navigation generation, and read semantic text in one call:

```json
{
  "url": "https://example.com/orders/42",
  "snapshot": { "mode": "text" }
}
```

No target means the session-owned automation tab. To use an existing tab:

```json
{
  "target": { "by": "title", "value": "Orders" },
  "mode": "forms"
}
```

The tagged selector is resolved once; the operation remains pinned to that exact tab id even if
navigation changes its URL or title. The default stops at that generation's document commit so an
agent can observe an SPA without waiting for every resource. Set `waitUntilLoad: true` only when the
matching load event is required.

Call `chrome_tab_new` to create a second owned tab, then address both tabs by the exact ids returned by navigation/new:

```json
{ "url": "https://example.com/comparison" }
```

Once a session owns several tabs, omitting `target` is intentionally ambiguous; no active or
last-used target is stored.

## Fill a controlled input

```json
{
  "selector": "input[name=email]",
  "text": "person@example.com",
  "includeSnapshot": true
}
```

## Wait under strict CSP

```json
{
  "condition": { "by": "selector", "value": "[data-state=ready]" },
  "timeoutMs": 10000
}
```

Expression waits and evaluation run through CDP, outside page CSP.

Wait can also use `{ "by": "urlIncludes", "value": "/account" }` or
`{ "by": "textContains", "value": "Ready" }`. Reaching the deadline returns
`satisfied: false` plus URL, title, readyState, body-text length, and selector match count instead of
throwing a generic timeout.

Evaluation always returns bounded JSON. Non-JSON page values are explicit markers rather than
values silently changed by `JSON.stringify`:

```json
{
  "expression": "({ missing: undefined, total: 42n })"
}
```

The corresponding fields have markers such as
`{ "_tag": "PiChromeEvaluationMarker", "kind": "Undefined" }` and
`{ "_tag": "PiChromeEvaluationMarker", "kind": "BigInt", "value": "42" }`.

## Console and network evidence

Call `chrome_console`:

```json
{ "clear": false }
```

Call `chrome_network_list`:

```json
{ "clear": false }
```

Call `chrome_network_get`:

```json
{ "requestId": "req-4" }
```

## Screenshot

Capture the exact target tab's current viewport to one image artifact:

```json
{
  "format": "png",
  "capture": {
    "kind": "viewport",
    "path": ".pi/chrome-screenshots/order.png"
  }
}
```

Capture a full page as a tile-set directory with a manifest:

```json
{
  "format": "png",
  "capture": {
    "kind": "full-page-tiles",
    "directory": ".pi/chrome-screenshots/order-page"
  }
}
```

Full-page capture publishes individual tiles and `manifest.json`; it does not claim to create a
stitched image. Both modes capture through CDP against the selected tab without temporarily
activating another tab or scrolling the captured document. `path` and `directory` are local artifact
destinations and are removed before the command crosses the browser wire.

## Tab lifecycle

Create a tab with `chrome_tab_new`:

```json
{ "url": "https://example.com" }
```

Close a specific tab:

```json
{ "target": { "by": "id", "value": 42 } }
```
