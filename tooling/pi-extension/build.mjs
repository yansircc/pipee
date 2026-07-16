import { build } from "vite-plus";
import { resolve } from "node:path";
import {
  isAllowedExternal,
  loadDistributionConfig,
  readDistributionContract,
} from "./distribution-contract.mjs";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const config = await loadDistributionConfig(projectRoot);
const contract = readDistributionContract(projectRoot, config);

await build({
  configFile: false,
  root: contract.root,
  ssr: { noExternal: true },
  build: {
    ssr: config.source,
    target: "node22",
    outDir: contract.outputDirectory,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      external: (specifier) => isAllowedExternal(config, specifier),
      output: { entryFileNames: contract.outputFileName, format: "esm" },
    },
  },
});
