import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftToLine, ArrowRightToLine, Layers, Plus, SquareTerminal, X } from "lucide-react";
import type { ServerProfile, SessionState } from "../types";

interface Props {
  sessions: SessionState[];
  servers: ServerProfile[];
  activeSessionId?: string;
  onActivate: (id: string) => void;
  onNewSession: (server: ServerProfile) => void;
  onClose: (ids: string[]) => void;
}

export function SessionTabs({ sessions, servers, activeSessionId, onActivate, onNewSession, onClose }: Props) {
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number }>();
  const tabsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const targetIndex = sessions.findIndex((session) => session.id === menu?.sessionId);
  const target = sessions[targetIndex];
  const targetServer = servers.find((server) => server.id === target?.serverId);

  const closeMenu = (restoreFocus = false) => {
    setMenu(undefined);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        const button = triggerRef.current?.isConnected
          ? triggerRef.current
          : tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
        (button ?? tabsRef.current?.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
      });
    }
  };

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismissOutside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const dismiss = () => setMenu(undefined);
    window.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", dismissOutside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("scroll", dismissOutside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  useEffect(() => {
    if (menu && targetIndex < 0) setMenu(undefined);
  }, [menu, targetIndex]);

  const openMenu = (sessionId: string, x: number, y: number, trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger;
    setMenu({ sessionId, x, y });
  };

  const closeTargets = (items: SessionState[]) => {
    closeMenu(true);
    onClose(items.map((session) => session.id));
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openMenu(sessions[index].id, bounds.left, bounds.bottom, event.currentTarget);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      onClose([sessions[index].id]);
      requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
      return;
    }
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % sessions.length
      : event.key === "ArrowLeft" ? (index - 1 + sessions.length) % sessions.length
      : event.key === "Home" ? 0 : event.key === "End" ? sessions.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    onActivate(sessions[nextIndex].id);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <div ref={tabsRef} className="session-tabs" role="tablist" aria-label="SSH 会话">
        {sessions.map((session, index) => {
          const server = servers.find((item) => item.id === session.serverId);
          const selected = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              className={`session-tab ${selected ? "active" : ""}`}
              role="presentation"
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(session.id, event.clientX, event.clientY,
                  event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]'));
              }}
            >
              <button
                className="session-tab-select"
                role="tab"
                id={`session-tab-${session.id}`}
                aria-controls={`workspace-session-${session.id}`}
                aria-selected={selected}
                aria-haspopup="menu"
                aria-expanded={menu?.sessionId === session.id}
                tabIndex={selected ? 0 : -1}
                title={session.title}
                onClick={() => onActivate(session.id)}
                onKeyDown={(event) => handleTabKey(event, index)}
              >
                <span aria-hidden="true" className={`connection-indicator ${session.connected ? "online" : ""}`} />
                <span>{session.title}</span>
                <small>{server?.username}</small>
              </button>
              <button className="tab-close" aria-label={`关闭会话 ${session.title}`} title="关闭会话" onClick={() => onClose([session.id])}>
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {menu && target && createPortal(
        <div
          ref={menuRef}
          className="tree-context-menu session-context-menu"
          role="menu"
          aria-label={`${target.title} 会话菜单`}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={handleMenuKey}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="context-menu-heading" title={target.title}><SquareTerminal size={14} aria-hidden="true" /><span>{target.title}</span></div>
          <button role="menuitem" disabled={!targetServer} onClick={() => { closeMenu(true); if (targetServer) onNewSession(targetServer); }}>
            <Plus size={14} aria-hidden="true" /><span>新建同服务器会话</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button role="menuitem" onClick={() => closeTargets([target])}><X size={14} aria-hidden="true" /><span>关闭当前标签页</span></button>
          <button role="menuitem" disabled={sessions.length <= 1} onClick={() => closeTargets(sessions.filter((session) => session.id !== target.id))}>
            <Layers size={14} aria-hidden="true" /><span>关闭其他标签页</span>
          </button>
          <button role="menuitem" disabled={targetIndex <= 0} onClick={() => closeTargets(sessions.slice(0, targetIndex))}>
            <ArrowLeftToLine size={14} aria-hidden="true" /><span>关闭左侧标签页</span>
          </button>
          <button role="menuitem" disabled={targetIndex === sessions.length - 1} onClick={() => closeTargets(sessions.slice(targetIndex + 1))}>
            <ArrowRightToLine size={14} aria-hidden="true" /><span>关闭右侧标签页</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button className="danger" role="menuitem" onClick={() => closeTargets(sessions)}><X size={14} aria-hidden="true" /><span>关闭全部标签页</span></button>
        </div>, document.body,
      )}
    </>
  );
}
