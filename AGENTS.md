<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **sshStart** (1024 symbols, 2633 relationships, 90 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/sshStart/context` | Codebase overview, check index freshness |
| `gitnexus://repo/sshStart/clusters` | All functional areas |
| `gitnexus://repo/sshStart/processes` | All execution flows |
| `gitnexus://repo/sshStart/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Build and Packaging

- **Frontend build:** `npm run build` runs TypeScript checking followed by the Vite production build.
- **Windows installer build:** `npm run tauri build` builds the frontend, compiles the Rust/Tauri application, and creates both MSI and NSIS installers.
- **Required Rust toolchain:** use the installed `1.97.1-x86_64-pc-windows-msvc` toolchain. The default `1.91.0` toolchain can fail while compiling `tokio 1.53.1` with `E0080` layout errors.
- **Recommended PowerShell environment:**

  ```powershell
  $env:RUSTUP_TOOLCHAIN = "1.97.1"
  $env:CARGO_INCREMENTAL = "0"
  $env:RUSTFLAGS = "-C lto=off -C embed-bitcode=no"
  npm run tauri build
  ```

- **Build artifacts:** `src-tauri/target/release/bundle/msi/Portico SSH_0.1.0_x64_en-US.msi` and `src-tauri/target/release/bundle/nsis/Portico SSH_0.1.0_x64-setup.exe`. The `target` directory is generated output and is not committed.
