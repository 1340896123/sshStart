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
