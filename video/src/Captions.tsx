import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "@remotion/captions";
import data from "./captions.json";
import { C, FONT } from "./design";

const captions: Caption[] = data;
export const Captions: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (f / fps) * 1000;
  const caption = captions.find((c) => c.startMs <= ms && c.endMs > ms);
  if (!caption) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 90,
        right: 90,
        bottom: 66,
        display: "flex",
        justifyContent: "center",
        fontFamily: FONT,
        zIndex: 50,
      }}
    >
      <div
        style={{
          fontSize: 34,
          fontWeight: 500,
          lineHeight: 1.5,
          color: C.text,
          background: "#080e0bf2",
          border: "1px solid #36533e99",
          borderRadius: 8,
          padding: "10px 26px",
          boxShadow: "0 6px 30px #0005",
          textAlign: "center",
          maxWidth: 1690,
        }}
      >
        {caption.text}
      </div>
    </div>
  );
};
