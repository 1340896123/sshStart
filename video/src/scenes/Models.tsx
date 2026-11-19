import React from "react";
import { Background, C, Enter, Heading, Pill, Screenshot } from "../design";

export const Models: React.FC = () => (
  <Background>
    <Heading eyebrow="YOUR MODEL. YOUR CHOICE." style={{ top: 205 }}>
      你的模型。
      <br />
      <span style={{ color: C.mint }}>你的选择。</span>
    </Heading>
    <Enter
      delay={40}
      style={{
        position: "absolute",
        left: 115,
        top: 530,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 18,
      }}
    >
      <Pill icon="layers">按提供商管理模型</Pill>
      <Pill icon="sparkles">切换模型与推理级别</Pill>
      <Pill style={{ fontSize: 22 }}>Chat Completions / Responses</Pill>
    </Enter>
    <Screenshot
      src="models.webp"
      x={780}
      y={195}
      w={1020}
      h={700}
      region={[310, 118, 1100, 712]}
      label="模型提供商 · 实际设置界面"
      zoom
    />
    <Enter
      delay={170}
      style={{
        position: "absolute",
        left: 115,
        top: 835,
        fontSize: 22,
        color: C.muted,
      }}
    >
      自行配置 API 密钥；服务费用以提供商为准。
    </Enter>
  </Background>
);
