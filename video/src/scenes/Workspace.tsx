import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  Background,
  C,
  Enter,
  Heading,
  Icon,
  Screenshot,
  ease,
} from "../design";

export const Workspace: React.FC = () => {
  const f = useCurrentFrame();
  const points = [
    { name: "选服务器", icon: "layers", frame: 40 },
    { name: "处理当前任务", icon: "terminal", frame: 165 },
    { name: "随时展开 AI", icon: "sparkles", frame: 300 },
  ];
  return (
    <Background>
      <Heading eyebrow="ONE WORKSPACE" style={{ top: 225 }}>
        一个窗口。
        <br />
        <span style={{ color: C.mint }}>完整上下文。</span>
      </Heading>
      <Enter
        delay={30}
        style={{
          position: "absolute",
          left: 115,
          top: 515,
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {points.map((p, i) => (
          <div
            key={p.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              fontSize: 30,
              color: C.muted,
              opacity: interpolate(f, [p.frame, p.frame + 22], [0.3, 1], ease),
            }}
          >
            <Icon name={p.icon} size={32} />
            <span
              style={{ fontFamily: "Consolas", fontSize: 20, color: C.mint }}
            >
              0{i + 1}
            </span>
            {p.name}
          </div>
        ))}
      </Enter>
      <Screenshot src="workspace.webp" x={600} y={170} w={1210} h={797} />
      {[
        { x: 40, y: 43, w: 280, h: 810, from: 50, to: 170 },
        { x: 330, y: 82, w: 690, h: 720, from: 180, to: 320 },
        { x: 1020, y: 82, w: 413, h: 810, from: 330, to: 500 },
      ].map((r, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 600 + (r.x * 1210) / 1440,
            top: 210 + (r.y * 1210) / 1440,
            width: (r.w * 1210) / 1440,
            height: (r.h * 1210) / 1440,
            border: `3px solid ${C.mint}`,
            boxShadow: "0 0 35px #97edbf44",
            borderRadius: 8,
            opacity: interpolate(
              f,
              [r.from, r.from + 15, r.to, r.to + 15],
              [0, 1, 1, 0],
              ease,
            ),
          }}
        />
      ))}
    </Background>
  );
};
