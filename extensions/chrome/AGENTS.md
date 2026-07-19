# Repository Guidelines

## Project Structure & Module Organization

This is a strict TypeScript ESM package. `src/protocol/` owns wire contracts and operation descriptors. `src/browser/` implements the Chrome extension and adapters; `src/pi/` integrates with Pi; `src/core/` contains broker logic. Tooling lives in `scripts/`. Unit tests are under `test-suite/unit/`; browser benchmarks and fixtures live elsewhere in `test-suite/`. Treat `dist/browser-extension/` as generated output.

## Build, Test, and Development Commands

- `pnpm install` installs pinned dependencies.
- `pnpm run verify` runs the authoritative format, lint, typecheck, build, test, dead-code, Effect, and distribution gates.
- `vp test` runs unit tests; use a file argument for focused work.
- `vp run build` regenerates the extension; `vp fmt` applies formatting.
- `vp run smoke:connector` tests a temporary extension against an isolated fake bridge. Set `PI_CHROME_SMOKE_CHROME` if Chromium is not discovered.
- `cd test-suite && python3 -m http.server 8765` serves the benchmark dashboard.

## Coding Style & Architecture Invariants

Use two-space indentation, double quotes, semicolons, kebab-case files, camelCase values, and PascalCase types. Keep TypeScript strict and model fallible workflows with Effect. Add operations once in `src/protocol/operation-contract.ts`; registration, validation, deadlines, and fingerprinting derive from it. Resolve tab selectors once at command entry. Do not add parallel operation lists, JSON coercion, transport fallbacks, or adapter-specific shared logic.

## Testing Guidelines

Name unit tests `*.test.ts` in `test-suite/unit/`. Use Vitest and `@effect/vitest` for Effect programs. Behavior changes require regression tests. New browser capabilities also require a challenge page and `test-suite/manifest.json` entry that fail before the change and pass after it. There is no numeric coverage target; `pnpm run verify` is the merge gate.

## Commit & Pull Request Guidelines

Use concise Conventional Commit subjects such as `fix:`, `feat:`, `build:`, `style:`, or breaking `refactor!:`. Scope commits to one invariant. Pull requests should explain the failure class and structural fix, list verification, link issues, and include benchmark verdicts or screenshots for visible changes. Bug reports need `chrome_status`, package/extension versions, the exact tool call and result, and a minimal repro.

## Security & Compatibility

Preserve existing-profile operation, automatic connector ownership, bounded JSON transport, and Chrome 120 compatibility. The product surface is Agent-first: browser intent and execution remain in Chat and the Agent tools. The Web Surface is a cross-Session supervision projection; it may terminate the owning Session's current Chrome tool or close an explicitly selected idle Session-owned tab after host confirmation. Do not expose navigation, click, fill, snapshot, screenshot, a generic operation runner, authorization commands, active-tab fallback, or a browser/DOM mirror. Never commit credentials, tokens, or profile data.
