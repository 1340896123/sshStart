import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Home,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { formatBytes, isTauri, joinRemotePath, parentPath } from "../lib";
import type { RemoteFile, ServerProfile, SessionState } from "../types";

interface Props {
  session: SessionState;
  server: ServerProfile;
  onUpdate: (patch: Partial<SessionState>) => void;
}

const DEMO_FILES: RemoteFile[] = [
  { name: "apps", path: "/apps", isDir: true, size: 0, permissions: "drwxr-xr-x" },
  { name: "backups", path: "/backups", isDir: true, size: 0, permissions: "drwxr-x---" },
  { name: "etc", path: "/etc", isDir: true, size: 0, permissions: "drwxr-xr-x" },
  { name: "home", path: "/home", isDir: true, size: 0, permissions: "drwxr-xr-x" },
  { name: "opt", path: "/opt", isDir: true, size: 0, permissions: "drwxr-xr-x" },
  { name: "var", path: "/var", isDir: true, size: 0, permissions: "drwxr-xr-x" },
  { name: "deploy.sh", path: "/deploy.sh", isDir: false, size: 2387, permissions: "-rwxr-xr-x" },
  { name: "healthcheck.log", path: "/healthcheck.log", isDir: false, size: 19424, permissions: "-rw-r--r--" },
  { name: "release.tar.gz", path: "/release.tar.gz", isDir: false, size: 8249230, permissions: "-rw-r--r--" },
];

function FileGlyph({ file }: { file: RemoteFile }) {
  if (file.isDir) return <Folder size={15} className="folder-glyph" />;
  if (/\.(zip|tar|gz|7z)$/i.test(file.name)) return <FileArchive size={15} />;
  if (/\.(sh|js|ts|rs|py|json|ya?ml)$/i.test(file.name)) return <FileCode2 size={15} />;
  if (/\.(txt|log|md)$/i.test(file.name)) return <FileText size={15} />;
  return <File size={15} />;
}

export function FilePane({ session, server, onUpdate }: Props) {
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const next = isTauri()
        ? await invoke<RemoteFile[]>("list_directory", { server, path })
        : DEMO_FILES.map((file) => ({ ...file, path: joinRemotePath(path, file.name) }));
      setFiles(next);
      onUpdate({ cwd: path, selectedFile: undefined });
      setSelected(undefined);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [onUpdate, server]);

  useEffect(() => {
    void load(session.cwd);
    // Load once per session; navigation calls load directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const visibleFiles = useMemo(() => files.filter((file) => file.name.toLowerCase().includes(filter.toLowerCase())), [files, filter]);
  const pathParts = session.cwd.split("/").filter(Boolean);

  const upload = async () => {
    if (!isTauri()) return;
    const localPath = await open({ multiple: false, directory: false });
    if (!localPath) return;
    const name = localPath.split(/[\\/]/).pop() ?? "upload";
    await invoke("upload_file", { server, localPath, remotePath: joinRemotePath(session.cwd, name) });
    await load(session.cwd);
  };

  const download = async () => {
    const file = files.find((item) => item.path === selected);
    if (!file || file.isDir || !isTauri()) return;
    const localPath = await save({ defaultPath: file.name });
    if (!localPath) return;
    await invoke("download_file", { server, remotePath: file.path, localPath });
  };

  const createFolder = async () => {
    const name = prompt("新文件夹名称");
    if (!name) return;
    if (isTauri()) await invoke("create_directory", { server, path: joinRemotePath(session.cwd, name) });
    else setFiles((current) => [{ name, path: joinRemotePath(session.cwd, name), isDir: true, size: 0, permissions: "drwxr-xr-x" }, ...current]);
    if (isTauri()) await load(session.cwd);
  };

  const remove = async () => {
    const file = files.find((item) => item.path === selected);
    if (!file || !confirm(`删除 ${file.name}？此操作不可撤销。`)) return;
    if (isTauri()) await invoke("delete_remote_path", { server, path: file.path, isDir: file.isDir });
    else setFiles((current) => current.filter((item) => item.path !== file.path));
    setSelected(undefined);
  };

  return (
    <div className="pane file-pane">
      <div className="pane-header">
        <div className="pane-title"><Folder size={14} /><span>文件</span></div>
        <span className="header-spacer" />
        <button className="icon-button quiet" title="上传文件" onClick={() => void upload()}><ArrowUpToLine size={13} /></button>
        <button className="icon-button quiet" title="下载选中文件" disabled={!selected} onClick={() => void download()}><ArrowDownToLine size={13} /></button>
        <button className="icon-button quiet" title="新建文件夹" onClick={() => void createFolder()}><FolderPlus size={13} /></button>
        <button className="icon-button quiet danger-hover" title="删除" disabled={!selected} onClick={() => void remove()}><Trash2 size={13} /></button>
        <button className={`icon-button quiet ${loading ? "spinning" : ""}`} title="刷新" onClick={() => void load(session.cwd)}><RefreshCw size={13} /></button>
      </div>
      <div className="file-toolbar">
        <button className="icon-button quiet" title="返回上级目录" disabled={session.cwd === "/"} onClick={() => void load(parentPath(session.cwd))}><ArrowLeft size={13} /></button>
        <div className="breadcrumbs">
          <button title="根目录" onClick={() => void load("/")}><Home size={12} /></button>
          {pathParts.map((part, index) => {
            const target = `/${pathParts.slice(0, index + 1).join("/")}`;
            return <span key={target}><ChevronRight size={11} /><button onClick={() => void load(target)}>{part}</button></span>;
          })}
        </div>
        <label className="file-search"><Search size={12} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选" /></label>
      </div>
      {error ? <div className="pane-error">无法读取目录：{error}<button onClick={() => void load(session.cwd)}>重试</button></div> : (
        <div className="file-table-wrap">
          <table className="file-table">
            <thead><tr><th>名称</th><th>大小</th><th>权限</th></tr></thead>
            <tbody>
              {visibleFiles.map((file) => (
                <tr
                  key={file.path}
                  className={selected === file.path ? "selected" : ""}
                  onClick={() => { setSelected(file.path); onUpdate({ selectedFile: file.path }); }}
                  onDoubleClick={() => file.isDir && void load(file.path)}
                >
                  <td><FileGlyph file={file} /><span>{file.name}</span></td>
                  <td>{file.isDir ? "—" : formatBytes(file.size)}</td>
                  <td><code>{file.permissions}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && visibleFiles.length === 0 && <div className="table-empty">当前目录为空</div>}
        </div>
      )}
      <div className="file-footer"><span>{visibleFiles.length} 个项目</span><span>{server.host}</span></div>
    </div>
  );
}
