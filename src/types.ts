export type AuthType = "password" | "key";

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
export type TransferStatus = "queued" | "running" | "completed" | "failed";

export interface TransferRequest {
  direction: TransferDirection;
  fileName: string;
  sourcePath: string;
  destinationPath: string;
}

export interface TransferTask extends TransferRequest {
  id: string;
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

export interface AiMessage {
  id: string;
  role: MessageRole;
  content: string;
  reasoning?: string;
  command?: string;
  commandOutput?: string;
  createdAt: number;
}

export interface AiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  supportsImages: boolean;
  temperature: number;
  systemPrompt: string;
}

export interface AiResponse {
  content: string;
  reasoning?: string;
  toolCalls: Array<{
    command: string;
    output: string;
    exitCode: number;
  }>;
}

export type WorkspaceView = "terminal" | "files" | "split";
