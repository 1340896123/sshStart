# Portico SSH

Portico SSH is a compact Tauri desktop workspace for managing SSH servers. Each server can have multiple isolated sessions with its own terminal buffer, remote file location, selection, and AI conversation.

## Included

- Server profiles grouped by environment, with password or private-key authentication
- Native Rust SSH PTY sessions rendered with xterm.js
- SFTP directory browsing, upload, download, create-folder, and delete operations
- OpenAI-compatible assistant with SSH command tools and visible reasoning summaries
- High-risk AI command blocking; explicit `/run <command>` remains available to the operator
- Secrets stored in the operating-system credential vault, never persisted in WebView local storage
- SSH host-key verification through `~/.ssh/known_hosts`, including trust on first use

## Run

```powershell
npm install
npm run tauri dev
```

The browser-only preview is available with `npm run dev`. It uses interactive demo terminal, file, and AI data; native SSH, SFTP, system credentials, and remote AI tools require Tauri.

## Build

```powershell
npm run build
npx tauri build
```

AI settings accept endpoints implementing the OpenAI `chat/completions` schema and function tool calls. Providers that return `reasoning_content` are supported; otherwise Portico requests a concise reasoning summary without exposing hidden chain-of-thought.
