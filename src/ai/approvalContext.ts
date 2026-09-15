import type { AiMessage } from "../types";

export function buildApprovalContext(messages: AiMessage[]): string {
  return JSON.stringify(messages.slice(-32).map((message) => ({
    role: message.role,
    content: message.content.slice(0, message.role === "user" ? 6000 : 2000),
    approval: message.approval && {
      tool: message.approval.tool,
      command: message.approval.command,
      state: message.approvalState,
      note: message.approvalNote,
    },
    tools: message.toolCalls?.slice(-8).map((tool) => ({
      tool: tool.tool,
      command: tool.command.slice(0, 2000),
      status: tool.status,
      exitCode: tool.exitCode,
    })),
  })));
}
