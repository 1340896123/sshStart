import { useId, useRef, useState } from "react";
import { CornerUpLeft, ListPlus, Pencil, Trash2 } from "lucide-react";
import type { PendingAiMessage } from "../ai/useAiAgent";

interface Props {
  message: PendingAiMessage;
  stopping: boolean;
  onEdit: (id: string) => boolean;
  onSave: (id: string, content: string) => boolean;
  onCancel: (id: string) => void;
  onGuide: (id: string) => void;
  onRemove: (id: string) => void;
  onFocusComposer: () => void;
}

export function AiPendingMessage({ message, stopping, onEdit, onSave, onCancel, onGuide, onRemove, onFocusComposer }: Props) {
  const [content, setContent] = useState(message.content);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const label = message.content || "附件消息";
  const returnFocus = () => window.requestAnimationFrame(() => {
    if (editButtonRef.current) editButtonRef.current.focus();
    else onFocusComposer();
  });
  const cancel = () => {
    onCancel(message.id);
    returnFocus();
  };

  return <li className={message.editing ? "editing" : undefined}>
    {message.editing ? <form className="ai-pending-editor" onSubmit={(event) => {
      event.preventDefault();
      if (onSave(message.id, content)) returnFocus();
    }}>
      <textarea autoFocus aria-label="编辑排队消息" aria-describedby={hintId} value={content} rows={3}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      {message.attachments.length > 0 && <p className="ai-pending-edit-attachments" title={message.attachments.map((attachment) => attachment.name).join("、")}>
        保留 {message.attachments.length} 个附件
      </p>}
      <div className="ai-pending-edit-actions">
        <small id={hintId} title="Ctrl + Enter 保存，Esc 取消">保存后保持原排队位置</small>
        <button type="button" aria-label="取消编辑" onClick={cancel}>取消</button>
        <button className="ai-pending-save" type="submit" aria-label="保存编辑" disabled={!content.trim() && !message.attachments.length}>保存</button>
      </div>
    </form> : <>
      <ListPlus size={13} aria-hidden="true" />
      <div className="ai-pending-copy" title={`${message.content}\n${message.attachments.map((attachment) => attachment.name).join(" · ")}\n${message.config.model} · ${message.config.reasoningEffort}`}>
        <strong>{message.content || message.attachments.map((attachment) => attachment.name).join("、")}</strong>
      </div>
      <button className="ai-pending-text-action" type="button" title="优先处理这条消息" aria-label={`引导：${label}`} disabled={stopping}
        onClick={() => onGuide(message.id)}><CornerUpLeft size={12} aria-hidden="true" /><span>引导</span></button>
      <button className="ai-pending-text-action" ref={editButtonRef} type="button" title="编辑这条排队消息" aria-label={`编辑：${label}`}
        onClick={() => { if (onEdit(message.id)) setContent(message.content); }}><Pencil size={12} aria-hidden="true" /><span>编辑</span></button>
      <button type="button" title="移除待发送消息" aria-label={`移除待发送消息：${label}`}
        onClick={() => onRemove(message.id)}><Trash2 size={12} aria-hidden="true" /></button>
    </>}
  </li>;
}
