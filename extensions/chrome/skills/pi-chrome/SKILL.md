---
name: pi-chrome
description: Operate the user's active local Chrome profile through typed Pi Chrome tools.
---

# Pi Chrome workflow

Use `chrome_status` first when connector availability is uncertain. Choose the smallest typed Chrome
tool that directly performs the next operation.

Observe before acting. Start interactive page work with a snapshot, use returned ActionRef values,
and take a fresh snapshot after navigation or material DOM changes. Never reuse a stale ref.

If the connector is unavailable, report the extension directory returned by `chrome_status` and ask
the user to open the target Chrome profile. Do not substitute a different browser profile or transport.
