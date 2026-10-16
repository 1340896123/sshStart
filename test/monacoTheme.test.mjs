import assert from "node:assert/strict";
import test from "node:test";
import { TokenTheme } from "monaco-editor/editor/common/languages/supports/tokenization.js";
import { normalizeMonacoColor } from "../src/monacoColors.ts";

test("CSS shorthand colors remain compatible with Monaco's actual token compiler", () => {
  assert.throws(() => TokenTheme.createFromRawTokenTheme([{ token: "", foreground: "#222", background: "#fff" }], []), /Illegal value for token color/);
  for (const [input, expected] of [["#fff", "#ffffff"], [" #AbC ", "#AAbbCC"], ["#1234", "#11223344"], ["#202631", "#202631"], ["#11223344", "#11223344"]]) {
    const color = normalizeMonacoColor(input);
    assert.equal(color, expected);
    assert.doesNotThrow(() => TokenTheme.createFromRawTokenTheme([{ token: "", foreground: color, background: color }], []));
  }
});
