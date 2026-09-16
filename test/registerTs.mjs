import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      const url = new URL(specifier, context.parentURL);
      specifier += existsSync(fileURLToPath(`${url}.ts`)) ? ".ts" : ".tsx";
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(new URL(url).pathname)) {
      const source = readFileSync(fileURLToPath(url), "utf8").replaceAll("import.meta.env", "({})");
      return { format: "module", shortCircuit: true, source: ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    }
    return next(url, context);
  },
});
