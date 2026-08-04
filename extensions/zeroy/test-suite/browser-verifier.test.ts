import { createServer } from "node:http";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Value } from "@sinclair/typebox/value";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { verifyBrowserChallengeWithLocalBrowser } from "../src/domain/browser-verifier.js";
import {
  BrowserEvidenceContract,
  type BrowserVerificationChallenge,
} from "../src/domain/protocol.js";

const stylesheet = `
:root { --z-on: #111111; --z-surface: #ffffff; }
body { margin: 0; color: #111111; background: #ffffff; }
.bad { color: #ffffff; background: #f7f3ea; }
.good { color: #111111; background: #ffffff; }
.ancestor { background: #000000; }
.transparent-child { color: #ffffff; background: transparent; }
.normal-threshold { color: #777777; background: #ffffff; font-size: 16px; }
.large-threshold { color: #777777; background: #ffffff; font-size: 24px; }
.gradient { color: #ffffff; background: linear-gradient(90deg, #112233, #223344); }
.hidden-failure { color: #ffffff; background: #ffffff; display: none; }
.zero-sized-failure { color: #ffffff; background: #ffffff; width: 0; height: 0; overflow: hidden; position: absolute; }
`;

const document = `<!doctype html>
<html><head><link rel="stylesheet" href="/site.css"></head><body>
  <p class="bad">Invisible contrast</p>
  <p class="good">Readable contrast</p>
  <div class="ancestor"><span class="transparent-child">Ancestor background</span></div>
  <p class="normal-threshold">Normal threshold</p>
  <h1 class="large-threshold">Large threshold</h1>
  <p class="gradient">Indeterminate gradient background</p>
  <p class="hidden-failure">Hidden failure</p>
  <p class="zero-sized-failure">Zero-sized failure</p>
</body></html>`;

const challenge = (origin: string): BrowserVerificationChallenge => ({
  contract: "zeroy/browser-verification-challenge@4",
  verifier: { id: "zeroy/pi-browser-verifier@4", version: "1" },
  releaseId: "release-test",
  themeArtifactId: "theme-test",
  scenarioSetHash: "1".repeat(64),
  stylesheetSetHash: "2".repeat(64),
  stylesheets: [{ path: "site.css", hash: "3".repeat(64), url: `${origin}/site.css` }],
  viewports: [{ id: "desktop", width: 1200, height: 900 }],
  contrastPairs: [{ id: "surface", foreground: "--z-on", background: "--z-surface", minimum: 4.5 }],
  scenarios: [
    {
      id: "home",
      kind: "front-page",
      locale: "en",
      url: `${origin}/`,
      expectedStatus: 200,
      expectedRouteKind: null,
      requiredFields: [],
    },
  ],
  challengeHash: "4".repeat(64),
});

describe("zeroY executed visible text contrast", () => {
  it.effect(
    "measures rendered foregrounds against painted ancestor backgrounds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.callback<ReturnType<typeof createServer>, Error>((resume) => {
              const created = createServer((request, response) => {
                if (request.url === "/site.css") {
                  response.writeHead(200, { "content-type": "text/css" });
                  response.end(stylesheet);
                  return;
                }
                response.writeHead(200, {
                  "content-type": "text/html",
                  "x-zeroy-stylesheet-identity": "2".repeat(64),
                });
                response.end(document);
              });
              const failed = (cause: Error): void => resume(Effect.fail(cause));
              created.once("error", failed);
              created.listen(0, "127.0.0.1", () => {
                created.off("error", failed);
                resume(Effect.succeed(created));
              });
              return Effect.sync(() => created.close());
            }),
            (created) =>
              Effect.callback<void>((resume) => {
                created.close(() => resume(Effect.void));
              }),
          );
          const address = server.address();
          if (address === null || typeof address === "string")
            return yield* Effect.die("Missing test port.");
          const evidence = yield* verifyBrowserChallengeWithLocalBrowser(
            challenge(`http://127.0.0.1:${address.port}`),
          );
          const [result] = evidence.results;
          expect(result?.contrastRatios.surface).toBeGreaterThanOrEqual(4.5);
          expect(result?.visibleTextContrastFailures).toBe(2);
          expect(result?.visibleTextContrastIndeterminate).toBe(1);
          expect(result?.visibleTextContrastSamples).toHaveLength(2);
          expect(result?.visibleTextContrastSamples.join("\n")).toContain("p.bad");
          expect(result?.visibleTextContrastSamples.join("\n")).toContain("p.normal-threshold");
          expect(result?.visibleTextContrastSamples.join("\n")).not.toContain("transparent-child");
          expect(result?.visibleTextContrastSamples.join("\n")).not.toContain("large-threshold");
          expect(result?.visibleTextContrastSamples.join("\n")).not.toContain("hidden-failure");
          expect(result?.visibleTextContrastSamples.join("\n")).not.toContain("zero-sized-failure");
          expect(result?.visibleTextContrastIndeterminateSamples.join("\n")).toContain(
            "p.gradient",
          );
          const missingTokenEvidence = yield* verifyBrowserChallengeWithLocalBrowser({
            ...challenge(`http://127.0.0.1:${address.port}`),
            contrastPairs: [
              {
                id: "unloaded",
                foreground: "--z-not-loaded-foreground",
                background: "--z-not-loaded-background",
                minimum: 4.5,
              },
            ],
          });
          expect(missingTokenEvidence.results[0]?.contrastRatios.unloaded).toBe(0);
          expect(Value.Check(BrowserEvidenceContract, evidence)).toBe(true);
          expect(
            Value.Check(BrowserEvidenceContract, {
              ...evidence,
              results: evidence.results.map((item) => {
                const copy = { ...item } as Partial<typeof item>;
                delete copy.visibleTextContrastFailures;
                return copy;
              }),
            }),
          ).toBe(false);
          expect(
            Value.Check(BrowserEvidenceContract, {
              ...evidence,
              results: evidence.results.map((item) => ({ ...item, undeclaredMeasurement: true })),
            }),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(nodeServicesLayer)),
    40_000,
  );
});
