import React from "react";
import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const C = {
  bg: "#090e0d",
  panel: "#142019",
  raised: "#1c3023",
  border: "#35513e",
  text: "#f2f6f3",
  muted: "#a8bcb0",
  mint: "#97edbf",
  amber: "#e3c992",
  blue: "#9dc4ef",
};
export const FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
export const MONO = '"Cascadia Code", Consolas, monospace';
export const ease = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
  easing: Easing.bezier(0.16, 1, 0.3, 1),
} as const;

export const Logo: React.FC<{ size?: number }> = ({ size = 54 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64">
    <rect width="64" height="64" rx="13" fill="#20362a" />
    <path d="M18 19h28v7H25v12h21v7H18z" fill="#f6f7f7" />
    <rect x="32" y="32" width="14" height="7" rx="1" fill="#97edbf" />
  </svg>
);

export const Icon: React.FC<{
  name: string;
  size?: number;
  color?: string;
}> = ({ name, size = 36, color = C.mint }) => {
  const paths: Record<string, React.ReactNode> = {
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z" />
        <path d="m8 14 2 2 5-5" />
      </>
    ),
    sparkles: (
      <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4ZM20 2v4m-2-2h4" />
    ),
    shield: (
      <>
        <path d="M12 3 3 7v5c0 5 9 10 9 10s9-5 9-10V7Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    cloud: (
      <>
        <path d="M6 18a5 5 0 0 1-.8-9.9A7 7 0 0 1 18.6 9 4.5 4.5 0 0 1 19 18M12 12v9m-3-3 3 3 3-3" />
      </>
    ),
    laptop: (
      <>
        <rect x="4" y="3" width="16" height="13" rx="2" />
        <path d="m4 16-3 5h22l-3-5M9 7h6m-6 3h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    windows: (
      <path
        d="M3 5.2 10.4 4v7.2H3Zm9-1.5L21 2v9.2h-9ZM3 12.8h7.4V20L3 18.8Zm9 0h9V22l-9-1.5Z"
        fill="currentColor"
        stroke="none"
      />
    ),
    layers: <path d="m12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5m-18 5 9 5 9-5" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      color={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.terminal}
    </svg>
  );
};

export const Background: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        fontFamily: FONT,
        color: C.text,
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(#365a4211 1px, transparent 1px),linear-gradient(90deg,#365a4211 1px,transparent 1px)",
          backgroundSize: "90px 90px",
          opacity: 0.6,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1250,
          height: 1250,
          borderRadius: "50%",
          left: 850,
          top: -380,
          background: "radial-gradient(circle,#2c6b3b21,transparent 65%)",
          translate: interpolate(f, [0, 720], ["0px 0px", "-80px 70px"], ease),
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

export const Enter: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, style }) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        ...style,
        opacity: interpolate(f, [delay, delay + 24], [0, 1], ease),
        translate: interpolate(
          f,
          [delay, delay + 30],
          ["0px 28px", "0px 0px"],
          ease,
        ),
      }}
    >
      {children}
    </div>
  );
};

export const Heading: React.FC<{
  eyebrow: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ eyebrow, children, style }) => (
  <Enter
    delay={8}
    style={{ position: "absolute", left: 110, top: 145, ...style }}
  >
    <div
      style={{
        color: C.mint,
        fontSize: 22,
        letterSpacing: 4,
        fontFamily: MONO,
        marginBottom: 20,
      }}
    >
      {eyebrow}
    </div>
    <div
      style={{
        fontSize: 76,
        lineHeight: 1.38,
        fontWeight: 600,
        letterSpacing: -2,
      }}
    >
      {children}
    </div>
  </Enter>
);

export const Pill: React.FC<{
  children: React.ReactNode;
  icon?: string;
  style?: React.CSSProperties;
}> = ({ children, icon, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      background: C.panel,
      padding: "13px 21px",
      fontSize: 25,
      color: C.muted,
      ...style,
    }}
  >
    {icon && <Icon name={icon} size={27} />} {children}
  </div>
);

export const Screenshot: React.FC<{
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  region?: [number, number, number, number];
  label?: string;
  zoom?: boolean;
}> = ({
  src,
  x,
  y,
  w,
  h,
  region,
  label = "实际应用界面 · 示例数据",
  zoom = false,
}) => {
  const f = useCurrentFrame();
  const ratio = region ? w / region[2] : w / 1440;
  return (
    <Enter
      delay={20}
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        background: C.panel,
        boxShadow: "0 32px 80px #0005",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          fontSize: 18,
          color: C.muted,
          fontFamily: MONO,
        }}
      >
        <span style={{ display: "flex", gap: 7 }}>
          {[0, 1, 2].map((i) => (
            <i
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: 10,
                background: i === 0 ? C.mint : "#54725f",
              }}
            />
          ))}
        </span>
        <span>{label}</span>
        <Icon name="terminal" size={18} />
      </div>
      <div
        style={{
          height: h - 40,
          overflow: "hidden",
          position: "relative",
          background: "#f0f2f6",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 1440 * ratio,
            height: 900 * ratio,
            left: region ? -region[0] * ratio : 0,
            top: region ? -region[1] * ratio : 0,
            scale: zoom ? interpolate(f, [20, 540], [1, 1.045], ease) : 1,
            transformOrigin: "center center",
          }}
        >
          <CanvasImage
            src={staticFile(`images/${src}`)}
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      </div>
    </Enter>
  );
};

export const Panel: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      border: `1px solid ${C.border}`,
      borderRadius: 16,
      background: C.panel,
      padding: 30,
      ...style,
    }}
  >
    {children}
  </div>
);
