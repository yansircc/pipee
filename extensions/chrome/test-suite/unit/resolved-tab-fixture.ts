import type { ResolvedTab } from "../../src/browser/platform-targets.js";

export const resolvedTabFixture = (id = 7, windowId = 1): ResolvedTab => ({
  id,
  windowId,
  index: 0,
  pinned: false,
  highlighted: true,
  active: true,
  frozen: false,
  incognito: false,
  selected: true,
  discarded: false,
  autoDiscardable: true,
  groupId: -1,
});
