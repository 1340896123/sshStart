import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "../node_modules/monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "../node_modules/monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "../node_modules/monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Read the workspace tokens just before an editor mounts, after CSS has loaded.
export function definePorticoEditorTheme() {
  const tokens = getComputedStyle(document.documentElement);
  const color = (name: string) => tokens.getPropertyValue(name).trim();

  monaco.editor.defineTheme("portico", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color("--surface-raised"),
      "editor.foreground": color("--fg"),
      "editorLineNumber.foreground": color("--muted-2"),
      "editorLineNumber.activeForeground": color("--fg"),
      "editorCursor.foreground": color("--accent"),
      "editor.selectionBackground": color("--editor-selection"),
      "editor.inactiveSelectionBackground": color("--editor-selection-inactive"),
      "editor.lineHighlightBackground": color("--surface"),
      "editorIndentGuide.background1": color("--border"),
      "editorIndentGuide.activeBackground1": color("--border-strong"),
      "editorWidget.background": color("--surface-raised"),
      "editorWidget.border": color("--border"),
      "editorSuggestWidget.selectedBackground": color("--accent-soft"),
      "editorOverviewRuler.border": color("--border"),
      "scrollbarSlider.background": color("--border-strong"),
      "scrollbarSlider.hoverBackground": color("--muted-2"),
      "scrollbarSlider.activeBackground": color("--muted"),
    },
  });
}

loader.config({ monaco });

export default monaco;
