import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.resolve(root, "../output/sshstar-video");
await mkdir(directory, { recursive: true });
const output = path.join(directory, "sshStar-产品介绍-3分钟.mp4");
await mkdir(path.join(directory, "review"), { recursive: true });
const master = path.join(directory, "review/render-master.mp4");
console.log("Bundling sshStar 1080p / 30fps / 180s composition…");
const serveUrl = await bundle({
  entryPoint: path.join(root, "src/index.ts"),
  enableCaching: true,
});
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await openBrowser("chrome", {
  browserExecutable: existsSync(edge) ? edge : undefined,
  logLevel: "error",
});
let previous = -1;
try {
  const composition = await selectComposition({
    serveUrl,
    id: "sshStar-Product-Intro",
    puppeteerInstance: browser,
  });
  await renderMedia({
    serveUrl,
    composition,
    puppeteerInstance: browser,
    codec: "h264",
    outputLocation: master,
    crf: 18,
    x264Preset: "fast",
    pixelFormat: "yuv420p",
    imageFormat: "jpeg",
    jpegQuality: 90,
    concurrency: 6,
    audioCodec: "aac",
    audioBitrate: "192k",
    enforceAudioTrack: true,
    logLevel: "warn",
    onProgress(progress) {
      const bucket = Math.floor(progress.progress * 20);
      if (bucket !== previous) {
        previous = bucket;
        console.log(
          `${Math.round(progress.progress * 100)}% | ${progress.renderedFrames}/5400 frames | encoded ${progress.encodedFrames}`,
        );
      }
    },
  });
  execFileSync("python", [path.join(root, "scripts/finalize-output.py")], {
    stdio: "inherit",
  });
  console.log(`Rendered: ${output}`);
} finally {
  await browser.close({ silent: true });
}
