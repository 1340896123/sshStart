import { FolderOpen, Trash2, X } from "lucide-react";

interface Props {
  groupName: string;
  serverCount: number;
  dissolveDescription: string;
  onClose: () => void;
  onDissolve: () => void;
  onDeleteServers: () => void;
}

export function GroupDeleteDialog({
  groupName,
  serverCount,
  dissolveDescription,
  onClose,
  onDissolve,
  onDeleteServers,
}: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="dialog group-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-delete-title"
        aria-describedby="group-delete-summary"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <header className="dialog-header">
          <div className="dialog-icon"><FolderOpen size={16} /></div>
          <div>
            <h2 id="group-delete-title">删除分组“{groupName}”</h2>
            <p id="group-delete-summary">分组内共有 {serverCount} 台服务器，请选择处理方式</p>
          </div>
          <button className="icon-button quiet" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="group-delete-options">
          <button className="group-delete-option" type="button" autoFocus onClick={onDissolve}>
            <span className="group-delete-option-icon"><FolderOpen size={17} /></span>
            <span>
              <strong>解散分组，保留服务器</strong>
              <small>{dissolveDescription}</small>
            </span>
          </button>
          <button className="group-delete-option danger" type="button" onClick={onDeleteServers}>
            <span className="group-delete-option-icon"><Trash2 size={17} /></span>
            <span>
              <strong>删除分组和服务器</strong>
              <small>删除该分组、所有子分组及其中 {serverCount} 台服务器，同时关闭相关会话。</small>
            </span>
          </button>
        </div>

        <footer className="dialog-footer">
          <span className="dialog-footer-note">删除服务器后无法恢复</span>
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
        </footer>
      </section>
    </div>
  );
}
