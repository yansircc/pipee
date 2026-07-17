# FAQ

## How do I connect Chrome?

Load `dist/browser-extension` from the installed package in `chrome://extensions`. The popup is
read-only and the extension connects automatically. `chrome_status` reports the exact directory and
current state.

## Do I need to authorize each session?

No. There is no authorization command, confirmation dialog, or Web toggle. The agent calls typed
Chrome tools when the task requires them.

## Which profile is used?

The compatible loaded connector reported by `chrome_status`. A tool fails explicitly when the
connector is offline; it does not silently switch profiles.

## Does Pi use my active tab?

Not implicitly. Page and input operations use session-owned tabs unless the agent supplies an exact
tagged tab selector. More than one matching tab is an error.

## Why are some tools absent from the prompt?

All tools are registered, but only the core set is active by default. The agent calls
`chrome_enable` to add one advanced capability profile and Pi rebuilds the model context.

## What survives a browser restart?

The profile connector identity survives in `chrome.storage.local`. Session tab ownership uses a
browser epoch and is not guessed across extension reloads or browser restarts.

## How do I verify a change?

Run `pnpm verify` in this workspace. For a real browser path, run `vp run smoke:connector` against a
Chrome for Testing or Chromium executable.
