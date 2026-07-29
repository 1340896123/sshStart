import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  CircleX,
  Clock3,
  Trash2,
  X,
} from "lucide-react";
import type { TransferTask } from "../types";

interface Props {
  transfers: TransferTask[];
  onActivateSession: (sessionId: string) => void;
  onClearFinished: () => void;
  onDismiss: (id: string) => void;
}

type TransferFilter = "active" | "all";

const statusCopy = {
  queued: "等待中",
  running: "传输中",
  completed: "已完成",
  failed: "失败",
} as const;

function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function TransferPanel({ transfers, onActivateSession, onClearFinished, onDismiss }: Props) {
  const [filter, setFilter] = useState<TransferFilter>("active");
  const activeCount = transfers.filter((task) => task.status === "queued" || task.status === "running").length;
  const finishedCount = transfers.length - activeCount;
  const visibleTransfers = useMemo(
    () => transfers.filter((task) => filter === "all" || task.status === "queued" || task.status === "running"),
    [filter, transfers],
  );

  return (
    <aside className="server-sidebar transfer-sidebar" aria-label="传输列表">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">任务中心</span>
          <h1>文件传输</h1>
        </div>
        <button
          className="icon-button"
          aria-label="清除已完成传输"
          title="清除已完成传输"
          disabled={finishedCount === 0}
          onClick={onClearFinished}
        ><Trash2 size={14} /></button>
      </div>

      <div className="transfer-summary" aria-live="polite">
        <span><strong>{activeCount}</strong> 进行中</span>
        <span><strong>{transfers.length}</strong> 全部</span>
      </div>

      <div className="transfer-filters" role="tablist" aria-label="传输筛选">
        <button role="tab" aria-selected={filter === "active"} className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>进行中</button>
        <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
      </div>

      <div className="transfer-list">
        {visibleTransfers.map((task) => {
          const DirectionIcon = task.direction === "upload" ? ArrowUpToLine : ArrowDownToLine;
          const StatusIcon = task.status === "completed" ? Check : task.status === "failed" ? CircleX : Clock3;
          return (
            <div className={`transfer-item status-${task.status}`} key={task.id}>
              <button className="transfer-main" onClick={() => onActivateSession(task.sessionId)} title={`切换到 ${task.sessionTitle}`}>
                <span className="transfer-direction"><DirectionIcon size={14} /></span>
                <span className="transfer-copy">
                  <strong>{task.fileName}</strong>
                  <span>{task.sessionTitle} · {task.serverHost}</span>
                  <span className="transfer-path" title={task.destinationPath}>{task.destinationPath}</span>
                </span>
              </button>
              <div className="transfer-state">
                <span><StatusIcon size={11} />{statusCopy[task.status]}</span>
                <time>{timeLabel(task.finishedAt ?? task.createdAt)}</time>
                {(task.status === "completed" || task.status === "failed") && (
                  <button className="transfer-dismiss" title="从列表移除" aria-label={`移除 ${task.fileName}`} onClick={() => onDismiss(task.id)}><X size={11} /></button>
                )}
              </div>
              {task.status === "running" && <span className="transfer-progress" />}
              {task.error && <p title={task.error}>{task.error}</p>}
            </div>
          );
        })}
        {visibleTransfers.length === 0 && (
          <div className="transfer-empty">
            <ArrowUpToLine size={18} />
            <strong>{filter === "active" ? "没有正在传输的任务" : "还没有传输记录"}</strong>
          </div>
        )}
      </div>

      <div className="transfer-footer-note">{activeCount > 0 ? `${activeCount} 个活动任务` : "队列空闲"}</div>
    </aside>
  );
}
