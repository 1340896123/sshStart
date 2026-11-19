import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  Background,
  C,
  Enter,
  Icon,
  Logo,
  MONO,
  Panel,
  Pill,
  ease,
} from "../design";

export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Background>
      <Enter
        delay={8}
        style={{
          position: "absolute",
          left: 145,
          top: 230,
          display: "flex",
          gap: 25,
          alignItems: "center",
        }}
      >
        <Logo size={110} />
        <span style={{ fontSize: 138, fontWeight: 600, letterSpacing: -7 }}>
          ssh<span style={{ color: C.mint, fontWeight: 400 }}>Star</span>
        </span>
      </Enter>
      <Enter
        delay={25}
        style={{
          position: "absolute",
          left: 150,
          top: 450,
          fontSize: 70,
          lineHeight: 1.5,
          fontWeight: 600,
        }}
      >
        连接每一台服务器，
        <br />
        <span style={{ color: C.mint }}>专注真正重要的事。</span>
      </Enter>
      <Enter
        delay={45}
        style={{
          position: "absolute",
          left: 155,
          top: 735,
          display: "flex",
          gap: 15,
        }}
      >
        <Pill icon="terminal">SSH 终端</Pill>
        <Pill icon="folder">远程文件</Pill>
        <Pill icon="sparkles">AI 助手</Pill>
      </Enter>
      <div
        style={{
          position: "absolute",
          left: 1130,
          top: 280,
          width: 600,
          height: 600,
          border: "1px solid #365a4266",
          borderRadius: "50%",
          rotate: interpolate(f, [0, 360], ["-8deg", "8deg"], ease),
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 1190,
          top: 340,
          width: 480,
          height: 480,
          border: "1px dashed #48765466",
          borderRadius: "50%",
        }}
      />
      <Enter
        delay={32}
        style={{ position: "absolute", left: 1070, top: 335, width: 680 }}
      >
        <Panel
          style={{
            padding: 0,
            overflow: "hidden",
            boxShadow: "0 25px 70px #0005",
          }}
        >
          <div
            style={{
              padding: "17px 25px",
              display: "flex",
              gap: 13,
              borderBottom: `1px solid ${C.border}`,
              fontSize: 22,
              color: C.muted,
            }}
          >
            <Icon name="terminal" size={25} />
            production-01{" "}
            <span style={{ marginLeft: "auto", color: C.mint }}>SSH</span>
          </div>
          <div
            style={{
              padding: 32,
              fontSize: 26,
              lineHeight: 2,
              fontFamily: MONO,
            }}
          >
            <div style={{ color: C.mint }}>$ ssh deploy@192.0.2.10</div>
            <div
              style={{
                opacity: interpolate(f, [65, 90], [0, 1], ease),
                color: C.muted,
              }}
            >
              Host identity verified.
            </div>
            <div style={{ opacity: interpolate(f, [100, 125], [0, 1], ease) }}>
              Connection established.
            </div>
            <div
              style={{
                opacity: interpolate(f, [140, 165], [0, 1], ease),
                color: C.mint,
              }}
            >
              Your workspace is ready.{" "}
              <span style={{ opacity: Math.floor(f / 18) % 2 ? 1 : 0.25 }}>
                ▌
              </span>
            </div>
          </div>
        </Panel>
      </Enter>
      <Enter delay={95} style={{ position: "absolute", left: 1245, top: 730 }}>
        <Pill icon="sparkles" style={{ background: "#203b2a", color: C.mint }}>
          让工作，保持心流。
        </Pill>
      </Enter>
      <div
        style={{
          position: "absolute",
          left: 1100,
          top: 857,
          fontSize: 18,
          color: C.muted,
        }}
      >
        连接画面为工作流示意，使用示例地址。
      </div>
    </Background>
  );
};
