# Extension platform

Pi Suite extends the published Pi Extension API without modifying Pi itself.

## Tool ownership

```text
RegisteredTools = PiBuiltins ∪ ⋃ ExtensionRegisteredTools
ActiveTools(branch) = PiOwnedSelection(branch)
```

An Extension registers its complete typed tool surface with `pi.registerTool()`. Suite Extensions
must not call `getActiveTools()` or `setActiveTools()`. Pi remains the only owner of active-tool
selection, so one Extension cannot overwrite another Extension's contribution.

Chrome therefore registers its 25 descriptor-generated tools and `chrome_status` directly. Tool
workflow guidance belongs in the optional `pi-chrome` Skill, not in a second visibility state
machine.

## Optional host capabilities

Pi Web owns the `ExtensionUIContext` object supplied to lifecycle callbacks. It exposes one
Suite-specific capability lookup on that object while leaving the published Pi API unchanged. The
lookup binds an Extension package identity to one versioned port:

```text
pi-suite/structured-view@1
pi-suite/media-view@1
pi-suite/runtime-retention@1
pi-suite/web-surface-runtime@1
```

`@pi-suite/companion-contracts` owns the method and port identifiers plus their wire-safe schemas.
`@pi-suite/host-runtime` owns keyed projection and retention mechanisms. `@pi-suite/extension-kit`
only performs typed lookup and Scope integration; it stores no domain state.

Ports remain independent:

- structured and media values replace one `owner + slot` projection;
- removing a view does not release runtime retention;
- releasing retention does not remove a view;
- host disposal clears every claim and projection;
- when the capability lookup or a requested port is absent, the Extension keeps its domain behavior
  and publishes no substitute status or lease.

Package identity is declared by each trusted Suite Extension's `package.json`. This is namespacing,
not a security boundary. Supporting untrusted Extensions would require process isolation rather than
additional branches in these helpers.

## Aggregated Web Surfaces

A package may declare one browser document without changing Pi:

```json
{
  "piSuite": {
    "web": {
      "contract": "pi-suite/web-surface@1",
      "document": "./dist/web/index.html",
      "title": "Example"
    }
  }
}
```

Pi settings remain installed/enabled truth. The package archive owns the runtime entry and `dist/web` bytes;
`SessionRuntimeRegistry` owns the live controller. A surface instance is identified by
`packageName × candidateHash × sessionId × RuntimeIdentity`. `candidateHash` is derived from sorted
`package.json`, Pi runtime entries, and `dist/web/**`; it is never writable state.

The `/extensions` route is not owned by a selected Session. Pi Web derives one read-only catalog from the
real package resolution of existing Session workspaces. Selecting a package connects its iframe to the
already-running compatible Session controllers; if none is running, the most recently active compatible
Session is used as the single activation anchor. No Agent Session is created by this route.

The plugin manager follows the same rule. Its overview is derived on demand from global Pi package settings
plus every distinct cwd found in the Session repository, matching the input Pi's `SettingsManager` actually
uses for project settings. Project package
rows carry that owner cwd back to the existing package mutation endpoint; the UI never substitutes the first
Session as a hidden settings context. With no Sessions, global install, update, enable, disable, and removal
remain available while project scope is unavailable until a Project exists.

Pi Web serves admitted assets through `/extension-assets/...` and runs them in
`<iframe sandbox="allow-scripts">`. The iframe receives a transferred `MessagePort`; it is never imported into
the host realm and has no mount/dispose protocol. One browser port multiplexes read-only projections from the
connected Session runtimes. Each projection carries its Session context, and every action names one owner
Session; the host still verifies that Session's complete RuntimeIdentity and candidate hash before dispatch.
Loop, Weixin, and Chrome aggregation remains inside their package-owned browser document rather than shared
host code. Projection changes stay in the existing session runtime SSE streams. Route disposal closes only the
browser channel, while runtime replacement closes the owning Session Scope and invalidates old actions by
identity.

## Lifecycle

Every long-lived fiber, runtime claim, queue, lease, and handle is owned by an Effect Scope. Session
replacement and shutdown close that Scope before releasing the process runtime. UI projections are
transient host state and never become session truth or runtime-retention state.

## Delivery

Each public Extension declares one Pi entry, its assets, expected registrations, optional Skills,
and optional domain check. Ordinary dependencies are bundled; only Node built-ins and declared Pi
host modules remain external. Verification loads the raw npm archive with Pi's real resource loader
without installing dependencies inside the package.

Declaring a Web Surface requires the multi-file profile, explicit `dist/web` profile assets, and matching
`package.json.files`. Archive verification resolves the complete relative browser module graph and rejects bare,
Node, Pi-host, server, missing, or escaping imports before the candidate can be released.
