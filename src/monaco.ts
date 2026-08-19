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

monaco.editor.defineTheme("portico", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#fcfdfc",
    "editor.foreground": "#17201e",
    "editorLineNumber.foreground": "#a6afac",
    "editorLineNumber.activeForeground": "#17201e",
    "editorCursor.foreground": "#1c6f60",
    "editor.selectionBackground": "#b5ded4",
    "editor.inactiveSelectionBackground": "#d9ece7",
    "editor.lineHighlightBackground": "#f0f4f3",
    "editorIndentGuide.background": "#e6ecea",
    "editorIndentGuide.activeBackground": "#cdd5d2",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#dfe4e2",
    "editorSuggestWidget.selectedBackground": "#d9ece7",
    "editorOverviewRuler.border": "#dfe4e2",
    "scrollbarSlider.background": "#c9d2cf",
    "scrollbarSlider.hoverBackground": "#aeb9b5",
    "scrollbarSlider.activeBackground": "#93a09b",
  },
});

loader.config({ monaco });

export default monaco;
