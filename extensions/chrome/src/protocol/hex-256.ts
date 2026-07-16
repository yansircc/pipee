export const HEX_256_PATTERN = /^[0-9a-f]{64}$/;

export const isHex256 = (value: unknown): value is string =>
  typeof value === "string" && HEX_256_PATTERN.test(value);
