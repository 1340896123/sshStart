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
  reasonings?: AiReasoning[];
  toolCalls?: AiToolResult[];
  approval?: AiApproval;
  approvalState?: "pending" | "approved" | "rejected";
  usage?: AiTokenUsage;
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

export interface AiConfig {
  apiMode: AiApiMode;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  systemPrompt: string;
  tools: AiToolSettings;
}

type AiConfigInput = Omit<Partial<AiConfig>, "tools"> & {
  tools?: Partial<AiToolSettings>;
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  apiMode: "responses",
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  contextWindow: 1000000,
  maxOutputTokens: 384000,
  temperature: 0.2,
  systemPrompt:
    "你是 Portico SSH 的 Rig 运维 Agent。先观察再行动，优先使用结构化工具获取事实；明确说明风险和执行结果。不要声称读取过尚未通过工具访问的文件，高风险或变更型动作必须等待人工审批。",
  tools: DEFAULT_AI_TOOL_SETTINGS,
};

export function normalizeAiConfig(config: AiConfigInput = {}, fallback: AiConfig = DEFAULT_AI_CONFIG): AiConfig {
  return {
    apiMode: config.apiMode ?? fallback.apiMode,
    endpoint: config.endpoint ?? fallback.endpoint,
    apiKey: config.apiKey ?? fallback.apiKey,
    model: config.model ?? fallback.model,
    contextWindow: config.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: config.maxOutputTokens ?? fallback.maxOutputTokens,
    temperature: config.temperature ?? fallback.temperature,
    systemPrompt: config.systemPrompt ?? fallback.systemPrompt,
    tools: { ...DEFAULT_AI_TOOL_SETTINGS, ...fallback.tools, ...(config.tools ?? {}) },
  };
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
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
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
}
export type WorkspaceView = "terminal" | "files" | "split";
