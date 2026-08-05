import { resolve } from "node:path";
import { createSyncServer } from "./app.mjs";

const host = process.env.PORTICO_SYNC_HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.PORTICO_SYNC_PORT ?? "8787", 10);
const databasePath = resolve(process.env.PORTICO_SYNC_DATABASE_PATH?.trim() || "./data/portico-sync.sqlite");
const tokenSecret = process.env.PORTICO_SYNC_TOKEN_SECRET;
const trustProxy = ["1", "true"].includes(process.env.PORTICO_SYNC_TRUST_PROXY?.trim().toLocaleLowerCase("en-US") ?? "");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORTICO_SYNC_PORT 必须是 1-65535 之间的整数");
  process.exit(1);
}

let app;
try {
  app = createSyncServer({ databasePath, tokenSecret, trustProxy });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

app.server.listen(port, host, () => {
  console.log(`Portico SSH sync server listening on http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error("关闭同步服务失败", error);
    process.exit(1);
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
