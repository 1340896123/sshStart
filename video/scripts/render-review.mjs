import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(root, "../output/sshstar-video/review");
await mkdir(output, { recursive: true });
const serveUrl = await bundle({
  entryPoint: path.join(root, "src/index.ts"),
  enableCaching: true,
});
const browser = await openBrowser("chrome", {
  browserExecutable:
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  logLevel: "error",
});
try {
  const composition = await selectComposition({
    serveUrl,
    id: "sshStar-Product-Intro",
    puppeteerInstance: browser,
  });
  const frames = [180, 600, 1110, 1710, 2310, 3000, 3600, 4230, 4650, 5160];
  for (const frame of frames) {
    await renderStill({
      serveUrl,
      composition,
      puppeteerInstance: browser,
      frame,
      output: path.join(output, `frame-${frame}.png`),
      scale: 0.75,
      logLevel: "error",
    });
    console.log(`Reviewed frame ${frame} / ${frame / 30}s`);
  }
} finally {
  await browser.close({ silent: true });
}
