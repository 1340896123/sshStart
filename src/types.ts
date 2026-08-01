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

export interface TransferTask extends TransferRequest {
  id: string;
  transferId: string;
  sessionId: string;
  sessionTitle: string;
  serverName: string;
  serverHost: string;
  status: TransferStatus;
  createdAt: number;
  finishedAt?: number;
  error?: string;
}

export type MessageRole = "user" | "assistant" | "tool";

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

export type AiActionStatus = "started" | "running" | "completed" | "error";
export type AiMessageType = "text" | "command" | "tool" | "approval" | "status" | "error";
export type AiStreamEventType = "message_delta" | "action_update";

export interface AiReasoning {
  id: string;
  content: string;
  sequence?: number;
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

export interface AiApproval {
  tool: string;
  command: string;
  reason: string;
  arguments?: Record<string, unknown>;
}

export interface AiToolResult {
  id: string;
  sequence?: number;
  tool: string;
  command: string;
  output: string;
  exitCode: number;
  status: AiActionStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
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
  maxToolRounds: 6,
  maxOutputChars: 12000,
  commandTimeoutSeconds: 30,
  allowMutatingTools: true,
};

export interface AiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  autoCompress: boolean;
  temperature: number;
  systemPrompt: string;
  tools: AiToolSettings;
}

export interface AiResponse {
  content: string;
  reasoning?: string;
  approval?: AiApproval;
  toolCalls: AiToolResult[];
  usage?: AiTokenUsage;
  compactionSummary?: string;
  compactionMessagesRemoved?: number;
}

export interface AiStreamDelta {
  eventType: AiStreamEventType;
  content?: string;
  reasoning?: string;
  toolCall?: {
    id: string;
    phase: "started" | "running" | "finished" | "error";
    status: AiActionStatus;
    tool: string;
    command: string;
    output?: string;
    exitCode?: number;
    startedAt?: number;
    updatedAt: number;
    completedAt?: number;
  };
}

export type WorkspaceView = "terminal" | "files" | "split";
