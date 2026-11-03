export type AuthType = "password" | "key";

export interface JumpHostProfile {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ServerProfile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  color: string;
  lastConnected?: string;
  jumpHost?: JumpHostProfile;
}

export interface SessionState {
  id: string;
  serverId: string;
  title: string;
  connected: boolean;
  terminalStarted: boolean;
  cwd: string;
  selectedFile?: string;
  approvalPolicy?: AiApprovalPolicy;
  aiMessages: AiMessage[];
}

export interface RemoteFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  permissions: string;
  modified?: number;
}

export interface RemoteFileRevision {
  size: number;
  modified?: number | null;
  sha256: string;
  resolvedPath: string;
}

export interface RemoteFileContent {
  content: string;
  revision: RemoteFileRevision;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  command: string;
  memoryPercent: number;
  cpuPercent: number;
  elapsedSeconds: number;
  arguments: string;
}

export interface NetworkConnection {
  protocol: string;
  state: string;
  localAddress: string;
  localPort?: number;
  remoteAddress: string;
  remotePort?: number;
  pid?: number;
  process?: string;
}

export interface NetworkInterface {
  name: string;
  family: string;
  address: string;
  prefixLength?: number;
  state: string;
  mac: string;
  mtu: number;
}

export interface DiskUsage {
  filesystem: string;
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface SystemInformation {
  hostname: string;
  operatingSystem: string;
  kernel: string;
  architecture: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsagePercent: number;
  loadAverage: number[];
  uptimeSeconds: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  disks: DiskUsage[];
}

export type ContainerAction = "start" | "stop" | "restart" | "remove";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkInputBytes: number;
  networkOutputBytes: number;
}

export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface TransferRequest {
  direction: TransferDirection;
  fileName: string;
  sourcePath: string;
  destinationPath: string;
}

export interface TransferProgressEvent {
  transferId: string;
  transferredBytes: number;
  totalBytes?: number;
}

export interface TransferTask extends TransferRequest {
  id: string;
  transferId: string;
  sessionId: string;
  sessionTitle: string;
  serverName: string;
  serverHost: string;
  status: TransferStatus;
  createdAt: number;
  transferredBytes: number;
  totalBytes?: number;
  speedBytesPerSecond: number;
  remainingSeconds?: number;
  finishedAt?: number;
  error?: string;
}

export type MessageRole = "user" | "assistant";
export type AiApprovalPolicy = "request" | "reviewer" | "full-access";

export interface AiTokenUsage {
  available: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  contextTokens: number;
  requests: number;
}

export interface AiImageAttachment {
  id: string;
  kind: "image" | "text";
  remotePath: string;
  mimeType: string;
  name: string;
  size: number;
}

export type AiActionStatus = "started" | "running" | "completed" | "error" | "rejected" | "cancelled";
export type AiMessageType = "text" | "tool" | "approval" | "error";

export interface AiReasoning {
  id: string;
  content: string;
  sequence: number;
}

export interface AiTextSegment {
  id: string;
  content: string;
  sequence: number;
}

export interface AiApproval {
  id: string;
  actionId: string;
  tool: string;
  command: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface AiToolResult {
  id: string;
  sequence: number;
  tool: string;
  command: string;
  arguments?: Record<string, unknown>;
  output: string;
  exitCode: number;
  status: AiActionStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AiMessage {
  id: string;
  role: MessageRole;
  messageType: AiMessageType;
  content: string;
  attachments?: AiImageAttachment[];
  /** Failure details are separate from any reply already streamed to the user. */
  error?: string;
  reasonings?: AiReasoning[];
  textSegments?: AiTextSegment[];
  toolCalls?: AiToolResult[];
  approval?: AiApproval;
  approvalState?: "pending" | "approved" | "rejected";
  approvalNote?: string;
  usage?: AiTokenUsage;
  /** Opaque Rig transcript for this reply, including tool calls and results. */
  modelMessages?: unknown[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  status: AiActionStatus;
}

export type AiToolKey =
  | "executeCommand"
  | "backgroundTask"
  | "ptyInteraction"
  | "readFile"
  | "writeFile"
  | "sftpUpload"
  | "sftpDownload"
  | "listDirectory"
  | "getSystemMetrics"
  | "processManager"
  | "networkChecker"
  | "dockerManager"
  | "systemdControl"
  | "riskChecker"
  | "snippetLibrary"
  | "logAnalyzer";

export interface AiToolSettings {
  executeCommand: boolean;
  backgroundTask: boolean;
  ptyInteraction: boolean;
  readFile: boolean;
  writeFile: boolean;
  sftpUpload: boolean;
  sftpDownload: boolean;
  listDirectory: boolean;
  getSystemMetrics: boolean;
  processManager: boolean;
  networkChecker: boolean;
  dockerManager: boolean;
  systemdControl: boolean;
  riskChecker: boolean;
  snippetLibrary: boolean;
  logAnalyzer: boolean;
  maxToolRounds: number;
  maxOutputChars: number;
  commandTimeoutSeconds: number;
  allowMutatingTools: boolean;
}

export const DEFAULT_AI_TOOL_SETTINGS: AiToolSettings = {
  executeCommand: true,
  backgroundTask: true,
  ptyInteraction: false,
  readFile: true,
  writeFile: false,
  sftpUpload: false,
  sftpDownload: true,
  listDirectory: true,
  getSystemMetrics: true,
  processManager: true,
  networkChecker: true,
  dockerManager: true,
  systemdControl: true,
  riskChecker: true,
  snippetLibrary: true,
  logAnalyzer: true,
  maxToolRounds: 200,
  maxOutputChars: 128000,
  commandTimeoutSeconds: 30,
  allowMutatingTools: false,
};

export type AiApiMode = "chat-completions" | "responses";

export interface ServerImportExportSettings {
  defaultImportGroup: string;
  includeSecretsInExport: boolean;
}

export const DEFAULT_SERVER_IMPORT_EXPORT_SETTINGS: ServerImportExportSettings = {
  defaultImportGroup: "",
  includeSecretsInExport: true,
};

export interface CloudSyncSettings {
  enabled: boolean;
  endpoint: string;
}

export const OFFICIAL_CLOUD_SYNC_ENDPOINT = "https://sshdw.123756.xyz/";

export const DEFAULT_CLOUD_SYNC_SETTINGS: CloudSyncSettings = {
  enabled: false,
  endpoint: import.meta.env.VITE_SSHSTAR_SYNC_API_URL ?? OFFICIAL_CLOUD_SYNC_ENDPOINT,
};

export const AI_REASONING_EFFORT_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "none", label: "关闭" },
  { value: "minimal", label: "极低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
] as const;

export type AiReasoningEffort = typeof AI_REASONING_EFFORT_OPTIONS[number]["value"];
export interface AiModelSettings {
  providerId: string;
  model: string;
  reasoningEffort: AiReasoningEffort;
}

export interface AiProviderModel {
  id: string;
  reasoningEfforts: AiReasoningEffort[];
  defaultReasoningEffort: AiReasoningEffort;
  reasoningEffort: AiReasoningEffort;
}

export interface AiProvider {
  id: string;
  name: string;
  apiMode: AiApiMode;
  endpoint: string;
  apiKey: string;
  models: AiProviderModel[];
  selectedModelId: string;
}

export const createAiProviderModel = (id: string, effort: AiReasoningEffort = "auto"): AiProviderModel => ({
  id,
  reasoningEfforts: AI_REASONING_EFFORT_OPTIONS.map((option) => option.value),
  defaultReasoningEffort: effort,
  reasoningEffort: effort,
});

export interface AiConfig {
  providers: AiProvider[];
  selectedProviderId: string;
  apiMode: AiApiMode;
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: AiReasoningEffort;
  reviewerModel: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  systemPrompt: string;
  tools: AiToolSettings;
  serverImportExport: ServerImportExportSettings;
  cloudSync: CloudSyncSettings;
}

export type AiConfigInput = Omit<Partial<AiConfig>, "providers" | "tools" | "serverImportExport" | "cloudSync"> & {
  providers?: Array<Omit<AiProvider, "apiKey"> & { apiKey?: string }>;
  tools?: Partial<AiToolSettings>;
  serverImportExport?: Partial<ServerImportExportSettings>;
  cloudSync?: Partial<CloudSyncSettings>;
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  providers: [{
    id: "default",
    name: "默认提供商",
    apiMode: "responses",
    endpoint: "https://api.deepseek.com",
    apiKey: "",
    models: [createAiProviderModel("gpt-4.1-mini")],
    selectedModelId: "gpt-4.1-mini",
  }],
  selectedProviderId: "default",
  apiMode: "responses",
  endpoint: "https://api.deepseek.com",
  apiKey: "",
  model: "gpt-4.1-mini",
  reasoningEffort: "auto",
  reviewerModel: "",
  contextWindow: 1000000,
  maxOutputTokens: 384000,
  temperature: 0.2,
  systemPrompt:
    "你是 sshStar 的 Rig 运维 Agent。主动完成用户任务，先观察再行动，优先使用结构化工具获取事实，并验证执行结果。遵守用户限定的范围与当前会话审批策略，已有授权持续有效，不要重复请求确认。遇到可恢复的错误应自行修正并继续。不要声称读取过尚未通过工具访问的文件，只有确实缺少必要信息或授权时才询问用户。",
  tools: DEFAULT_AI_TOOL_SETTINGS,
  serverImportExport: DEFAULT_SERVER_IMPORT_EXPORT_SETTINGS,
  cloudSync: DEFAULT_CLOUD_SYNC_SETTINGS,
};

export function normalizeAiConfig(config: AiConfigInput = {}, fallback: AiConfig = DEFAULT_AI_CONFIG): AiConfig {
  const systemPrompt = config.systemPrompt ?? fallback.systemPrompt;
  const validEffort = (effort: unknown): effort is AiReasoningEffort =>
    AI_REASONING_EFFORT_OPTIONS.some((option) => option.value === effort);
  const legacyEffort = validEffort(config.reasoningEffort) ? config.reasoningEffort : fallback.reasoningEffort;
  const hasLegacySettings = [config.endpoint, config.apiKey, config.apiMode, config.model, config.reasoningEffort]
    .some((field) => field !== undefined);
  const inputProviders = config.providers ?? (hasLegacySettings ? [{
    id: "default", name: "默认提供商",
    apiMode: config.apiMode ?? "chat-completions",
    endpoint: config.endpoint ?? fallback.endpoint,
    apiKey: config.apiKey ?? fallback.providers.find((provider) => provider.id === "default")?.apiKey ?? "",
    models: [createAiProviderModel(config.model ?? fallback.model, legacyEffort)],
    selectedModelId: config.model ?? fallback.model,
  }] : fallback.providers);
  const providers = inputProviders.map((provider) => {
    const previous = fallback.providers.find((item) => item.id === provider.id);
    return {
      ...provider,
      apiKey: provider.apiKey ?? previous?.apiKey ?? "",
      models: provider.models.map((model) => {
        const efforts = [...new Set((model.reasoningEfforts ?? []).filter(validEffort))];
        if (!efforts.length) efforts.push("auto");
        const defaultEffort = efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0];
        return { ...model, reasoningEfforts: efforts, defaultReasoningEffort: defaultEffort,
          reasoningEffort: efforts.includes(model.reasoningEffort) ? model.reasoningEffort : defaultEffort };
      }),
    };
  });
  const provider = providers.find((item) => item.id === (config.selectedProviderId ?? fallback.selectedProviderId)) ?? providers[0];
  const model = provider?.models.find((item) => item.id === provider.selectedModelId) ?? provider?.models[0];
  if (provider && model) provider.selectedModelId = model.id;
  return {
    providers,
    selectedProviderId: provider?.id ?? "",
    apiMode: provider?.apiMode ?? fallback.apiMode,
    endpoint: provider?.endpoint ?? "",
    apiKey: provider?.apiKey ?? "",
    model: model?.id ?? "",
    reasoningEffort: model?.reasoningEffort ?? "auto",
    reviewerModel: config.reviewerModel ?? fallback.reviewerModel,
    contextWindow: config.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: config.maxOutputTokens ?? fallback.maxOutputTokens,
    temperature: config.temperature ?? fallback.temperature,
    systemPrompt,
    tools: { ...DEFAULT_AI_TOOL_SETTINGS, ...fallback.tools, ...(config.tools ?? {}) },
    serverImportExport: {
      ...DEFAULT_SERVER_IMPORT_EXPORT_SETTINGS,
      ...fallback.serverImportExport,
      ...(config.serverImportExport ?? {}),
    },
    cloudSync: {
      ...DEFAULT_CLOUD_SYNC_SETTINGS,
      ...fallback.cloudSync,
      ...(config.cloudSync ?? {}),
    },
  };
}

export function changeAiModelSettings(config: AiConfig, patch: Partial<AiModelSettings>): AiConfig {
  const providerId = patch.providerId ?? config.selectedProviderId;
  return normalizeAiConfig({ ...config, selectedProviderId: providerId, providers: config.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    const modelId = patch.model ?? provider.selectedModelId;
    return { ...provider, selectedModelId: modelId, models: provider.models.map((model) =>
      model.id === modelId && patch.reasoningEffort !== undefined
        ? { ...model, reasoningEffort: patch.reasoningEffort } : model) };
  }) });
}

export function stripAiConfigSecrets(config: AiConfig): AiConfigInput {
  const { apiKey: _apiKey, ...rest } = config;
  return { ...rest, providers: config.providers.map(({ apiKey: _key, ...provider }) => provider) };
}

interface AiAgentEventBase {
  runId: string;
  sequence: number;
  timestamp: number;
}

export type AiAgentEvent = AiAgentEventBase & (
  | { type: "run_started"; model: string; apiMode: string }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_started";
      actionId: string;
      tool: string;
      command: string;
      arguments: Record<string, unknown>;
      startedAt: number;
    }
  | {
      type: "approval_required";
      approvalId: string;
      actionId: string;
      tool: string;
      command: string;
      arguments: Record<string, unknown>;
      reason: string;
    }
  | {
      type: "tool_finished";
      actionId: string;
      tool: string;
      command: string;
      output: string;
      exitCode: number;
      status: AiActionStatus;
      startedAt: number;
      completedAt: number;
    }
  | {
      type: "usage";
      available: boolean;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      contextTokens: number;
      requests: number;
    }
  | { type: "run_completed" }
  | { type: "run_cancelled" }
  | { type: "run_failed"; error: string }
);

export interface AiRunResult {
  content: string;
  reasoning?: string;
  usage: AiTokenUsage;
  modelMessages?: unknown[];
}
export type WorkspaceView = "terminal" | "files" | "split";
