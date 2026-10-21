import { useEffect, useId, useRef, useState } from "react";
import { History, Trash2 } from "lucide-react";
import type { AiConversation } from "../aiHistory";

interface Props {
  conversations: AiConversation[];
  activeConversationId?: string;
  onSelect: (conversation: AiConversation) => void;
  onDelete: (conversationId: string) => void;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const conversationPreview = (conversation: AiConversation) => {
  const lastMessage = conversation.messages[conversation.messages.length - 1];
  return lastMessage?.content.replace(/\s+/g, " ").trim() || "暂无内容";
};

export function AiHistoryPopover({ conversations, activeConversationId, onSelect, onDelete }: Props) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const popoverRef = useRef<HTMLElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>();
  const confirmationId = useId();

  useEffect(() => {
    const popover = popoverRef.current;
    const target = popover?.querySelector<HTMLButtonElement>(".ai-history-item.active .ai-history-select")
      ?? popover?.querySelector<HTMLButtonElement>(".ai-history-select");
    target?.focus();
  }, []);

  const cancelDelete = () => {
    setPendingDeleteId(undefined);
    deleteTriggerRef.current?.focus();
  };

  return (
    <section className="ai-history-popover" ref={popoverRef} role="dialog" aria-label="AI 历史会话">
      <header className="ai-history-heading">
        <span>历史会话</span>
        <small>{conversations.length}</small>
      </header>
      {conversations.length === 0 ? (
        <div className="ai-history-empty">
          <History size={17} />
          <strong>暂无历史会话</strong>
          <span>发送消息后会自动保存在这里</span>
        </div>
      ) : (
        <div className="ai-history-list">
          {conversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            return (
              <div className={`ai-history-item ${active ? "active" : ""}`} key={conversation.id}>
                <button
                  type="button"
                  className="ai-history-select"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(conversation)}
                >
                  <span className="ai-history-title">{conversation.title}</span>
                  <time dateTime={new Date(conversation.updatedAt).toISOString()}>{dateFormatter.format(conversation.updatedAt)}</time>
                  <span className="ai-history-preview">{conversationPreview(conversation)}</span>
                  <small>{conversation.messages.length} 条消息</small>
                </button>
                <button
                  type="button"
                  className="ai-history-delete"
                  title={`删除会话：${conversation.title}`}
                  aria-label={`删除会话：${conversation.title}`}
                  aria-expanded={pendingDeleteId === conversation.id}
                  aria-controls={pendingDeleteId === conversation.id ? confirmationId : undefined}
                  onClick={(event) => {
                    deleteTriggerRef.current = event.currentTarget;
                    setPendingDeleteId(conversation.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
                {pendingDeleteId === conversation.id && (
                  <div
                    className="ai-history-delete-confirm"
                    id={confirmationId}
                    role="group"
                    aria-label="确认删除历史会话"
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      cancelDelete();
                    }}
                  >
                    <p>删除此会话及其未发送草稿？此操作无法撤销。</p>
                    <div>
                      <button type="button" autoFocus onClick={cancelDelete}>取消删除</button>
                      <button type="button" className="danger" onClick={() => {
                        setPendingDeleteId(undefined);
                        onDelete(conversation.id);
                      }}>确认删除</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
