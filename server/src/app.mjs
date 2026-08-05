import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN_ISSUER = "portico-ssh-sync";
const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 256;
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const base64UrlJson = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const derivePassword = (password, salt, cost = SCRYPT_COST, blockSize = SCRYPT_BLOCK_SIZE, parallelization = SCRYPT_PARALLELIZATION) =>
  new Promise((resolvePromise, rejectPromise) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => {
      if (error) rejectPromise(error);
      else resolvePromise(key);
    });
  });

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return [
    "scrypt",
    "v1",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password, encodedHash) {
  const parts = typeof encodedHash === "string" ? encodedHash.split("$") : [];
  const validFormat = parts.length === 7 && parts[0] === "scrypt" && parts[1] === "v1";
  const cost = validFormat ? Number.parseInt(parts[2], 10) : SCRYPT_COST;
  const blockSize = validFormat ? Number.parseInt(parts[3], 10) : SCRYPT_BLOCK_SIZE;
  const parallelization = validFormat ? Number.parseInt(parts[4], 10) : SCRYPT_PARALLELIZATION;
  const validParameters = Number.isInteger(cost)
    && cost >= 16384
    && cost <= SCRYPT_COST
    && Number.isInteger(blockSize)
    && blockSize === SCRYPT_BLOCK_SIZE
    && Number.isInteger(parallelization)
    && parallelization >= 1
    && parallelization <= 4;

  let salt = Buffer.alloc(16);
  let expected = Buffer.alloc(SCRYPT_KEY_LENGTH);
  if (validFormat && validParameters) {
    try {
      salt = Buffer.from(parts[5], "base64url");
      expected = Buffer.from(parts[6], "base64url");
    } catch {
      return false;
    }
  }

  const actual = await derivePassword(
    password,
    salt.length > 0 ? salt : Buffer.alloc(16),
    validParameters ? cost : SCRYPT_COST,
    validParameters ? blockSize : SCRYPT_BLOCK_SIZE,
    validParameters ? parallelization : SCRYPT_PARALLELIZATION,
  );
  return validFormat
    && validParameters
    && expected.length === actual.length
    && timingSafeEqual(expected, actual);
}

function createToken(user, secret, ttlSeconds, nowSeconds) {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: TOKEN_ISSUER,
    sub: user.id,
    email: user.email,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyToken(token, secret, nowSeconds) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "登录令牌无效或已过期");

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(unsigned).digest();
  let actual;
  let payload;
  try {
    actual = Buffer.from(parts[2], "base64url");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, "登录令牌无效或已过期");
  }

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, "登录令牌无效或已过期");
  }
  if (payload?.iss !== TOKEN_ISSUER
    || !Number.isInteger(payload.sub)
    || !Number.isInteger(payload.exp)
    || payload.exp <= nowSeconds) {
    throw new HttpError(401, "登录令牌无效或已过期");
  }
  return payload;
}

function normalizeEmail(value) {
  if (typeof value !== "string") throw new HttpError(400, "请输入有效的邮箱地址");
  const email = value.trim().toLocaleLowerCase("en-US");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "请输入有效的邮箱地址");
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== "string") throw new HttpError(400, "密码至少需要 8 位");
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, `密码长度必须为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`);
  }
  return value;
}

async function readJson(request, maxBodyBytes) {
  const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new HttpError(413, "请求内容过大");
  }

  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "请求内容过大");
  if (totalBytes === 0) throw new HttpError(400, "请求正文不能为空");

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "请求正文不是有效的 JSON 对象");
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extraHeaders,
  };
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function sendEmpty(response, status) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function createRateLimiter(maxAttempts, windowMs) {
  const buckets = new Map();
  return (key, nowMs) => {
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      bucket = { count: 0, resetAt: nowMs + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= maxAttempts) {
      return Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000));
    }
    bucket.count += 1;
    if (buckets.size > 10000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= nowMs) buckets.delete(bucketKey);
      }
    }
    return 0;
  };
}

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sync_snapshots (
      user_id INTEGER PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      stored_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) STRICT;
  `);
  return database;
}

export function createSyncServer({
  databasePath = "./data/portico-sync.sqlite",
  tokenSecret,
  tokenTtlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
  maxCiphertextBytes = DEFAULT_MAX_CIPHERTEXT_BYTES,
  authRateLimit = 10,
  authRateWindowMs = 15 * 60 * 1000,
  trustProxy = false,
  now = () => Date.now(),
} = {}) {
  if (typeof tokenSecret !== "string" || Buffer.byteLength(tokenSecret) < 32) {
    throw new Error("PORTICO_SYNC_TOKEN_SECRET 必须至少包含 32 字节");
  }
  if (!Number.isInteger(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new Error("tokenTtlSeconds 必须是正整数");
  }

  const database = openDatabase(databasePath);
  const findUserByEmail = database.prepare("SELECT id, email, password_hash FROM users WHERE email = ?");
  const findUserById = database.prepare("SELECT id, email FROM users WHERE id = ?");
  const insertUser = database.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)");
  const findSnapshot = database.prepare("SELECT ciphertext FROM sync_snapshots WHERE user_id = ?");
  const saveSnapshot = database.prepare(`
    INSERT INTO sync_snapshots (user_id, ciphertext, updated_at, stored_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      updated_at = excluded.updated_at,
      stored_at = excluded.stored_at
  `);
  const takeAuthAttempt = createRateLimiter(authRateLimit, authRateWindowMs);
  const maxBodyBytes = maxCiphertextBytes + 64 * 1024;

  const authenticate = (request) => {
    const authorization = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) throw new HttpError(401, "请先登录同步账号");
    const payload = verifyToken(match[1], tokenSecret, Math.floor(now() / 1000));
    const user = findUserById.get(payload.sub);
    if (!user) throw new HttpError(401, "登录令牌无效或已过期");
    return user;
  };

  const handleAuth = async (request, response, path) => {
    const forwardedFor = trustProxy ? request.headers["x-forwarded-for"] : undefined;
    const forwardedAddress = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
      ?.split(",", 1)[0]
      ?.trim();
    const clientAddress = forwardedAddress || request.socket.remoteAddress || "unknown";
    const retryAfter = takeAuthAttempt(`${clientAddress}:${path}`, now());
    if (retryAfter > 0) {
      throw new HttpError(429, "登录尝试过于频繁，请稍后再试", { "retry-after": String(retryAfter) });
    }

    const body = await readJson(request, maxBodyBytes);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    const nowSeconds = Math.floor(now() / 1000);

    if (path === "/auth/register") {
      if (findUserByEmail.get(email)) throw new HttpError(409, "该邮箱已注册");
      const passwordHash = await hashPassword(password);
      let result;
      try {
        result = insertUser.run(email, passwordHash, nowSeconds);
      } catch (error) {
        if (String(error?.code ?? "").startsWith("ERR_SQLITE_CONSTRAINT")) {
          throw new HttpError(409, "该邮箱已注册");
        }
        throw error;
      }
      const user = { id: Number(result.lastInsertRowid), email };
      sendJson(response, 201, {
        token: createToken(user, tokenSecret, tokenTtlSeconds, nowSeconds),
        email,
      });
      return;
    }

    const user = findUserByEmail.get(email);
    const passwordMatches = await verifyPassword(password, user?.password_hash);
    if (!user || !passwordMatches) throw new HttpError(401, "邮箱或密码错误");
    sendJson(response, 200, {
      token: createToken(user, tokenSecret, tokenTtlSeconds, nowSeconds),
      email: user.email,
    });
  };

  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "POST" && (path === "/auth/register" || path === "/auth/login")) {
      await handleAuth(request, response, path);
      return;
    }
    if (path === "/sync/data" && request.method === "GET") {
      const user = authenticate(request);
      const snapshot = findSnapshot.get(user.id);
      if (!snapshot) throw new HttpError(404, "该账号还没有同步快照");
      sendJson(response, 200, { ciphertext: snapshot.ciphertext });
      return;
    }
    if (path === "/sync/data" && request.method === "PUT") {
      const user = authenticate(request);
      const body = await readJson(request, maxBodyBytes);
      if (typeof body.ciphertext !== "string" || body.ciphertext.trim().length === 0) {
        throw new HttpError(400, "ciphertext 必须是非空字符串");
      }
      if (Buffer.byteLength(body.ciphertext) > maxCiphertextBytes) {
        throw new HttpError(413, "同步密文过大");
      }
      if (!Number.isSafeInteger(body.updatedAt) || body.updatedAt < 0) {
        throw new HttpError(400, "updatedAt 必须是非负整数时间戳");
      }
      saveSnapshot.run(user.id, body.ciphertext, body.updatedAt, Math.floor(now() / 1000));
      sendEmpty(response, 204);
      return;
    }

    if (path === "/auth/register" || path === "/auth/login" || path === "/sync/data") {
      throw new HttpError(405, "请求方法不受支持");
    }
    throw new HttpError(404, "接口不存在");
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { message: error.message }, error.headers);
        return;
      }
      console.error("[portico-sync] request failed", error);
      sendJson(response, 500, { message: "服务器内部错误" });
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    async close() {
      if (server.listening) {
        await new Promise((resolvePromise, rejectPromise) => {
          server.close((error) => error ? rejectPromise(error) : resolvePromise());
        });
      }
      database.close();
    },
  };
}
