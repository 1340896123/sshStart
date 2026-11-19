import { Composition } from "remotion";
import { ProductVideo } from "./ProductVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="sshStar-Product-Intro"
        component={ProductVideo}
        durationInFrames={5400}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
