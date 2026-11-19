import React from "react";
import {
  AbsoluteFill,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Captions } from "./Captions";
import { C, FONT, Logo, MONO } from "./design";
import timeline from "./timeline.json";
import { Intro } from "./scenes/Intro";
import { Friction } from "./scenes/Friction";
import { Workspace } from "./scenes/Workspace";
import { Sessions } from "./scenes/Sessions";
import { Files } from "./scenes/Files";
import { Ai } from "./scenes/Ai";
import { Models } from "./scenes/Models";
import { Security } from "./scenes/Security";
import { Sync } from "./scenes/Sync";
import { Outro } from "./scenes/Outro";

const scenes = [
  Intro,
  Friction,
  Workspace,
  Sessions,
  Files,
  Ai,
  Models,
  Security,
  Sync,
  Outro,
];
export const ProductVideo: React.FC = () => {
  const f = useCurrentFrame();
  const active = Math.max(
    0,
    timeline.findIndex(
      (s) => f >= s.start * 30 && f < (s.start + s.seconds) * 30,
    ),
  );
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, color: C.text }}>
      <TransitionSeries>
        {timeline.flatMap((s, i) => {
          const Scene = scenes[i];
          const sequence = (
            <TransitionSeries.Sequence
              key={s.id}
              name={s.title}
              durationInFrames={s.seconds * 30 + (i === 9 ? 0 : 21)}
            >
              <Scene />
            </TransitionSeries.Sequence>
          );
          return i === 0
            ? [sequence]
            : [
                <TransitionSeries.Transition
                  key={`transition-${s.id}`}
                  presentation={fade()}
                  timing={linearTiming({ durationInFrames: 21 })}
                />,
                sequence,
              ];
        })}
      </TransitionSeries>
      <div
        style={{
          position: "absolute",
          left: 94,
          right: 94,
          top: 49,
          height: 45,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          zIndex: 35,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Logo size={37} />
          <span style={{ fontSize: 29, letterSpacing: -0.8 }}>
            ssh<span style={{ color: C.mint }}>Star</span>
          </span>
          <span style={{ fontSize: 17, color: C.muted, marginLeft: 18 }}>
            产品介绍
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 24,
            alignItems: "center",
            fontFamily: MONO,
            fontSize: 18,
            color: C.muted,
          }}
        >
          <span style={{ color: C.mint }}>
            {String(active + 1).padStart(2, "0")} / 10
          </span>
          <span style={{ fontFamily: FONT }}>{timeline[active].title}</span>
          <span>
            {String(Math.floor(f / 1800)).padStart(2, "0")}:
            {String(Math.floor(f / 30) % 60).padStart(2, "0")} / 03:00
          </span>
        </div>
      </div>
      <Captions />
      <div
        style={{
          position: "absolute",
          bottom: 25,
          left: 95,
          right: 95,
          display: "flex",
          gap: 5,
          zIndex: 40,
        }}
      >
        {timeline.map((s) => (
          <div
            key={s.id}
            style={{
              height: 3,
              flex: s.seconds,
              background: "#2c4434",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: 3,
                background: C.mint,
                width: `${interpolate(f, [s.start * 30, (s.start + s.seconds) * 30], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}%`,
              }}
            />
          </div>
        ))}
      </div>
      <AbsoluteFill
        style={{
          zIndex: 60,
          background: C.bg,
          pointerEvents: "none",
          opacity: interpolate(f, [5365, 5399], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />
      <Audio src={staticFile("audio/soundtrack.m4a")} />
    </AbsoluteFill>
  );
};
