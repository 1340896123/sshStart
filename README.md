# Portico SSH

Portico SSH is a compact Tauri desktop workspace for managing SSH servers. Each server can have multiple isolated sessions with its own terminal buffer, remote file location, selection, and AI conversation.

## Included

- Server profiles grouped by environment, with password or private-key authentication
- Native Rust SSH PTY sessions rendered with xterm.js
- SFTP directory browsing, upload, download, create-folder, and delete operations
- OpenAI-compatible assistant with SSH command tools and visible reasoning summaries
- Configurable AI tool catalog in settings: terminal jobs, file/SFTP, system metrics, process/network diagnostics, Docker/systemd, logs, snippets, and risk checks
- High-risk AI command blocking; explicit `/run <command>` remains available to the operator
- Mutating tools are opt-in, with per-tool output/timeout/round limits and an inline human approval step for high-risk actions
- Secrets stored in the operating-system credential vault; all SQLite app state is encrypted at rest
- Optional end-to-end cloud sync for server profiles and settings; the cloud receives only AES-256-GCM ciphertext
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

## Cloud sync service contract

Cloud sync is intentionally backend-agnostic. Configure the API root in Settings → Cloud Sync (or set `VITE_PORTICO_SYNC_API_URL` before building). The service must expose:

- `POST /auth/register` and `POST /auth/login` with `{ "email": string, "password": string }`, returning `{ "token": string, "email": string }` (an `accessToken` field is also accepted).
- `GET /sync/data` with a bearer token, returning `{ "ciphertext": string }`; return `404` when the account has no snapshot yet.
- `PUT /sync/data` with a bearer token and `{ "ciphertext": string, "updatedAt": number }`.

The `ciphertext` value is an AES-256-GCM envelope containing a random nonce and the complete server/settings snapshot. The encryption key is generated locally and stored at `~/.porticossh/sync.key`; it is never sent to the service. Authentication passwords should be hashed by the service and must not be stored as plaintext.
