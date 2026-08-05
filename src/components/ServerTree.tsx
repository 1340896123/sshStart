import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { connectionLabel } from "../lib";
import {
  GROUP_SEPARATOR,
  groupAncestors,
  groupBreadcrumb,
  groupLeaf,
  groupParent,
  isGroupWithin,
  joinGroupPath,
  normalizeGroupPath,
  removeGroupLevel,
  replaceGroupPrefix,
} from "../serverGroups";
import type { ServerProfile, SessionState } from "../types";

const UNGROUPED_KEY = "__ungrouped__";

interface Props {
  servers: ServerProfile[];
  savedGroups: string[];
  initialCollapsedGroups: string[];
  sessions: SessionState[];
  search: string;
  selectedServerId?: string;
  activeServerId?: string;
  onSearchChange: (value: string) => void;
  onSelect: (server: ServerProfile) => void;
  onOpen: (server: ServerProfile) => void;
  onNewSession: (server: ServerProfile) => void;
  onAddServer: (group?: string) => void;
  onCopyServer: (server: ServerProfile) => void;
  onEditServer: (server: ServerProfile) => void;
  onDeleteServer: (server: ServerProfile) => void;
  onMoveServer: (server: ServerProfile, group: string) => void;
  onCreateGroup: (group: string) => void;
  onRenameGroup: (currentGroup: string, nextGroup: string) => void;
  onDeleteGroup: (group: string) => void;
  onCollapsedGroupsChange: (groups: string[]) => void;
}

interface GroupNode {
  path: string;
  name: string;
  items: ServerProfile[];
  children: GroupNode[];
  totalServers: number;
}

type ContextMenuTarget =
  | { kind: "server"; server: ServerProfile }
  | { kind: "group"; group: string };

type ContextMenu = ContextMenuTarget & { x: number; y: number };

type GroupEditor =
  | { mode: "create"; parent: string; value: string }
  | { mode: "rename"; group: string; value: string };

const groupKey = (group: string) => group || UNGROUPED_KEY;
const groupLabel = (group: string) => group ? groupLeaf(group) : "未分组";
const treeDepthStyle = (level: number, editor = false) => ({
  "--tree-indent": `${3 + (level - 1) * 14 + (editor ? 19 : 0)}px`,
} as CSSProperties);

const countServers = (node: GroupNode): number => {
  node.totalServers = node.items.length + node.children.reduce((total, child) => total + countServers(child), 0);
  return node.totalServers;
};

const flattenGroups = (nodes: GroupNode[]): GroupNode[] =>
  nodes.flatMap((node) => [node, ...flattenGroups(node.children)]);

const buildGroupTree = (savedGroups: string[], servers: ServerProfile[]) => {
  const orderedPaths: string[] = [];
  const addPath = (path: string) => {
    groupAncestors(path).forEach((ancestor) => {
      if (!orderedPaths.includes(ancestor)) orderedPaths.push(ancestor);
    });
  };

  savedGroups.forEach(addPath);
  servers.forEach((server) => addPath(server.group));

  const nodes = new Map(orderedPaths.map((path) => [path, {
    path,
    name: groupLeaf(path),
    items: [] as ServerProfile[],
    children: [] as GroupNode[],
    totalServers: 0,
  }]));

  const ungrouped: ServerProfile[] = [];
  servers.forEach((server) => {
    const path = normalizeGroupPath(server.group);
    if (!path) ungrouped.push(server);
    else nodes.get(path)?.items.push(server);
  });

  const roots: GroupNode[] = [];
  orderedPaths.forEach((path) => {
    const node = nodes.get(path);
    if (!node) return;
    const parent = groupParent(path);
    if (parent) nodes.get(parent)?.children.push(node);
    else roots.push(node);
  });

  if (ungrouped.length > 0) {
    roots.push({ path: "", name: "未分组", items: ungrouped, children: [], totalServers: ungrouped.length });
  }
  roots.forEach(countServers);
  return roots;
};

const filterGroupTree = (nodes: GroupNode[], query: string, includeAll = false): GroupNode[] => {
  if (!query) return nodes;

  return nodes.flatMap((node) => {
    const groupMatches = includeAll
      || groupBreadcrumb(node.path).toLocaleLowerCase().includes(query)
      || groupLabel(node.path).toLocaleLowerCase().includes(query);
    const children = filterGroupTree(node.children, query, groupMatches);
    const items = groupMatches
      ? node.items
      : node.items.filter((server) =>
        `${server.name} ${server.host} ${server.username} ${server.group}`.toLocaleLowerCase().includes(query),
      );
    if (!groupMatches && children.length === 0 && items.length === 0) return [];

    const filtered = { ...node, children, items, totalServers: 0 };
    countServers(filtered);
    return [filtered];
  });
};

export function ServerTree({
  servers,
  savedGroups,
  initialCollapsedGroups,
  sessions,
  search,
  selectedServerId,
  activeServerId,
  onSearchChange,
  onSelect,
  onOpen,
  onNewSession,
  onAddServer,
  onCopyServer,
  onEditServer,
  onDeleteServer,
  onMoveServer,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onCollapsedGroupsChange,
}: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(initialCollapsedGroups));
  const [contextMenu, setContextMenu] = useState<ContextMenu>();
  const [groupEditor, setGroupEditor] = useState<GroupEditor>();
  const [groupError, setGroupError] = useState("");
  const [focusedKey, setFocusedKey] = useState<string>();
  const [draggedServerId, setDraggedServerId] = useState<string>();
  const [dropGroup, setDropGroup] = useState<string>();

  const allGroupTree = useMemo(() => buildGroupTree(savedGroups, servers), [savedGroups, servers]);
  const allGroups = useMemo(() => flattenGroups(allGroupTree), [allGroupTree]);
  const query = search.trim().toLocaleLowerCase();
  const groupTree = useMemo(() => filterGroupTree(allGroupTree, query), [allGroupTree, query]);
  const visibleGroups = useMemo(() => flattenGroups(groupTree), [groupTree]);

  const isExpanded = (path: string) => Boolean(query) || !collapsedGroups.has(groupKey(path));
  const visibleKeys = useMemo(() => {
    const keys: string[] = [];
    const visit = (node: GroupNode) => {
      keys.push(`group:${groupKey(node.path)}`);
      if (!query && collapsedGroups.has(groupKey(node.path))) return;
      node.children.forEach(visit);
      node.items.forEach((server) => keys.push(`server:${server.id}`));
    };
    groupTree.forEach(visit);
    return keys;
  }, [collapsedGroups, groupTree, query]);

  const visibleServerCount = groupTree.reduce((total, node) => total + node.totalServers, 0);
  const allGroupsCollapsed = visibleGroups.length > 0
    && visibleGroups.every((node) => collapsedGroups.has(groupKey(node.path)));

  useEffect(() => {
    setCollapsedGroups(new Set(initialCollapsedGroups));
  }, [initialCollapsedGroups]);

  useEffect(() => {
    if (!focusedKey || !visibleKeys.includes(focusedKey)) setFocusedKey(visibleKeys[0]);
  }, [focusedKey, visibleKeys]);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(undefined);
    };
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape") {
        setContextMenu(undefined);
        setGroupEditor(undefined);
        setGroupError("");
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", handleShortcut, true);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", handleShortcut, true);
    };
  }, []);

  const toggleGroup = (group: string, forceExpanded?: boolean) => {
    const key = groupKey(group);
    const next = new Set(collapsedGroups);
    const shouldExpand = forceExpanded ?? next.has(key);
    if (shouldExpand) next.delete(key);
    else next.add(key);
    setCollapsedGroups(next);
    onCollapsedGroupsChange([...next]);
  };

  const focusItem = (key: string) => {
    setFocusedKey(key);
    requestAnimationFrame(() => itemRefs.current.get(key)?.focus());
  };

  const moveTreeFocus = (currentKey: string, offset: number) => {
    const currentIndex = visibleKeys.indexOf(currentKey);
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), visibleKeys.length - 1);
    const nextKey = visibleKeys[nextIndex];
    if (nextKey) focusItem(nextKey);
  };

  const openContextMenu = (menu: ContextMenuTarget, x: number, y: number) => {
    const menuWidth = menu.kind === "server" ? 420 : 220;
    setContextMenu({
      ...menu,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth)),
      y: Math.max(40, Math.min(y, window.innerHeight - 350)),
    } as ContextMenu);
  };

  const openMenuFromButton = (
    event: React.MouseEvent<HTMLButtonElement>,
    menu: ContextMenuTarget,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu(menu, rect.right - 6, rect.bottom - 2);
  };

  const startCreateGroup = (parent = "") => {
    onSearchChange("");
    setGroupEditor({ mode: "create", parent, value: "" });
    setGroupError("");
    if (parent) toggleGroup(parent, true);
  };

  const startRenameGroup = (group: string) => {
    onSearchChange("");
    setGroupEditor({ mode: "rename", group, value: groupLeaf(group) });
    setGroupError("");
  };

  const commitGroupEdit = () => {
    if (!groupEditor) return;
    const name = groupEditor.value.trim();
    if (!name) {
      setGroupError("分组名称不能为空");
      return;
    }
    if (name.includes(GROUP_SEPARATOR)) {
      setGroupError("名称中不能包含 /");
      return;
    }

    const currentGroup = groupEditor.mode === "rename" ? groupEditor.group : "";
    const parent = groupEditor.mode === "create" ? groupEditor.parent : groupParent(groupEditor.group);
    const target = joinGroupPath(parent, name);
    const duplicate = allGroups.some((node) =>
      node.path !== currentGroup && node.path.toLocaleLowerCase() === target.toLocaleLowerCase(),
    );
    if (duplicate) {
      setGroupError("同级分组已存在");
      return;
    }

    if (groupEditor.mode === "create") onCreateGroup(target);
    else if (target !== currentGroup) {
      onRenameGroup(currentGroup, target);
      setCollapsedGroups((current) => new Set(
        [...current].map((path) => replaceGroupPrefix(path, currentGroup, target)),
      ));
    }
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(groupKey(parent));
      next.delete(groupKey(target));
      return next;
    });
    setGroupEditor(undefined);
    setGroupError("");
  };

  const confirmDeleteServer = (server: ServerProfile) => {
    setContextMenu(undefined);
    if (confirm(`删除“${server.name}”及其打开的会话？`)) onDeleteServer(server);
  };

  const confirmDeleteGroup = (group: string) => {
    setContextMenu(undefined);
    const node = allGroups.find((item) => item.path === group);
    const count = node?.totalServers ?? 0;
    const hasChildren = Boolean(node?.children.length);
    const destination = groupParent(group) ? `“${groupBreadcrumb(groupParent(group))}”` : "顶层";
    const details = count > 0 || hasChildren
      ? `其中的服务器和子分组将上移一级到${destination}。`
      : "";
    if (!confirm(`删除分组“${groupBreadcrumb(group)}”？${details}`)) return;

    onDeleteGroup(group);
    setCollapsedGroups((current) => new Set(
      [...current]
        .filter((path) => !isGroupWithin(path, group) || path !== group)
        .map((path) => removeGroupLevel(path, group)),
    ));
  };

  const renderGroupEditor = (level: number) => {
    if (!groupEditor) return null;
    const label = groupEditor.mode === "create" ? "新分组名称" : "分组名称";
    return (
      <form
        className="group-editor-row"
        style={treeDepthStyle(level, true)}
        onSubmit={(event) => { event.preventDefault(); commitGroupEdit(); }}
      >
        <Folder size={14} />
        <input
          autoFocus
          value={groupEditor.value}
          onChange={(event) => {
            setGroupEditor({ ...groupEditor, value: event.target.value });
            setGroupError("");
          }}
          onBlur={() => !groupEditor.value.trim() && setGroupEditor(undefined)}
          aria-label={label}
          placeholder={label}
        />
        {groupError && <span className="group-editor-error">{groupError}</span>}
      </form>
    );
  };

  const renderServer = (server: ServerProfile, parentGroup: string, level: number) => {
    const key = `server:${server.id}`;
    const serverSessions = sessions.filter((session) => session.serverId === server.id);
    const isSelected = selectedServerId === server.id;
    const isActive = activeServerId === server.id;
    const isConnected = serverSessions.some((session) => session.connected);

    return (
      <div
        ref={(node) => { if (node) itemRefs.current.set(key, node); else itemRefs.current.delete(key); }}
        className={`server-tree-row ${isSelected ? "selected" : ""} ${isActive ? "active-session" : ""} ${draggedServerId === server.id ? "dragging" : ""}`}
        key={server.id}
        role="treeitem"
        aria-level={level}
        aria-selected={isSelected}
        tabIndex={focusedKey === key ? 0 : -1}
        title={connectionLabel(server)}
        style={treeDepthStyle(level)}
        draggable
        onFocus={() => setFocusedKey(key)}
        onClick={() => onSelect(server)}
        onDoubleClick={() => onOpen(server)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveTreeFocus(key, 1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveTreeFocus(key, -1); }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            focusItem(`group:${groupKey(parentGroup)}`);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) onNewSession(server);
            else onOpen(server);
          }
          if (event.key === " ") { event.preventDefault(); onSelect(server); }
          if (event.key === "F2") { event.preventDefault(); onEditServer(server); }
          if (event.key === "Delete") { event.preventDefault(); confirmDeleteServer(server); }
          if (event.key === "F10" && event.shiftKey) {
            event.preventDefault();
            onSelect(server);
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenu({ kind: "server", server }, rect.left + 42, rect.bottom);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(server);
          openContextMenu({ kind: "server", server }, event.clientX, event.clientY);
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", server.id);
          setDraggedServerId(server.id);
        }}
        onDragEnd={() => { setDraggedServerId(undefined); setDropGroup(undefined); }}
      >
        <span className="tree-branch-line" />
        <span className={`tree-server-icon ${isConnected ? "connected" : ""}`}><Server size={14} /></span>
        <span className="server-copy">
          <strong>{server.name}</strong>
          <span>{connectionLabel(server)}</span>
        </span>
        {serverSessions.length > 0 && <span className="session-count">{serverSessions.length}</span>}
        <button
          className="tree-row-menu"
          title={`${server.name} 操作`}
          aria-label={`${server.name} 操作`}
          onClick={(event) => openMenuFromButton(event, { kind: "server", server })}
        ><MoreHorizontal size={15} /></button>
      </div>
    );
  };

  const renderGroup = (node: GroupNode, level: number): React.ReactNode => {
    const key = `group:${groupKey(node.path)}`;
    const expanded = isExpanded(node.path);
    const isDropTarget = dropGroup === groupKey(node.path);
    const hasContents = node.children.length > 0 || node.items.length > 0
      || (groupEditor?.mode === "create" && groupEditor.parent === node.path);
    const parentKey = groupParent(node.path);

    return (
      <div className="server-tree-branch" key={key}>
        {groupEditor?.mode === "rename" && groupEditor.group === node.path ? renderGroupEditor(level) : (
          <div
            ref={(element) => { if (element) itemRefs.current.set(key, element); else itemRefs.current.delete(key); }}
            className={`server-tree-group-row ${isDropTarget ? "drop-target" : ""}`}
            role="treeitem"
            aria-expanded={hasContents ? expanded : undefined}
            aria-level={level}
            tabIndex={focusedKey === key ? 0 : -1}
            style={treeDepthStyle(level)}
            title={node.path ? groupBreadcrumb(node.path) : "未分组"}
            onFocus={() => setFocusedKey(key)}
            onClick={() => toggleGroup(node.path)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); moveTreeFocus(key, 1); }
              if (event.key === "ArrowUp") { event.preventDefault(); moveTreeFocus(key, -1); }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                if (!expanded) toggleGroup(node.path, true);
                else moveTreeFocus(key, 1);
              }
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                if (expanded && hasContents) toggleGroup(node.path, false);
                else if (node.path && parentKey) focusItem(`group:${groupKey(parentKey)}`);
              }
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleGroup(node.path); }
              if (event.key === "F2" && node.path) { event.preventDefault(); startRenameGroup(node.path); }
              if (event.key === "Delete" && node.path) { event.preventDefault(); confirmDeleteGroup(node.path); }
              if (event.key === "F10" && event.shiftKey) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openContextMenu({ kind: "group", group: node.path }, rect.left + 24, rect.bottom);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              openContextMenu({ kind: "group", group: node.path }, event.clientX, event.clientY);
            }}
            onDragOver={(event) => { event.preventDefault(); setDropGroup(groupKey(node.path)); }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropGroup(undefined);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const server = servers.find((item) => item.id === draggedServerId);
              if (server && normalizeGroupPath(server.group) !== node.path) onMoveServer(server, node.path);
              setDraggedServerId(undefined);
              setDropGroup(undefined);
            }}
          >
            <span className="tree-chevron">
              {hasContents ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
            </span>
            <span className="tree-folder">{expanded && hasContents ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
            <span className="tree-label">{node.name}</span>
            <small>{node.totalServers}</small>
            <button
              className="tree-row-menu"
              title={`${node.name} 操作`}
              aria-label={`${node.name} 操作`}
              onClick={(event) => openMenuFromButton(event, { kind: "group", group: node.path })}
            ><MoreHorizontal size={15} /></button>
          </div>
        )}

        {expanded && hasContents && (
          <div role="group">
            {groupEditor?.mode === "create" && groupEditor.parent === node.path && renderGroupEditor(level + 1)}
            {node.children.map((child) => renderGroup(child, level + 1))}
            {node.items.map((server) => renderServer(server, node.path, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">工作区</span>
          <h1>服务器</h1>
        </div>
        <div className="sidebar-heading-actions">
          <button className="icon-button" aria-label="新建分组" title="新建分组" onClick={() => startCreateGroup()}>
            <FolderPlus size={15} />
          </button>
          <button className="icon-button" aria-label="添加服务器" title="添加服务器" onClick={() => onAddServer()}>
            <Plus size={15} />
          </button>
        </div>
      </div>

      <label className="search-field">
        <Search size={14} />
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索服务器或分组"
          aria-label="搜索服务器或分组"
        />
        <kbd>Ctrl K</kbd>
      </label>

      <div className="tree-toolbar">
        <span>{visibleServerCount} 台服务器 · {visibleGroups.length} 个分组</span>
        <button
          className="tree-tool-button"
          title={allGroupsCollapsed ? "全部展开" : "全部折叠"}
          aria-label={allGroupsCollapsed ? "全部展开" : "全部折叠"}
          onClick={() => setCollapsedGroups(allGroupsCollapsed
            ? new Set()
            : new Set(visibleGroups.map((node) => groupKey(node.path))))}
        ><ChevronsUp className={allGroupsCollapsed ? "flipped" : ""} size={14} /></button>
      </div>

      <div className="server-tree" role="tree" aria-label="服务器连接">
        {groupEditor?.mode === "create" && !groupEditor.parent && renderGroupEditor(1)}
        {groupTree.map((node) => renderGroup(node, 1))}

        {groupTree.length === 0 && groupEditor?.mode !== "create" && (
          <div className="sidebar-empty">
            <Server size={20} />
            <strong>{search ? "没有匹配的服务器" : "还没有服务器"}</strong>
            <span>{search ? "换个关键词再试试" : "添加连接或先创建一个分组"}</span>
          </div>
        )}
      </div>

      <button className="add-server-button" onClick={() => onAddServer()}>
        <Plus size={14} /> 添加服务器
      </button>

      {contextMenu && (
        <div
          ref={menuRef}
          className="tree-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === "server" ? (
            <>
              <div className="context-menu-heading">
                <Server size={14} />
                <span>{contextMenu.server.name}</span>
              </div>
              <button role="menuitem" onClick={() => { onOpen(contextMenu.server); setContextMenu(undefined); }}>
                <Play size={14} /><span>连接</span><kbd>Enter</kbd>
              </button>
              <button role="menuitem" onClick={() => { onNewSession(contextMenu.server); setContextMenu(undefined); }}>
                <Plus size={14} /><span>新建会话</span><kbd>Ctrl Enter</kbd>
              </button>
              <button role="menuitem" onClick={() => { onEditServer(contextMenu.server); setContextMenu(undefined); }}>
                <Pencil size={14} /><span>编辑</span><kbd>F2</kbd>
              </button>
              <button role="menuitem" onClick={() => { onCopyServer(contextMenu.server); setContextMenu(undefined); }}>
                <Copy size={14} /><span>复制</span>
              </button>
              <div className="context-submenu">
                <button role="menuitem" aria-haspopup="menu">
                  <Folder size={14} /><span>移动到分组</span><ChevronRight size={13} />
                </button>
                <div className="context-submenu-panel" role="menu">
                  {[...allGroups.filter((node) => node.path).map((node) => node.path), ""].map((group) => {
                    const currentGroup = normalizeGroupPath(contextMenu.server.group);
                    return (
                      <button
                        role="menuitem"
                        key={groupKey(group)}
                        disabled={currentGroup === group}
                        title={group ? groupBreadcrumb(group) : "未分组"}
                        onClick={() => { onMoveServer(contextMenu.server, group); setContextMenu(undefined); }}
                      >
                        {currentGroup === group ? <Check size={14} /> : <Folder size={14} />}
                        <span>{group ? groupBreadcrumb(group) : "未分组"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="context-menu-separator" />
              <button className="danger" role="menuitem" onClick={() => confirmDeleteServer(contextMenu.server)}>
                <Trash2 size={14} /><span>删除</span><kbd>Delete</kbd>
              </button>
            </>
          ) : (
            <>
              <div className="context-menu-heading" title={contextMenu.group ? groupBreadcrumb(contextMenu.group) : "未分组"}>
                <Folder size={14} />
                <span>{contextMenu.group ? groupBreadcrumb(contextMenu.group) : "未分组"}</span>
              </div>
              {contextMenu.group && (
                <button role="menuitem" onClick={() => { startCreateGroup(contextMenu.group); setContextMenu(undefined); }}>
                  <FolderPlus size={14} /><span>新建子分组</span>
                </button>
              )}
              <button role="menuitem" onClick={() => { onAddServer(contextMenu.group); setContextMenu(undefined); }}>
                <Plus size={14} /><span>添加服务器</span>
              </button>
              {contextMenu.group && (
                <button role="menuitem" onClick={() => { startRenameGroup(contextMenu.group); setContextMenu(undefined); }}>
                  <Pencil size={14} /><span>重命名</span><kbd>F2</kbd>
                </button>
              )}
              <button role="menuitem" onClick={() => { toggleGroup(contextMenu.group); setContextMenu(undefined); }}>
                {collapsedGroups.has(groupKey(contextMenu.group)) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{collapsedGroups.has(groupKey(contextMenu.group)) ? "展开" : "折叠"}</span>
              </button>
              {contextMenu.group && (
                <>
                  <div className="context-menu-separator" />
                  <button className="danger" role="menuitem" onClick={() => confirmDeleteGroup(contextMenu.group)}>
                    <Trash2 size={14} /><span>删除分组</span><kbd>Delete</kbd>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
