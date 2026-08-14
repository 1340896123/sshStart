import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpDown,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Download,
  FileArchive,
  FilePenLine,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { formatBytes, isTauri, joinRemotePath, parentPath, uid } from "../lib";
import type { RemoteFile, ServerProfile, SessionState, TransferRequest } from "../types";

interface Props {
  session: SessionState;
  server: ServerProfile;
  onUpdate: (patch: Partial<SessionState>) => void;
  onTransfer: (request: TransferRequest, operation: (transferId: string) => Promise<void>) => Promise<void>;
}

type SortKey = "name" | "size" | "modified" | "permissions";
type SortDirection = "asc" | "desc";
type ColumnWidths = Record<SortKey, number>;
type MenuState = { x: number; y: number; file?: RemoteFile };
type FileListState = {
  id: string;
  path: string;
  pathDraft: string;
  files: RemoteFile[];
  loading: boolean;
  error: string;
  filter: string;
  selected?: string;
  sort: { key: SortKey; direction: SortDirection };
  columnWidths: ColumnWidths;
};
type FileIconName = "archive" | "code" | "config" | "file" | "folder" | "image" | "json" | "markdown" | "shell" | "text";
type SystemFileIconRequest = { key: string; fileName: string; isDir: boolean };
type SystemFileIcon = { key: string; dataUrl: string };
type LocalUploadManifest = {
  files: Array<{ localPath: string; relativePath: string }>;
  directories: string[];
  skippedEntries: number;
};
type FileDropTarget = { path: string; rowPath?: string };
type VscodeSyncEvent = {
  sessionId: string;
  serverId: string;
  remotePath: string;
  localPath: string;
  status: "opening" | "watching" | "syncing" | "saved" | "closed" | "error";
  message: string;
};

const COMMON_TEXT_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cc", "cfg", "cjs", "cmake", "cmd", "conf", "cpp", "css", "csv",
  "dockerignore", "editorconfig", "env", "fish", "gitattributes", "gitignore", "go", "gql", "graphql", "h",
  "hpp", "htm", "html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua",
  "markdown", "md", "mjs", "path", "php", "properties", "ps1", "py", "rb", "rs", "sass", "scss", "service",
  "sh", "socket", "sql", "svelte", "swift", "target", "timer", "toml", "ts", "tsx", "txt", "vue", "xml",
  "yaml", "yml", "zsh",
]);
const COMMON_TEXT_NAMES = new Set([
  ".babelrc", ".bashrc", ".browserslistrc", ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore", ".npmignore",
  ".npmrc", ".prettierrc", ".profile", ".stylelintrc", ".vimrc", ".wgetrc", ".zshrc", "cmakelists.txt", "dockerfile",
  "fstab", "gemfile", "hosts", "justfile", "license", "makefile", "procfile", "rakefile", "readme",
]);

const DEMO_FILES: RemoteFile[] = [
  { name: "apps", path: "/apps", isDir: true, size: 0, permissions: "drwxr-xr-x", modified: 1785313920 },
  { name: "backups", path: "/backups", isDir: true, size: 0, permissions: "drwxr-x---", modified: 1785309600 },
  { name: "etc", path: "/etc", isDir: true, size: 0, permissions: "drwxr-xr-x", modified: 1785266400 },
  { name: "home", path: "/home", isDir: true, size: 0, permissions: "drwxr-xr-x", modified: 1785223200 },
  { name: "opt", path: "/opt", isDir: true, size: 0, permissions: "drwxr-xr-x", modified: 1785136800 },
  { name: "var", path: "/var", isDir: true, size: 0, permissions: "drwxr-xr-x", modified: 1785050400 },
  { name: "deploy.sh", path: "/deploy.sh", isDir: false, size: 2387, permissions: "-rwxr-xr-x", modified: 1785314460 },
  { name: "healthcheck.log", path: "/healthcheck.log", isDir: false, size: 19424, permissions: "-rw-r--r--", modified: 1785313980 },
  { name: "release.tar.gz", path: "/release.tar.gz", isDir: false, size: 8249230, permissions: "-rw-r--r--", modified: 1785306000 },
];

const minimumColumnWidths: ColumnWidths = { name: 180, size: 82, modified: 138, permissions: 112 };
const defaultColumnWidths: ColumnWidths = { name: 340, size: 100, modified: 168, permissions: 126 };
const systemFileIconCache = new Map<string, string>();
const DROP_UPLOAD_CONCURRENCY = 3;

function createFileListState(id: string, path: string): FileListState {
  return {
    id,
    path,
    pathDraft: path,
    files: [],
    loading: false,
    error: "",
    filter: "",
    sort: { key: "name", direction: "asc" },
    columnWidths: { ...defaultColumnWidths },
  };
}

function fileListLabel(path: string) {
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function fileExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > -1 ? name.slice(index + 1).toLowerCase() : "";
}

function isCommonTextFile(file: RemoteFile) {
  if (file.isDir) return false;
  const name = file.name.toLowerCase();
  return COMMON_TEXT_NAMES.has(name)
    || name === ".env"
    || name.startsWith(".env.")
    || COMMON_TEXT_EXTENSIONS.has(fileExtension(name));
}

function fileIconName(file: RemoteFile): FileIconName {
  if (file.isDir) return "folder";
  const extension = fileExtension(file.name);
  if (/^(7z|bz2|gz|rar|tar|tgz|xz|zip)$/.test(extension)) return "archive";
  if (/^(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/.test(extension)) return "image";
  if (/^(md|markdown)$/.test(extension)) return "markdown";
  if (/^(json|jsonc)$/.test(extension)) return "json";
  if (/^(cfg|conf|env|ini|properties|toml|ya?ml)$/.test(extension) || file.name.startsWith(".")) return "config";
  if (/^(bash|bat|cmd|fish|ps1|sh|zsh)$/.test(extension)) return "shell";
  if (/^(astro|c|cc|cjs|cmake|cpp|css|go|graphql|gql|h|hpp|html?|java|js|jsx|kt|kts|less|lua|mjs|php|py|rb|rs|sass|scss|sql|svelte|swift|ts|tsx|vue|xml)$/.test(extension)) return "code";
  if (isCommonTextFile(file)) return "text";
  return "file";
}

function fileIconKey(file: RemoteFile) {
  if (file.isDir) return "folder";
  const name = file.name.toLowerCase();
  if (name.startsWith(".")) return `name:${name}`;
  const extension = fileExtension(name);
  return extension ? `extension:.${extension}` : `name:${name}`;
}

function FileGlyph({ file, systemIconUrl }: { file: RemoteFile; systemIconUrl?: string }) {
  const icon = fileIconName(file);
  const fallback = `/file-icons/${icon}.svg`;
  return (
    <img
      className="local-file-icon"
      src={systemIconUrl ?? fallback}
      alt=""
      aria-hidden="true"
      onError={({ currentTarget }) => {
        currentTarget.onerror = null;
        currentTarget.src = fallback;
      }}
    />
  );
}

function modifiedLabel(timestamp?: number) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

function SortGlyph({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) return <ArrowUpDown size={10} />;
  return direction === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />;
}

export function FilePane({ session, server, onUpdate, onTransfer }: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const initialListIdRef = useRef(uid("file-list"));
  const [fileLists, setFileLists] = useState<FileListState[]>(() => [
    createFileListState(initialListIdRef.current, session.cwd),
  ]);
  const [activeListId, setActiveListId] = useState(initialListIdRef.current);
  const activeListIdRef = useRef(activeListId);
  const [menu, setMenu] = useState<MenuState>();
  const [editorStatus, setEditorStatus] = useState<VscodeSyncEvent>();
  const [systemFileIcons, setSystemFileIcons] = useState<Record<string, string>>({});
  const [dropTarget, setDropTarget] = useState<FileDropTarget>();
  const [dropUploadStatus, setDropUploadStatus] = useState<string>();
  const uploadDroppedPathsRef = useRef<(localPaths: string[], target: FileDropTarget) => Promise<void>>(async () => undefined);
  activeListIdRef.current = activeListId;

  const activeList = fileLists.find((list) => list.id === activeListId) ?? fileLists[0]!;
  const activeListRef = useRef(activeList);
  activeListRef.current = activeList;
  const { files, loading, error, filter, selected, pathDraft, sort, columnWidths } = activeList;

  const patchFileList = useCallback((
    listId: string,
    patch: Partial<FileListState> | ((current: FileListState) => Partial<FileListState>),
  ) => {
    setFileLists((current) => current.map((list) => {
      if (list.id !== listId) return list;
      return { ...list, ...(typeof patch === "function" ? patch(list) : patch) };
    }));
  }, []);

  const load = useCallback(async (path: string, listId = activeListIdRef.current) => {
    const normalizedPath = path.trim() === "" ? "/" : path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
    patchFileList(listId, { loading: true, error: "" });
    try {
      const next = isTauri()
        ? await invoke<RemoteFile[]>("list_directory", { server, path: normalizedPath })
        : DEMO_FILES.map((file) => ({ ...file, path: joinRemotePath(normalizedPath, file.name) }));
      patchFileList(listId, {
        files: next,
        path: normalizedPath,
        pathDraft: normalizedPath,
        selected: undefined,
      });
      if (activeListIdRef.current === listId) {
        onUpdate({ cwd: normalizedPath, selectedFile: undefined });
      }
    } catch (reason) {
      patchFileList(listId, { error: String(reason) });
    } finally {
      patchFileList(listId, { loading: false });
    }
  }, [onUpdate, patchFileList, server]);

  useEffect(() => {
    const initialList = createFileListState(uid("file-list"), session.cwd);
    activeListIdRef.current = initialList.id;
    setFileLists([initialList]);
    setActiveListId(initialList.id);
    setMenu(undefined);
    void load(session.cwd, initialList.id);
    // Navigation calls load directly after the initial session load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    if (!isTauri() || files.length === 0) return;
    const requests = new Map<string, SystemFileIconRequest>();
    const cached: Record<string, string> = {};
    for (const file of files) {
      const key = fileIconKey(file);
      const dataUrl = systemFileIconCache.get(key);
      if (dataUrl) cached[key] = dataUrl;
      else if (!requests.has(key)) requests.set(key, { key, fileName: file.name, isDir: file.isDir });
    }
    if (Object.keys(cached).length > 0) {
      setSystemFileIcons((current) => ({ ...current, ...cached }));
    }
    if (requests.size === 0) return;

    let disposed = false;
    void invoke<SystemFileIcon[]>("get_system_file_icons", { requests: [...requests.values()] })
      .then((icons) => {
        if (disposed) return;
        const resolved: Record<string, string> = {};
        for (const icon of icons) {
          systemFileIconCache.set(icon.key, icon.dataUrl);
          resolved[icon.key] = icon.dataUrl;
        }
        setSystemFileIcons((current) => ({ ...current, ...resolved }));
      })
      .catch(() => {
        // Bundled file icons remain visible when the native Shell lookup is unavailable.
      });
    return () => {
      disposed = true;
    };
  }, [files]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  useEffect(() => {
    setEditorStatus(undefined);
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;
    void listen<VscodeSyncEvent>("vscode-file-sync", ({ payload }) => {
      if (payload.serverId === server.id && payload.sessionId === session.id) setEditorStatus(payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [server.id, session.id]);

  const visibleFiles = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return files
      .filter((file) => file.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((left, right) => {
        if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
        let result = 0;
        if (sort.key === "name") result = left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
        if (sort.key === "size") result = left.size - right.size;
        if (sort.key === "modified") result = (left.modified ?? 0) - (right.modified ?? 0);
        if (sort.key === "permissions") result = left.permissions.localeCompare(right.permissions);
        return result * direction;
      });
  }, [files, filter, sort]);

  const selectFile = (file: RemoteFile) => {
    patchFileList(activeList.id, { selected: file.path });
    onUpdate({ selectedFile: file.path });
  };

  const upload = async () => {
    if (!isTauri()) return;
    const listId = activeList.id;
    const currentPath = activeList.path;
    const picked = await open({ multiple: true, directory: false });
    if (!picked) return;
    const localPaths = Array.isArray(picked) ? picked : [picked];
    const results = await Promise.allSettled(localPaths.map((localPath) => {
      const name = localPath.split(/[\\/]/).pop() ?? "upload";
      const remotePath = joinRemotePath(currentPath, name);
      return onTransfer(
        { direction: "upload", fileName: name, sourcePath: localPath, destinationPath: remotePath },
        (transferId) => invoke("start_upload_file", { server, localPath, remotePath, transferId }),
      );
    }));
    if (results.some((result) => result.status === "rejected")) {
      patchFileList(listId, { error: "部分文件上传失败，请在传输列表中查看详情。" });
    }
    await load(currentPath, listId);
  };

  const uploadDroppedPaths = useCallback(async (localPaths: string[], target: FileDropTarget) => {
    const listId = activeListRef.current.id;
    const currentPath = activeListRef.current.path;
    patchFileList(listId, { error: "" });
    setDropUploadStatus(`正在读取拖入内容…`);
    try {
      const manifest = await invoke<LocalUploadManifest>("collect_local_upload_manifest", { paths: localPaths });
      const remoteDirectories = manifest.directories.map((path) => joinRemotePath(target.path, path));
      if (remoteDirectories.length > 0) {
        setDropUploadStatus(`正在创建 ${remoteDirectories.length} 个远程文件夹…`);
        await invoke("create_directories", { server, paths: remoteDirectories });
      }

      let nextFileIndex = 0;
      let failedUploads = 0;
      const uploadNext = async () => {
        while (nextFileIndex < manifest.files.length) {
          const file = manifest.files[nextFileIndex];
          nextFileIndex += 1;
          const remotePath = joinRemotePath(target.path, file.relativePath);
          try {
            await onTransfer(
              {
                direction: "upload",
                fileName: file.relativePath,
                sourcePath: file.localPath,
                destinationPath: remotePath,
              },
              (transferId) => invoke("start_upload_file", {
                server,
                localPath: file.localPath,
                remotePath,
                transferId,
              }),
            );
          } catch {
            failedUploads += 1;
          }
        }
      };
      const workers = Array.from(
        { length: Math.min(DROP_UPLOAD_CONCURRENCY, manifest.files.length) },
        () => uploadNext(),
      );
      await Promise.all(workers);
      await load(currentPath, listId);

      if (failedUploads > 0) {
        patchFileList(listId, { error: `${failedUploads} 个文件上传失败，请在传输列表中查看详情。` });
        setDropUploadStatus(undefined);
        return;
      }
      const skippedCopy = manifest.skippedEntries > 0 ? `，已跳过 ${manifest.skippedEntries} 个链接或重复项` : "";
      setDropUploadStatus(`已上传 ${manifest.files.length} 个文件到 ${target.path}${skippedCopy}`);
      window.setTimeout(() => setDropUploadStatus(undefined), 2600);
    } catch (reason) {
      setDropUploadStatus(undefined);
      patchFileList(listId, { error: String(reason) });
    }
  }, [load, onTransfer, patchFileList, server]);
  uploadDroppedPathsRef.current = uploadDroppedPaths;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlistenDrop: (() => void) | undefined;
    let unlistenScale: (() => void) | undefined;
    let scaleFactor = window.devicePixelRatio || 1;
    const webview = getCurrentWebview();

    const targetAtPosition = (physicalX: number, physicalY: number): FileDropTarget | undefined => {
      const root = paneRef.current;
      if (!root) return undefined;
      const x = physicalX / scaleFactor;
      const y = physicalY / scaleFactor;
      const bounds = root.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return undefined;
      const element = document.elementFromPoint(x, y);
      if (!element || !root.contains(element)) return undefined;
      const directoryRow = element.closest<HTMLTableRowElement>("tr[data-drop-path]");
      if (directoryRow && root.contains(directoryRow)) {
        const path = directoryRow.dataset.dropPath;
        if (path) return { path, rowPath: path };
      }
      const list = activeListRef.current;
      return { path: list.path };
    };

    void webview.window.scaleFactor().then((value) => {
      scaleFactor = value;
    });
    void webview.window.onScaleChanged(({ payload }) => {
      scaleFactor = payload.scaleFactor;
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenScale = unlisten;
    });
    void webview.onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setDropTarget(undefined);
        return;
      }
      const target = targetAtPosition(payload.position.x, payload.position.y);
      if (payload.type === "enter" || payload.type === "over") {
        setDropTarget(target);
        return;
      }
      setDropTarget(undefined);
      if (target && payload.paths.length > 0) {
        void uploadDroppedPathsRef.current(payload.paths, target);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenDrop = unlisten;
    });
    return () => {
      disposed = true;
      unlistenDrop?.();
      unlistenScale?.();
    };
  }, []);

  const download = async (target?: RemoteFile) => {
    const file = target ?? files.find((item) => item.path === selected);
    if (!file || file.isDir || !isTauri()) return;
    const localPath = await save({ defaultPath: file.name });
    if (!localPath) return;
    try {
      await onTransfer(
        { direction: "download", fileName: file.name, sourcePath: file.path, destinationPath: localPath },
        (transferId) => invoke("start_download_file", { server, remotePath: file.path, localPath, transferId }),
      );
    } catch {
      patchFileList(activeList.id, { error: "下载失败，请在传输列表中查看详情。" });
    }
  };

  const openInVscode = async (file: RemoteFile) => {
    if (file.isDir || !isCommonTextFile(file)) return;
    if (!isTauri()) {
      patchFileList(activeList.id, { error: "VS Code 编辑仅在桌面应用中可用。" });
      return;
    }
    patchFileList(activeList.id, { error: "" });
    setEditorStatus({
      sessionId: session.id,
      serverId: server.id,
      remotePath: file.path,
      localPath: "",
      status: "opening",
      message: `正在用 VS Code 打开 ${file.name}`,
    });
    try {
      await invoke("open_remote_file_in_vscode", { sessionId: session.id, server, remotePath: file.path });
    } catch (reason) {
      setEditorStatus(undefined);
      patchFileList(activeList.id, { error: `无法使用 VS Code 打开 ${file.name}：${String(reason)}` });
    }
  };

  const openFile = (file: RemoteFile) => {
    if (file.isDir) return void load(file.path, activeList.id);
    if (isCommonTextFile(file)) return void openInVscode(file);
    return void download(file);
  };

  const createFolder = async () => {
    const listId = activeList.id;
    const currentPath = activeList.path;
    const name = prompt("新文件夹名称");
    if (!name?.trim()) return;
    if (name.includes("/")) {
      patchFileList(listId, { error: "文件夹名称不能包含 /。" });
      return;
    }
    const path = joinRemotePath(currentPath, name.trim());
    try {
      if (isTauri()) await invoke("create_directory", { server, path });
      else patchFileList(listId, (current) => ({
        files: [{ name: name.trim(), path, isDir: true, size: 0, permissions: "drwxr-xr-x", modified: Math.floor(Date.now() / 1000) }, ...current.files],
      }));
      if (isTauri()) await load(currentPath, listId);
    } catch (reason) {
      patchFileList(listId, { error: String(reason) });
    }
  };

  const remove = async (target?: RemoteFile) => {
    const listId = activeList.id;
    const currentPath = activeList.path;
    const file = target ?? files.find((item) => item.path === selected);
    if (!file || !confirm(`删除 ${file.name}？此操作不可撤销。`)) return;
    try {
      if (isTauri()) await invoke("delete_remote_path", { server, path: file.path, isDir: file.isDir });
      else patchFileList(listId, (current) => ({ files: current.files.filter((item) => item.path !== file.path) }));
      patchFileList(listId, { selected: undefined });
      if (activeListIdRef.current === listId) onUpdate({ selectedFile: undefined });
      if (isTauri()) await load(currentPath, listId);
    } catch (reason) {
      patchFileList(listId, { error: String(reason) });
    }
  };

  const rename = async (file: RemoteFile) => {
    const listId = activeList.id;
    const currentPath = activeList.path;
    const name = prompt("重命名", file.name)?.trim();
    if (!name || name === file.name) return;
    if (name.includes("/")) {
      patchFileList(listId, { error: "名称不能包含 /。" });
      return;
    }
    const targetPath = joinRemotePath(parentPath(file.path), name);
    try {
      if (isTauri()) await invoke("rename_remote_path", { server, sourcePath: file.path, targetPath });
      else patchFileList(listId, (current) => ({
        files: current.files.map((item) => item.path === file.path ? { ...item, name, path: targetPath } : item),
      }));
      if (isTauri()) await load(currentPath, listId);
    } catch (reason) {
      patchFileList(listId, { error: String(reason) });
    }
  };

  const compress = async (file: RemoteFile) => {
    const listId = activeList.id;
    const currentPath = activeList.path;
    const archiveName = `${file.name}.tar.gz`;
    const archivePath = joinRemotePath(parentPath(file.path), archiveName);
    if (files.some((item) => item.path === archivePath) && !confirm(`覆盖 ${archiveName}？`)) return;
    try {
      if (isTauri()) await invoke("compress_remote_path", { server, sourcePath: file.path, archivePath });
      else patchFileList(listId, (current) => ({
        files: [...current.files, { name: archiveName, path: archivePath, isDir: false, size: 0, permissions: "-rw-r--r--", modified: Math.floor(Date.now() / 1000) }],
      }));
      if (isTauri()) await load(currentPath, listId);
    } catch (reason) {
      patchFileList(listId, { error: String(reason) });
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch (reason) {
      patchFileList(activeList.id, { error: `复制路径失败：${String(reason)}` });
    }
  };

  const toggleSort = (key: SortKey) => {
    patchFileList(activeList.id, (current) => ({
      sort: {
        key,
        direction: current.sort.key === key && current.sort.direction === "asc" ? "desc" : "asc",
      },
    }));
  };

  const beginResize = (key: SortKey, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const onMove = (moveEvent: PointerEvent) => {
      patchFileList(activeList.id, (current) => ({
        columnWidths: {
          ...current.columnWidths,
          [key]: Math.max(minimumColumnWidths[key], startWidth + moveEvent.clientX - startX),
        },
      }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const openMenu = (event: React.MouseEvent, file?: RemoteFile) => {
    event.preventDefault();
    event.stopPropagation();
    if (file) selectFile(file);
    const width = 188;
    const height = file ? 282 : 126;
    setMenu({
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6)),
      file,
    });
  };

  const activateFileList = (list: FileListState) => {
    if (list.id === activeList.id) return;
    activeListIdRef.current = list.id;
    setActiveListId(list.id);
    setMenu(undefined);
    onUpdate({ cwd: list.path, selectedFile: list.selected });
  };

  const addFileList = () => {
    const next = createFileListState(uid("file-list"), activeList.path);
    activeListIdRef.current = next.id;
    setFileLists((current) => [...current, next]);
    setActiveListId(next.id);
    setMenu(undefined);
    onUpdate({ cwd: next.path, selectedFile: undefined });
    void load(next.path, next.id);
  };

  const closeFileList = (listId: string) => {
    if (fileLists.length === 1) return;
    const closingIndex = fileLists.findIndex((list) => list.id === listId);
    if (closingIndex < 0) return;
    const remaining = fileLists.filter((list) => list.id !== listId);
    setFileLists(remaining);
    if (listId !== activeList.id) return;
    const next = remaining[Math.min(closingIndex, remaining.length - 1)];
    activeListIdRef.current = next.id;
    setActiveListId(next.id);
    setMenu(undefined);
    onUpdate({ cwd: next.path, selectedFile: next.selected });
  };

  const columns: Array<{ key: SortKey; label: string }> = [
    { key: "name", label: "名称" },
    { key: "size", label: "大小" },
    { key: "modified", label: "修改时间" },
    { key: "permissions", label: "权限" },
  ];

  return (
    <div ref={paneRef} className={`pane file-pane ${dropTarget ? "drag-active" : ""}`}>
      <div className="pane-header">
        <div className="pane-title"><Folder size={14} /><span>文件</span></div>
        <label className="file-search file-header-search">
          <Search size={12} />
          <input
            aria-label="筛选文件"
            value={filter}
            onChange={(event) => patchFileList(activeList.id, { filter: event.target.value })}
            placeholder="筛选"
          />
        </label>
        <span className="header-spacer" />
        <button className="icon-button quiet" title="上传文件" onClick={() => void upload()}><ArrowUpToLine size={13} /></button>
        <button className="icon-button quiet" title="下载选中文件" disabled={!selected || files.find((file) => file.path === selected)?.isDir} onClick={() => void download()}><ArrowDownToLine size={13} /></button>
        <button className="icon-button quiet" title="新建文件夹" onClick={() => void createFolder()}><FolderPlus size={13} /></button>
        <button className="icon-button quiet danger-hover" title="删除" disabled={!selected} onClick={() => void remove()}><Trash2 size={13} /></button>
        <button className={`icon-button quiet ${loading ? "spinning" : ""}`} title="刷新" onClick={() => void load(activeList.path, activeList.id)}><RefreshCw size={13} /></button>
      </div>
      <div className="file-list-tabs" role="tablist" aria-label="文件目录列表">
        <div className="file-list-tab-scroll">
          {fileLists.map((list) => (
            <div className={`file-list-tab ${list.id === activeList.id ? "active" : ""}`} key={list.id}>
              <button
                className="file-list-tab-select"
                type="button"
                role="tab"
                aria-selected={list.id === activeList.id}
                title={list.path}
                onClick={() => activateFileList(list)}
              >
                <Folder size={11} />
                <span>{fileListLabel(list.path)}</span>
              </button>
              {fileLists.length > 1 && (
                <button
                  className="file-list-tab-close"
                  type="button"
                  title={`关闭 ${list.path}`}
                  aria-label={`关闭 ${list.path}`}
                  onClick={() => closeFileList(list.id)}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button className="file-list-add" type="button" title="新增文件列表" aria-label="新增文件列表" onClick={addFileList}>
          <Plus size={12} />
        </button>
      </div>
      <div className="file-toolbar">
        <button className="icon-button quiet" title="返回上级目录" disabled={activeList.path === "/"} onClick={() => void load(parentPath(activeList.path), activeList.id)}><ArrowLeft size={13} /></button>
        <button className="icon-button quiet" title="根目录" onClick={() => void load("/", activeList.id)}><Home size={12} /></button>
        <label className="path-field" title={activeList.path}>
          <FolderOpen size={12} />
          <input
            aria-label="远程路径"
            value={pathDraft}
            onChange={(event) => patchFileList(activeList.id, { pathDraft: event.target.value })}
            onBlur={() => patchFileList(activeList.id, { pathDraft: activeList.path })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load(pathDraft, activeList.id);
              if (event.key === "Escape") patchFileList(activeList.id, { pathDraft: activeList.path });
            }}
          />
        </label>
        <button className="icon-button quiet path-copy-button" type="button" title="复制当前路径" aria-label="复制当前路径" onClick={() => void copyPath(activeList.path)}>
          <Clipboard size={12} />
        </button>
      </div>
      {error ? <div className="pane-error">无法完成操作：{error}<button onClick={() => patchFileList(activeList.id, { error: "" })}>关闭</button></div> : (
        <div className="file-table-wrap" onContextMenu={(event) => openMenu(event)}>
          <table className="file-table">
            <colgroup>
              {columns.map((column) => <col key={column.key} style={{ width: columnWidths[column.key] }} />)}
            </colgroup>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                    <button className="column-sort" onClick={() => toggleSort(column.key)}>
                      <span>{column.label}</span>
                      <SortGlyph active={sort.key === column.key} direction={sort.direction} />
                    </button>
                    <span className="column-resizer" role="separator" aria-label={`调整${column.label}列宽`} onPointerDown={(event) => beginResize(column.key, event)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleFiles.map((file) => (
                <tr
                  key={file.path}
                  className={`${selected === file.path ? "selected" : ""} ${dropTarget?.rowPath === file.path ? "drop-target" : ""}`}
                  data-drop-path={file.isDir ? file.path : undefined}
                  onClick={() => selectFile(file)}
                  onDoubleClick={() => openFile(file)}
                  onContextMenu={(event) => openMenu(event, file)}
                >
                  <td><FileGlyph file={file} systemIconUrl={systemFileIcons[fileIconKey(file)]} /><span>{file.name}</span></td>
                  <td>{file.isDir ? "—" : formatBytes(file.size)}</td>
                  <td>{modifiedLabel(file.modified)}</td>
                  <td><code>{file.permissions}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && visibleFiles.length === 0 && <div className="table-empty">当前目录为空</div>}
        </div>
      )}
      {dropTarget && (
        <div className="file-drop-overlay" aria-hidden="true">
          <span><ArrowUpToLine size={18} /></span>
          <strong>释放以上传</strong>
          <small>目标：{dropTarget.path}</small>
        </div>
      )}
      <div className="file-footer">
        {dropUploadStatus ? (
          <span className="file-drop-status" title={dropUploadStatus} role="status" aria-live="polite">
            <ArrowUpToLine size={10} />
            <span>{dropUploadStatus}</span>
          </span>
        ) : editorStatus && (
          <span className={`file-editor-status ${editorStatus.status}`} title={editorStatus.localPath || editorStatus.remotePath}>
            <FilePenLine size={10} />
            <span>{editorStatus.message}</span>
          </span>
        )}
        <span>{visibleFiles.length} 个项目</span><span>{server.host}</span>
      </div>

      {menu && (
        <div className="file-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {menu.file ? (
            <>
              {menu.file.isDir ? (
                <button role="menuitem" onClick={() => { setMenu(undefined); void load(menu.file!.path); }}><FolderOpen size={13} />打开</button>
              ) : (
                <>
                  {isCommonTextFile(menu.file) && (
                    <button role="menuitem" onClick={() => { setMenu(undefined); void openInVscode(menu.file!); }}><FilePenLine size={13} />使用 VS Code 打开</button>
                  )}
                  <button role="menuitem" onClick={() => { setMenu(undefined); void download(menu.file); }}><Download size={13} />下载</button>
                </>
              )}
              <button role="menuitem" onClick={() => { setMenu(undefined); void rename(menu.file!); }}><Pencil size={13} />重命名</button>
              <button role="menuitem" onClick={() => { setMenu(undefined); void copyPath(menu.file!.path); }}><Clipboard size={13} />复制路径</button>
              <span className="context-separator" />
              <button role="menuitem" onClick={() => { setMenu(undefined); void compress(menu.file!); }}><FileArchive size={13} />压缩为 .tar.gz</button>
              <button role="menuitem" onClick={() => { setMenu(undefined); void createFolder(); }}><FolderPlus size={13} />新建文件夹</button>
              <span className="context-separator" />
              <button role="menuitem" className="danger" onClick={() => { setMenu(undefined); void remove(menu.file); }}><Trash2 size={13} />删除</button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => { setMenu(undefined); void upload(); }}><ArrowUpToLine size={13} />上传文件</button>
              <button role="menuitem" onClick={() => { setMenu(undefined); void createFolder(); }}><FolderPlus size={13} />新建文件夹</button>
              <button role="menuitem" onClick={() => { setMenu(undefined); void load(activeList.path, activeList.id); }}><RefreshCw size={13} />刷新</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
