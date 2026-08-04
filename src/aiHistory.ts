import type { AiMessage, ServerProfile } from "./types";
import { saveAiConversations } from "./storage";

export interface AiConversation {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  messages: AiMessage[];
  createdAt: number;
  updatedAt: number;
}

export const AI_HISTORY_UPDATED_EVENT = "portico:ai-history-updated";

const MAX_CONVERSATIONS_PER_SERVER = 30;
const MAX_TITLE_LENGTH = 38;
let cachedConversations: AiConversation[] = [];

const isConversation = (value: unknown): value is AiConversation => {
  if (!value || typeof value !== "object") return false;
  const conversation = value as Partial<AiConversation>;
  return typeof conversation.id === "string"
    && typeof conversation.serverId === "string"
    && typeof conversation.serverName === "string"
    && typeof conversation.title === "string"
    && Array.isArray(conversation.messages)
    && typeof conversation.createdAt === "number"
    && typeof conversation.updatedAt === "number";
};

const conversationTitle = (messages: AiMessage[]) => {
  const source = messages.find((message) => message.role === "user")?.content
    ?? messages[0]?.content
    ?? "新的 AI 会话";
  const compact = source.replace(/\s+/g, " ").trim();
  return compact.length > MAX_TITLE_LENGTH ? `${compact.slice(0, MAX_TITLE_LENGTH)}...` : compact;
};

const trimConversations = (conversations: AiConversation[]) => {
  const serverCounts = new Map<string, number>();
  return [...conversations]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((conversation) => {
      const count = serverCounts.get(conversation.serverId) ?? 0;
      if (count >= MAX_CONVERSATIONS_PER_SERVER) return false;
      serverCounts.set(conversation.serverId, count + 1);
      return true;
    });
};

export const readAiConversations = () => cachedConversations;

const notifyAiHistoryUpdated = (conversations: AiConversation[]) => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AiConversation[]>(AI_HISTORY_UPDATED_EVENT, { detail: conversations }));
  }
};

export const initializeAiConversations = (conversations: AiConversation[]) => {
  cachedConversations = trimConversations(conversations.filter(isConversation));
  notifyAiHistoryUpdated(cachedConversations);
  return cachedConversations;
};

export const publishAiConversations = (conversations: AiConversation[]) => {
  cachedConversations = trimConversations(conversations);
  void saveAiConversations(cachedConversations).catch((error) => {
    console.error("Failed to save AI conversations", error);
  });
  notifyAiHistoryUpdated(cachedConversations);
  return cachedConversations;
};

export const upsertAiConversation = (
  conversations: AiConversation[],
  conversationId: string,
  server: ServerProfile,
  messages: AiMessage[],
) => {
  const existing = conversations.find((conversation) => conversation.id === conversationId);
  const now = Date.now();
  const nextConversation: AiConversation = {
    id: conversationId,
    serverId: server.id,
    serverName: server.name,
    title: existing?.title ?? conversationTitle(messages),
    messages,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return [nextConversation, ...conversations.filter((conversation) => conversation.id !== conversationId)];
};
