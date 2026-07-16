import assert from "node:assert/strict";

export const assertPosixFileMode = (actual: number, expected: number): void => {
  if (process.platform === "win32") return;
  assert.equal(actual & 0o777, expected);
};
