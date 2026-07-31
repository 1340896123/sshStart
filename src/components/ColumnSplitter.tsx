import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  pane: "previous" | "next";
  onChange: (value: number) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function ColumnSplitter({ label, value, min, max, pane, onChange }: Props) {
  const resizeCleanupRef = useRef<() => void>();

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const paneWidth = (splitter: HTMLElement) => {
    const target = pane === "previous" ? splitter.previousElementSibling : splitter.nextElementSibling;
    return target instanceof HTMLElement ? target.getBoundingClientRect().width : value;
  };

  const commit = (nextValue: number) => onChange(clamp(nextValue, min, max));

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const splitter = event.currentTarget;
    const startX = event.clientX;
    const startWidth = paneWidth(splitter);
    const direction = pane === "previous" ? 1 : -1;
    event.preventDefault();
    splitter.focus();
    splitter.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      commit(startWidth + (moveEvent.clientX - startX) * direction);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("is-resizing-columns");
      resizeCleanupRef.current = undefined;
    };

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = stop;
    document.body.classList.add("is-resizing-columns");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentWidth = paneWidth(event.currentTarget);
    const direction = pane === "previous" ? 1 : -1;
    const nextWidth = event.key === "Home"
      ? min
      : event.key === "End"
        ? max
        : currentWidth + (event.key === "ArrowRight" ? 12 : -12) * direction;
    commit(nextWidth);
  };

  return (
    <div
      className="column-splitter"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={beginResize}
      onKeyDown={resizeWithKeyboard}
    />
  );
}
