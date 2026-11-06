import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const release = JSON.parse(
  readFileSync(new URL("./src/release.json", import.meta.url), "utf8"),
);
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  css: { postcss: { plugins: [] } },
  plugins: [
    {
      name: "release-metadata",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "release.json",
          source: JSON.stringify(release, null, 2) + "\n",
        });
      },
      transformIndexHtml(html) {
        const replacements = {
          VERSION: release.version,
          RELEASE_DATE: release.date,
          RELEASE_URL: release.url,
          EXE_URL: `/downloads/${release.exe.name}`,
          MSI_URL: `/downloads/${release.msi.name}`,
          EXE_SIZE: `${(release.exe.size / 1024 / 1024).toFixed(1)} MB`,
          MSI_SIZE: `${(release.msi.size / 1024 / 1024).toFixed(1)} MB`,
          EXE_HASH: release.exe.sha256,
        };
        return html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
          if (!(key in replacements))
            throw new Error(`Unknown release token: ${match}`);
          return escapeHtml(replacements[key]);
        });
      },
    },
  ],
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
