import type { KeyLayoutInfo } from "./platform-input-types.js";

export function usKeyLayoutForChar(ch: string): KeyLayoutInfo {
  const punctuation: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
    "`": { code: "Backquote", keyCode: 192 },
    "~": { code: "Backquote", keyCode: 192, shift: true },
    "-": { code: "Minus", keyCode: 189 },
    _: { code: "Minus", keyCode: 189, shift: true },
    "=": { code: "Equal", keyCode: 187 },
    "+": { code: "Equal", keyCode: 187, shift: true },
    "[": { code: "BracketLeft", keyCode: 219 },
    "{": { code: "BracketLeft", keyCode: 219, shift: true },
    "]": { code: "BracketRight", keyCode: 221 },
    "}": { code: "BracketRight", keyCode: 221, shift: true },
    "\\": { code: "Backslash", keyCode: 220 },
    "|": { code: "Backslash", keyCode: 220, shift: true },
    ";": { code: "Semicolon", keyCode: 186 },
    ":": { code: "Semicolon", keyCode: 186, shift: true },
    "'": { code: "Quote", keyCode: 222 },
    '"': { code: "Quote", keyCode: 222, shift: true },
    ",": { code: "Comma", keyCode: 188 },
    "<": { code: "Comma", keyCode: 188, shift: true },
    ".": { code: "Period", keyCode: 190 },
    ">": { code: "Period", keyCode: 190, shift: true },
    "/": { code: "Slash", keyCode: 191 },
    "?": { code: "Slash", keyCode: 191, shift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  const shiftedDigits: Record<string, string> = {
    ")": "0",
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
  };
  if (/^[a-z]$/.test(ch)) {
    return {
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      needShift: false,
    };
  }
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
  if (/^[0-9]$/.test(ch))
    return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
  const digit = shiftedDigits[ch];
  if (digit)
    return {
      code: `Digit${digit}`,
      keyCode: digit.charCodeAt(0),
      needShift: true,
    };
  const symbol = punctuation[ch];
  if (symbol)
    return {
      code: symbol.code,
      keyCode: symbol.keyCode,
      needShift: symbol.shift === true,
    };
  return { code: "", keyCode: 0, needShift: false };
}
