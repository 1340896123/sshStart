import { mergeConfig } from "vite";
import appConfig from "../../vite.config";

export default mergeConfig(appConfig, {
  build: {
    outDir: "output/file-editor-e2e/dist",
    emptyOutDir: true,
    rolldownOptions: { input: "test/e2e/file-editor.html" },
  },
});
