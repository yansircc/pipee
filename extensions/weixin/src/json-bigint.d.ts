declare module "json-bigint" {
  interface JsonBigIntOptions {
    readonly storeAsString?: boolean;
    readonly strict?: boolean;
  }

  interface JsonBigIntCodec {
    readonly parse: (text: string) => unknown;
    readonly stringify: (value: unknown) => string;
  }

  const makeCodec: (options?: JsonBigIntOptions) => JsonBigIntCodec;
  export default makeCodec;
}
