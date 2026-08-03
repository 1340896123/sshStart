import type { AiConfig, ServerProfile } from "./types";

interface DevBootstrapConfig {
  servers?: ServerProfile[];
  ai?: Partial<AiConfig>;
}

const envValue = (name: string) => {
  const value = import.meta.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const envNumber = (name: string, fallback: number) => {
  const value = Number(envValue(name));
  return Number.isFinite(value) ? value : fallback;
};

const createDevBootstrap = (): DevBootstrapConfig | undefined => {
  if (!import.meta.env.DEV || envValue("VITE_PORTICO_DEV_BOOTSTRAP") !== "true") return undefined;

  const createServer = (prefix: string, fallbackId: string): ServerProfile | undefined => {
    const host = envValue(`${prefix}_HOST`);
    if (!host) return undefined;
    const port = envNumber(`${prefix}_PORT`, 22);
    const jumpHost = envValue(`${prefix}_JUMP_HOST`);
    const jumpPort = envNumber(`${prefix}_JUMP_PORT`, 22);
    return {
      id: envValue(`${prefix}_ID`) ?? fallbackId,
      name: envValue(`${prefix}_NAME`) ?? host,
      group: envValue(`${prefix}_GROUP`) ?? "Debug",
      host,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      username: envValue(`${prefix}_USERNAME`) ?? "root",
      authType: envValue(`${prefix}_AUTH_TYPE`) === "key" ? "key" : "password",
      password: envValue(`${prefix}_PASSWORD`),
      privateKeyPath: envValue(`${prefix}_PRIVATE_KEY_PATH`),
      passphrase: envValue(`${prefix}_PASSPHRASE`),
      color: envValue(`${prefix}_COLOR`) ?? "#2f7d68",
      jumpHost: envValue(`${prefix}_JUMP_ENABLED`) === "true" && jumpHost ? {
        enabled: true,
        host: jumpHost,
        port: Number.isInteger(jumpPort) && jumpPort > 0 && jumpPort <= 65535 ? jumpPort : 22,
        username: envValue(`${prefix}_JUMP_USERNAME`) ?? "root",
        authType: envValue(`${prefix}_JUMP_AUTH_TYPE`) === "key" ? "key" : "password",
        password: envValue(`${prefix}_JUMP_PASSWORD`),
        privateKeyPath: envValue(`${prefix}_JUMP_PRIVATE_KEY_PATH`),
        passphrase: envValue(`${prefix}_JUMP_PASSPHRASE`),
      } : undefined,
    };
  };

  const servers = [
    createServer("VITE_PORTICO_SSH", "dev-bootstrap-server"),
    createServer("VITE_PORTICO_INTERNAL_SSH", "internal-10-2-80-55"),
  ].filter((server): server is ServerProfile => Boolean(server));
  const endpoint = envValue("VITE_PORTICO_AI_ENDPOINT");
  const apiKey = envValue("VITE_PORTICO_AI_API_KEY");

  return {
    servers,
    ai: endpoint || apiKey ? {
      endpoint,
      apiKey,
      model: envValue("VITE_PORTICO_AI_MODEL"),
      apiMode: envValue("VITE_PORTICO_AI_API_MODE") === "chat-completions" ? "chat-completions" : "responses",
      contextWindow: envNumber("VITE_PORTICO_AI_CONTEXT_WINDOW", 1000000),
      maxOutputTokens: envNumber("VITE_PORTICO_AI_MAX_OUTPUT_TOKENS", 384000),
      temperature: envNumber("VITE_PORTICO_AI_TEMPERATURE", 0.2),
    } : undefined,
  };
};

export const DEV_BOOTSTRAP = createDevBootstrap();
