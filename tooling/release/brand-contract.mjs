import assert from "node:assert/strict";

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (...parts) => {
  const value = parts.join("");
  return {
    label: value,
    pattern: new RegExp(`(?:^|[^a-z0-9])${escaped(value)}(?:$|[^a-z0-9])`, "i"),
  };
};
const symbol = (...parts) => ({ label: parts.join(""), value: parts.join("").toLowerCase() });

const forbiddenTokens = [
  token("pi", "suite"),
  token("pi", "-", "suite"),
  token("pi", "_", "suite"),
  token("pi", " ", "suite"),
  token("pi", "-", "web"),
  token("pi", "_", "web"),
  token("pi", " ", "web"),
  token("Su", "ite host"),
  token("Su", "ite Extension"),
  token("Su", "ite release"),
  token("Su", "ite package"),
  token("Su", "ite directory"),
];

const forbiddenSymbols = [
  symbol("get", "Pi", "Su", "ite", "Capability"),
  symbol("suite", "Config"),
  symbol("suite", "Repository"),
  symbol("suite", "Issues"),
  symbol("release/", "suite", ".config.json"),
];

const retiredWebSymbol = ["[Pp]i", "Web"].join("");
const forbiddenPatterns = [
  {
    label: ["Pi", "Web", " symbol"].join(""),
    pattern: new RegExp(`(?:^|[^a-zA-Z0-9])${retiredWebSymbol}(?:[A-Z]|$)`),
  },
];

export const legacyHostIdentifiers = (source) => {
  const lower = source.toLowerCase();
  return [
    ...forbiddenTokens.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label),
    ...forbiddenPatterns.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label),
    ...forbiddenSymbols.filter(({ value }) => lower.includes(value)).map(({ label }) => label),
  ];
};

export const assertPipeeBrand = (source, owner) => {
  const matches = legacyHostIdentifiers(source);
  assert.deepEqual(matches, [], `${owner} contains retired Host identities: ${matches.join(", ")}`);
};
