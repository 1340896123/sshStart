import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  Background,
  C,
  Enter,
  Heading,
  Icon,
  Panel,
  Pill,
  Screenshot,
  ease,
} from "../design";

export const Files: React.FC = () => {
  const f = useCurrentFrame();
  const code = [
    "server:",
    "  name: production-01",
    "  port: 8080",
    "",
    "logging:",
    "  level: info",
    "  path: /var/log/app.log",
  ];
  return (
    <Background>
      <Heading eyebrow="FILES, WITHIN REACH">
        远程文件，<span style={{ color: C.mint }}>触手可及。</span>
      </Heading>
      <Screenshot
        src="files.webp"
        x={110}
        y={345}
        w={910}
        h={530}
        region={[330, 480, 690, 405]}
        label="SFTP 文件管理 · 实际界面"
      />
      <Enter
        delay={100}
        style={{ position: "absolute", left: 1070, top: 345, width: 730 }}
      >
        <Panel style={{ padding: 0, overflow: "hidden", height: 530 }}>
          <div
            style={{
              height: 64,
              padding: "15px 25px",
              borderBottom: `1px solid ${C.border}`,
              fontSize: 25,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>
              config.yaml <span style={{ color: C.mint }}>●</span>
            </span>
            <span style={{ fontSize: 20, color: C.muted }}>编辑操作示意</span>
          </div>
          <div style={{ padding: 26, font: "26px/1.75 Consolas" }}>
            {code.map((line, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 24,
                  opacity: interpolate(
                    f,
                    [115 + i * 10, 130 + i * 10],
                    [0, 1],
                    ease,
                  ),
                }}
              >
                <span style={{ color: "#5e7969", width: 25 }}>{i + 1}</span>
                <span
                  style={{
                    color: line.startsWith("  ") ? C.muted : C.mint,
                    whiteSpace: "pre",
                  }}
                >
                  {line}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 22,
              right: 28,
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: C.mint,
              fontSize: 23,
              opacity: interpolate(f, [410, 435], [0, 1], ease),
            }}
          >
            <Icon name="check" size={27} />
            保存后继续验证
          </div>
        </Panel>
      </Enter>
      <Enter
        delay={40}
        style={{
          position: "absolute",
          left: 1000,
          top: 245,
          display: "flex",
          gap: 14,
        }}
      >
        <Pill icon="folder">浏览目录</Pill>
        <Pill icon="arrow">上传 / 下载</Pill>
        <Pill icon="terminal">编辑配置</Pill>
      </Enter>
    </Background>
  );
};
