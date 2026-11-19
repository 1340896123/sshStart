import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  Background,
  C,
  Enter,
  Heading,
  Icon,
  MONO,
  Pill,
  ease,
} from "../design";

export const Sync: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Background>
      <Heading eyebrow="ENCRYPT LOCALLY. SYNC SECURELY.">
        换个设备，<span style={{ color: C.mint }}>继续工作。</span>
      </Heading>
      {[
        { x: 335, icon: "laptop", title: "当前设备", detail: "配置与设置" },
        { x: 960, icon: "cloud", title: "同步服务", detail: "只保存密文" },
        { x: 1585, icon: "laptop", title: "新的设备", detail: "恢复工作台" },
      ].map((item, i) => (
        <Enter
          delay={25 + i * 25}
          key={item.title}
          style={{
            position: "absolute",
            left: item.x - 150,
            top: 410,
            width: 300,
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 230,
              height: 190,
              margin: "0 auto",
              borderRadius: 30,
              background: C.panel,
              border: `1px solid ${C.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={item.icon} size={100} />
          </div>
          <div style={{ fontSize: 33, marginTop: 25 }}>{item.title}</div>
          <div style={{ fontSize: 25, color: C.muted, marginTop: 13 }}>
            {item.detail}
          </div>
        </Enter>
      ))}
      {[0, 1].map((i) => (
        <React.Fragment key={i}>
          <div
            style={{
              position: "absolute",
              left: 505 + i * 625,
              top: 500,
              width: 280,
              borderTop: `2px dashed ${C.border}`,
            }}
          />
          {[0, 1, 2].map((n) => (
            <div
              key={n}
              style={{
                position: "absolute",
                left:
                  505 +
                  i * 625 +
                  (((Math.max(0, f - 90) + n * 40) % 150) / 150) * 280,
                top: 495,
                width: 11,
                height: 11,
                borderRadius: "50%",
                background: C.mint,
                opacity: interpolate(f, [90, 120], [0, 1], ease),
              }}
            />
          ))}
        </React.Fragment>
      ))}
      <Enter
        delay={130}
        style={{
          position: "absolute",
          left: 640,
          top: 745,
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <Pill icon="lock" style={{ fontFamily: MONO, fontSize: 26 }}>
          AES-256-GCM
        </Pill>
        <span style={{ fontSize: 27, color: C.muted }}>先加密，再上传。</span>
      </Enter>
      <Enter
        delay={235}
        style={{
          position: "absolute",
          left: 0,
          top: 855,
          width: "100%",
          textAlign: "center",
          fontSize: 24,
          color: C.muted,
        }}
      >
        可选功能 · 需配置同步服务 · 私钥备份由自定义口令单独加密
      </Enter>
    </Background>
  );
};
