import React from "react";
import { CanvasImage, staticFile } from "remotion";
import { Background, C, Enter, Icon, Logo, Pill } from "../design";

export const Outro: React.FC = () => (
  <Background>
    <Enter
      delay={10}
      style={{
        position: "absolute",
        left: 145,
        top: 200,
        display: "flex",
        alignItems: "center",
        gap: 24,
      }}
    >
      <Logo size={86} />
      <span style={{ fontSize: 96, fontWeight: 600, letterSpacing: -4 }}>
        ssh<span style={{ color: C.mint, fontWeight: 400 }}>Star</span>
      </span>
    </Enter>
    <Enter
      delay={30}
      style={{
        position: "absolute",
        left: 150,
        top: 365,
        fontSize: 70,
        lineHeight: 1.45,
        fontWeight: 600,
      }}
    >
      下一次连接，
      <br />
      <span style={{ color: C.mint }}>从这里开始。</span>
    </Enter>
    <Enter
      delay={60}
      style={{
        position: "absolute",
        left: 155,
        top: 610,
        fontSize: 49,
        color: C.mint,
        fontFamily: "Consolas",
        letterSpacing: -1,
      }}
    >
      sshstar.123756.xyz
    </Enter>
    <Enter delay={95} style={{ position: "absolute", left: 158, top: 715 }}>
      <Pill
        icon="windows"
        style={{
          background: C.mint,
          color: C.bg,
          borderColor: C.mint,
          fontSize: 28,
          padding: "18px 27px",
        }}
      >
        下载 Windows 版 <Icon name="arrow" color={C.bg} size={30} />
      </Pill>
      <div style={{ marginTop: 17, fontSize: 23, color: C.muted }}>
        Windows x64 · EXE / MSI
      </div>
    </Enter>
    <Enter
      delay={45}
      style={{
        position: "absolute",
        left: 1040,
        top: 200,
        width: 730,
        height: 500,
        border: `1px solid ${C.border}`,
        borderRadius: 17,
        overflow: "hidden",
        boxShadow: "0 30px 80px #0005",
      }}
    >
      <div
        style={{
          height: 43,
          background: C.raised,
          padding: "8px 20px",
          fontSize: 19,
          color: C.muted,
        }}
      >
        https://sshstar.123756.xyz
      </div>
      <CanvasImage
        src={staticFile("images/website.webp")}
        style={{
          width: 730,
          height: 457,
          objectFit: "cover",
          objectPosition: "top",
        }}
      />
    </Enter>
    <Enter
      delay={140}
      style={{
        position: "absolute",
        left: 1380,
        top: 735,
        display: "flex",
        alignItems: "center",
        gap: 24,
      }}
    >
      <CanvasImage
        src={staticFile("images/website-qr.png")}
        style={{ width: 130, height: 130, borderRadius: 8 }}
      />
      <div style={{ fontSize: 25, lineHeight: 1.8, color: C.muted }}>
        扫码访问官网
        <br />
        <span style={{ fontSize: 19 }}>把专注，留给创造。</span>
      </div>
    </Enter>
  </Background>
);
