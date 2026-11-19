import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  Background,
  C,
  Enter,
  Heading,
  Icon,
  MONO,
  Panel,
  Pill,
  ease,
} from "../design";

export const Ai: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Background>
      <Heading eyebrow="AN ASSISTANT, IN CONTEXT" style={{ top: 205 }}>
        遇到问题，
        <br />
        <span style={{ color: C.mint }}>一起排查。</span>
      </Heading>
      <Enter
        delay={35}
        style={{
          position: "absolute",
          left: 115,
          top: 510,
          display: "flex",
          flexDirection: "column",
          gap: 25,
        }}
      >
        {[
          "结合当前 SSH 会话",
          "查看日志、资源与目录",
          "运行状态和工具调用可见",
        ].map((text, i) => (
          <div
            key={text}
            style={{
              fontSize: 31,
              color: C.muted,
              display: "flex",
              alignItems: "center",
              gap: 15,
              opacity: interpolate(
                f,
                [45 + i * 120, 75 + i * 120],
                [0.25, 1],
                ease,
              ),
            }}
          >
            <Icon name="check" size={28} />
            {text}
          </div>
        ))}
      </Enter>
      <Enter
        delay={25}
        style={{ position: "absolute", left: 850, top: 195, width: 940 }}
      >
        <Panel style={{ height: 705, padding: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              fontSize: 27,
            }}
          >
            <Icon name="sparkles" />
            AI 助手
            <span style={{ marginLeft: "auto", color: C.muted, fontSize: 20 }}>
              示例工作流
            </span>
          </div>
          <div
            style={{
              opacity: interpolate(f, [65, 90], [0, 1], ease),
              marginTop: 35,
              marginLeft: 150,
              padding: "21px 26px",
              background: "#2a4c36",
              borderRadius: "15px 15px 3px 15px",
              fontSize: 29,
            }}
          >
            帮我检查一下服务器的磁盘空间。
          </div>
          <div
            style={{
              opacity: interpolate(f, [150, 178], [0, 1], ease),
              marginTop: 35,
              fontSize: 27,
              lineHeight: 1.8,
            }}
          >
            <span style={{ color: C.mint }}>先看数据，再做判断。</span>
            <br />
            <span style={{ color: C.muted }}>
              先读取磁盘使用情况，不修改服务器文件。
            </span>
          </div>
          <div
            style={{
              opacity: interpolate(f, [250, 280], [0, 1], ease),
              marginTop: 29,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 20px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "#213b2a",
                fontSize: 23,
              }}
            >
              <Icon name="terminal" size={27} />
              终端命令
              <span style={{ marginLeft: "auto", color: C.mint }}>
                只读检查
              </span>
            </div>
            <div
              style={{
                padding: 24,
                background: C.bg,
                fontFamily: MONO,
                fontSize: 27,
              }}
            >
              <span style={{ color: C.mint }}>$</span> df -hT
            </div>
          </div>
          <div
            style={{
              opacity: interpolate(f, [440, 465], [0, 1], ease),
              marginTop: 26,
              display: "flex",
              alignItems: "center",
              gap: 13,
              fontSize: 27,
              color: C.mint,
            }}
          >
            <Icon name="check" />
            结合工具结果，再讨论下一步。
          </div>
        </Panel>
      </Enter>
      <Enter delay={510} style={{ position: "absolute", left: 115, top: 795 }}>
        <Pill icon="shield" style={{ fontSize: 23 }}>
          由你掌握下一步
        </Pill>
      </Enter>
    </Background>
  );
};
