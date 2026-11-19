/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import { existsSync } from "node:fs";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
Config.setCodec("h264");
Config.setCrf(18);
Config.setConcurrency(6);
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
if (process.platform === "win32" && existsSync(edge))
  Config.setBrowserExecutable(edge);
