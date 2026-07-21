import pipeeManifest from "../../../pipee/package.json";
import chromeManifest from "../../../../extensions/chrome/package.json";
import loopManifest from "../../../../extensions/loop/package.json";
import weixinManifest from "../../../../extensions/weixin/package.json";

export const product = {
  packageName: pipeeManifest.name,
  version: pipeeManifest.version,
  cli: Object.keys(pipeeManifest.bin)[0],
};

export const installCommands = {
  pnpm: `pnpm add -g ${product.packageName}`,
  npm: `npm install -g ${product.packageName}`,
  bun: `bun add -g ${product.packageName}`,
} as const;

export const extensions = [
  {
    slug: "chrome",
    name: "Chrome",
    packageName: chromeManifest.name,
    version: chromeManifest.version,
    mark: "◉",
    color: "#5577ff",
    category: "浏览器",
    summary: "让 Pi 使用你已经登录的 Chrome，在真实网页中观察与行动。",
    recommended: true,
  },
  {
    slug: "weixin",
    name: "微信",
    packageName: weixinManifest.name,
    version: weixinManifest.version,
    mark: "••",
    color: "#ff6846",
    category: "消息",
    summary: "从微信把任务交给已有的 Pi Session，并在离开电脑时接收结果。",
    recommended: true,
  },
  {
    slug: "loop",
    name: "Loop",
    packageName: loopManifest.name,
    version: loopManifest.version,
    mark: "↻",
    color: "#b9e94e",
    category: "自动化",
    summary: "让一次对话成为可以定时、等待并持续推进的长期任务。",
    recommended: true,
  },
] as const;
