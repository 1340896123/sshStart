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

export const Sessions: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Background>
      <Heading eyebrow="ORGANIZED CONNECTIONS">
        服务器有序，<span style={{ color: C.mint }}>会话独立。</span>
      </Heading>
      <Enter
        delay={30}
        style={{ position: "absolute", left: 115, top: 360, width: 600 }}
      >
        <Panel>
          <div style={{ fontSize: 23, color: C.muted, marginBottom: 20 }}>
            服务器 / SERVERS
          </div>
          {[
            {
              group: "生产环境",
              name: "production-01",
              host: "deploy@192.0.2.10",
              color: C.mint,
            },
            {
              group: "测试环境",
              name: "staging-01",
              host: "dev@192.0.2.20",
              color: C.amber,
            },
          ].map((s, i) => (
            <div
              key={s.name}
              style={{
                marginTop: 24,
                opacity: interpolate(
                  f,
                  [35 + i * 70, 65 + i * 70],
                  [0, 1],
                  ease,
                ),
              }}
            >
              <div
                style={{
                  fontSize: 27,
                  color: C.muted,
                  marginBottom: 10,
                  display: "flex",
                  gap: 14,
                }}
              >
                <Icon name="folder" size={28} />
                {s.group}
              </div>
              <div
                style={{
                  padding: "20px 22px",
                  borderRadius: 10,
                  background: i === 0 ? "#244332" : "#1b2a21",
                  border: `1px solid ${C.border}`,
                }}
              >
                <div style={{ fontSize: 29, color: s.color }}>{s.name}</div>
                <div
                  style={{
                    font: "21px Consolas",
                    color: C.muted,
                    marginTop: 9,
                  }}
                >
                  {s.host}
                </div>
              </div>
            </div>
          ))}
        </Panel>
      </Enter>
      {[
        {
          title: "会话 01 · 排查日志",
          command: "$ tail -f /var/log/app.log",
          file: "/var/log",
          ai: "查看最近的错误日志",
        },
        {
          title: "会话 02 · 部署验证",
          command: "$ systemctl status app",
          file: "/srv/releases",
          ai: "分析当前目录的部署结构",
        },
      ].map((s, i) => (
        <Enter
          key={s.title}
          delay={110 + i * 90}
          style={{
            position: "absolute",
            left: 850,
            top: 365 + i * 252,
            width: 945,
          }}
        >
          <Panel style={{ padding: 24 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontSize: 29,
                color: i === 0 ? C.mint : C.blue,
              }}
            >
              <Icon name="terminal" color={i === 0 ? C.mint : C.blue} />
              {s.title}
            </div>
            <div
              style={{
                marginTop: 20,
                padding: 17,
                fontSize: 25,
                fontFamily: MONO,
                background: C.bg,
                borderRadius: 7,
              }}
            >
              {s.command}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 18,
                fontSize: 22,
                color: C.muted,
              }}
            >
              <span>文件位置 {s.file}</span>
              <span>AI · {s.ai}</span>
            </div>
          </Panel>
        </Enter>
      ))}
      <Enter
        delay={345}
        style={{
          position: "absolute",
          left: 120,
          top: 855,
          display: "flex",
          gap: 14,
        }}
      >
        <Pill icon="lock">密码 / 私钥</Pill>
        <Pill icon="layers">跳板机</Pill>
        <span
          style={{
            alignSelf: "center",
            marginLeft: 32,
            color: C.muted,
            fontSize: 21,
          }}
        >
          会话隔离示意 · 示例服务器
        </span>
      </Enter>
    </Background>
  );
};
