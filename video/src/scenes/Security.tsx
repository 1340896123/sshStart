import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Background, C, Enter, Heading, Icon, Panel, ease } from "../design";

export const Security: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Background>
      <Heading eyebrow="TRUST STARTS WITH CONTROL">
        自动化，<span style={{ color: C.mint }}>也有分寸。</span>
      </Heading>
      <div
        style={{
          position: "absolute",
          left: 205,
          top: 350,
          width: 520,
          height: 520,
          border: `1px solid ${C.border}`,
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 265,
          top: 410,
          width: 400,
          height: 400,
          border: `1px dashed ${C.border}`,
          borderRadius: "50%",
          rotate: interpolate(f, [0, 540], ["0deg", "50deg"], ease),
        }}
      />
      <Enter
        delay={25}
        style={{
          position: "absolute",
          left: 355,
          top: 500,
          width: 220,
          height: 220,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 45,
          border: `1px solid #60836b`,
          background: "linear-gradient(140deg,#294c34,#101f16)",
          boxShadow: "0 0 90px #97edbf11",
        }}
      >
        <Icon name="shield" size={120} />
      </Enter>
      {[
        {
          icon: "lock",
          title: "凭据妥善保管",
          detail: "系统凭据库 / 本地加密存储",
          at: 50,
        },
        {
          icon: "shield",
          title: "确认服务器身份",
          detail: "known_hosts 主机密钥验证",
          at: 170,
        },
        {
          icon: "check",
          title: "操作权限清晰",
          detail: "按需授权工具 / 高风险操作审批",
          at: 285,
        },
      ].map((item, i) => (
        <Enter
          delay={item.at}
          key={item.title}
          style={{
            position: "absolute",
            left: 850,
            top: 340 + i * 175,
            width: 950,
          }}
        >
          <Panel
            style={{
              display: "flex",
              alignItems: "center",
              gap: 25,
              padding: 28,
            }}
          >
            <Icon name={item.icon} size={45} />
            <div>
              <div style={{ fontSize: 33, fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: 25, color: C.muted, marginTop: 11 }}>
                {item.detail}
              </div>
            </div>
          </Panel>
        </Enter>
      ))}
      <Enter
        delay={390}
        style={{
          position: "absolute",
          left: 130,
          top: 865,
          fontSize: 23,
          color: C.muted,
        }}
      >
        AI 消息与相关工具结果，会发送到你配置的模型服务。
      </Enter>
    </Background>
  );
};
