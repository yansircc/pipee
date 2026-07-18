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

## Lifecycle

Every long-lived fiber, runtime claim, queue, lease, and handle is owned by an Effect Scope. Session
replacement and shutdown close that Scope before releasing the process runtime. UI projections are
transient host state and never become session truth or runtime-retention state.

## Delivery

Each public Extension declares one Pi entry, its assets, expected registrations, optional Skills,
and optional domain check. Ordinary dependencies are bundled; only Node built-ins and declared Pi
host modules remain external. Verification loads the raw npm archive with Pi's real resource loader
without installing dependencies inside the package.
