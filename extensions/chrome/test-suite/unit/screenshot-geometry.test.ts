import { expect, it } from "@effect/vitest";
import { SCREENSHOT_LIMITS } from "../../src/protocol/bridge-contract.js";
import {
  isCompleteFullPageTileSet,
  planFullPageTileGeometry,
  planScreenshotRasterGeometry,
} from "../../src/protocol/screenshot-geometry.js";

const plan = (overrides: Partial<Parameters<typeof planFullPageTileGeometry>[0]> = {}) =>
  planFullPageTileGeometry(
    {
      width: 800,
      height: 1_600,
      viewportHeight: 800,
      dpr: 1,
      ...overrides,
    },
    SCREENSHOT_LIMITS,
  );

it("bounds device pixel ratio before planning a full-page capture", () => {
  expect(plan({ dpr: SCREENSHOT_LIMITS.maxDpr })).toMatchObject({ ok: true });
  expect(plan({ dpr: SCREENSHOT_LIMITS.maxDpr + 0.01 })).toEqual({
    ok: false,
    message: expect.stringContaining(`maximum is ${SCREENSHOT_LIMITS.maxDpr}`),
  });
});

it("rejects an oversized raster tile before capture", () => {
  const result = plan({
    width: SCREENSHOT_LIMITS.maxCapturePixels + 1,
    height: 0.25,
    viewportHeight: 0.25,
  });

  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(
      `maximum per capture is ${SCREENSHOT_LIMITS.maxCapturePixels}`,
    ),
  });
});

it("rejects excessive cumulative raster work even when every tile fits", () => {
  const width = 4_096;
  const tileHeight = SCREENSHOT_LIMITS.maxCapturePixels / width;
  const tileCount =
    Math.floor(SCREENSHOT_LIMITS.maxTotalPixels / SCREENSHOT_LIMITS.maxCapturePixels) + 1;
  const result = plan({
    width,
    height: tileHeight * tileCount,
    viewportHeight: tileHeight,
  });

  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(`maximum total is ${SCREENSHOT_LIMITS.maxTotalPixels}`),
  });
});

it("accepts the inclusive tile and total pixel limits", () => {
  const width = 4_096;
  const tileHeight = SCREENSHOT_LIMITS.maxCapturePixels / width;
  const tileCount = SCREENSHOT_LIMITS.maxTotalPixels / SCREENSHOT_LIMITS.maxCapturePixels;
  const result = plan({
    width,
    height: tileHeight * tileCount,
    viewportHeight: tileHeight,
  });

  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.tiles).toHaveLength(tileCount);
});

it("uses the same bounded plan when validating a returned tile set", () => {
  const dimensions = {
    width: 800,
    height: 1_601,
    viewportHeight: 800,
    dpr: 1,
  } as const;
  expect(
    isCompleteFullPageTileSet(dimensions, [{ y: 0 }, { y: 800 }, { y: 1_600 }], SCREENSHOT_LIMITS),
  ).toBe(true);
  expect(
    isCompleteFullPageTileSet(
      { ...dimensions, width: SCREENSHOT_LIMITS.maxCapturePixels + 1 },
      [{ y: 0 }, { y: 800 }, { y: 1_600 }],
      SCREENSHOT_LIMITS,
    ),
  ).toBe(false);
});

it("applies the same raster budget to a single viewport capture", () => {
  expect(
    planScreenshotRasterGeometry({ width: 2_048, height: 2_048, dpr: 2 }, SCREENSHOT_LIMITS),
  ).toEqual({
    ok: true,
    pixelWidth: 4_096,
    pixelHeight: 4_096,
    pixels: SCREENSHOT_LIMITS.maxCapturePixels,
  });
  expect(
    planScreenshotRasterGeometry({ width: 2_049, height: 2_048, dpr: 2 }, SCREENSHOT_LIMITS),
  ).toMatchObject({ ok: false });
});
