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
  ease,
} from "../design";

export const Friction: React.FC = () => {
  const f = useCurrentFrame();
  const cards = [
    {
      title: "终端",
      icon: "terminal",
      body: ["$ tail -n 100 app.log", "$ df -hT", "$ systemctl status app"],
    },
    {
      title: "远程文件",
      icon: "folder",
      body: ["/srv/apps", "  config.yaml", "  releases/", "  logs/"],
    },
    {
      title: "AI 对话",
      icon: "sparkles",
      body: ["把日志复制到这里…", "补充服务器信息…", "再回到终端验证…"],
    },
  ];
  return (
    <Background>
      <Heading eyebrow="LESS FRICTION. MORE FLOW.">
        窗口越多，<span style={{ color: C.muted }}>思路越容易被打断。</span>
      </Heading>
      {cards.map((card, i) => (
        <Enter
          key={card.title}
          delay={25 + i * 18}
          style={{
            position: "absolute",
            left: 115 + i * 565,
            top: 430,
            width: 525,
            rotate: interpolate(
              f,
              [0, 300, 420],
              [`${(i - 1) * 3}deg`, `${(i - 1) * 3}deg`, "0deg"],
              ease,
            ),
          }}
        >
          <Panel style={{ height: 365, padding: 30 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                fontSize: 32,
                borderBottom: `1px solid ${C.border}`,
                paddingBottom: 24,
              }}
            >
              <Icon name={card.icon} />
              {card.title}
            </div>
            <div
              style={{
                fontFamily: i === 2 ? undefined : MONO,
                fontSize: 25,
                color: C.muted,
                lineHeight: 1.9,
                paddingTop: 28,
              }}
            >
              {card.body.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </Panel>
        </Enter>
      ))}
      <Enter
        delay={270}
        style={{
          position: "absolute",
          top: 850,
          left: 0,
          width: "100%",
          textAlign: "center",
          fontSize: 38,
          color: C.mint,
        }}
      >
        把工具放在一起，也把上下文留在一起。
      </Enter>
    </Background>
  );
};
