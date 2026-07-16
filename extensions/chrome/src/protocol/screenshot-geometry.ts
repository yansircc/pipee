export type FullPageTile = { readonly y: number; readonly height: number };

export type ScreenshotRasterGeometry = {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
};

export type ScreenshotRasterLimits = {
  readonly maxDpr: number;
  readonly maxCapturePixels: number;
};

export type FullPageCaptureGeometry = ScreenshotRasterGeometry & {
  readonly viewportHeight: number;
};

export type FullPageCaptureLimits = ScreenshotRasterLimits & {
  readonly maxTiles: number;
  readonly maxTotalPixels: number;
};

export type ScreenshotRasterPlan =
  | {
      readonly ok: true;
      readonly pixelWidth: number;
      readonly pixelHeight: number;
      readonly pixels: number;
    }
  | { readonly ok: false; readonly message: string };

export type FullPageTilePlan =
  | { readonly ok: true; readonly tiles: ReadonlyArray<FullPageTile> }
  | { readonly ok: false; readonly message: string };

export const planScreenshotRasterGeometry = (
  geometry: ScreenshotRasterGeometry,
  limits: ScreenshotRasterLimits,
): ScreenshotRasterPlan => {
  const { width, height, dpr } = geometry;
  if (!Number.isFinite(width) || width <= 0) {
    return {
      ok: false,
      message: `Screenshot capture requires a positive finite width, received ${width}`,
    };
  }
  if (!Number.isFinite(height) || height <= 0) {
    return {
      ok: false,
      message: `Screenshot capture requires a positive finite height, received ${height}`,
    };
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    return {
      ok: false,
      message: `Screenshot capture requires a positive finite device pixel ratio, received ${dpr}`,
    };
  }
  if (dpr > limits.maxDpr) {
    return {
      ok: false,
      message: `Screenshot capture device pixel ratio is ${dpr}; maximum is ${limits.maxDpr}`,
    };
  }
  const pixelWidth = Math.ceil(width * dpr);
  const pixelHeight = Math.ceil(height * dpr);
  const pixels = pixelWidth * pixelHeight;
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight) ||
    !Number.isSafeInteger(pixels) ||
    pixels > limits.maxCapturePixels
  ) {
    return {
      ok: false,
      message: `Screenshot capture requires ${pixels} pixels; maximum per capture is ${limits.maxCapturePixels}`,
    };
  }
  return { ok: true, pixelWidth, pixelHeight, pixels };
};

export const planFullPageTileGeometry = (
  geometry: FullPageCaptureGeometry,
  limits: FullPageCaptureLimits,
): FullPageTilePlan => {
  const { width, height, viewportHeight, dpr } = geometry;
  if (!Number.isFinite(height) || height <= 0) {
    return {
      ok: false,
      message: `Screenshot capture requires a positive finite height, received ${height}`,
    };
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return {
      ok: false,
      message: `Screenshot capture requires a positive finite viewport height, received ${viewportHeight}`,
    };
  }
  const count = Math.ceil(height / viewportHeight);
  if (count > limits.maxTiles) {
    return {
      ok: false,
      message: `Screenshot capture requires ${count} tiles; maximum is ${limits.maxTiles}`,
    };
  }

  const tiles: Array<FullPageTile> = [];
  let totalPixels = 0;
  for (let index = 0; index < count; index += 1) {
    const y = index * viewportHeight;
    const tile = { y, height: Math.min(viewportHeight, height - y) };
    const raster = planScreenshotRasterGeometry({ width, height: tile.height, dpr }, limits);
    if (!raster.ok) return raster;
    totalPixels += raster.pixels;
    if (!Number.isSafeInteger(totalPixels) || totalPixels > limits.maxTotalPixels) {
      return {
        ok: false,
        message: `Screenshot capture requires ${totalPixels} pixels; maximum total is ${limits.maxTotalPixels}`,
      };
    }
    tiles.push(tile);
  }
  return { ok: true, tiles };
};

export const isCompleteFullPageTileSet = (
  dimensions: FullPageCaptureGeometry,
  tiles: ReadonlyArray<{ readonly y: number }>,
  limits: FullPageCaptureLimits,
): boolean => {
  const plan = planFullPageTileGeometry(dimensions, limits);
  return (
    plan.ok &&
    tiles.length === plan.tiles.length &&
    tiles.every((tile, index) => tile.y === plan.tiles[index]?.y)
  );
};
