import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

export const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

export const pipeeConfig = () => readJson("release/pipee.config.json");

export const run = (command, args, options = {}) => {
  const result = crossSpawn.sync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    const outcome = result.error == null ? `exit ${result.status}` : result.error.message;
    throw new Error(`${command} ${args.join(" ")} failed with ${outcome}`);
  }
  return result.stdout ?? "";
};

export const runAsync = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = crossSpawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal === null ? `exit ${code}` : `signal ${signal}`}`,
          ),
        );
    });
  });

export const sha512Integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
