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
- Optional end-to-end cloud sync for server profiles, settings, and referenced SSH private keys; the cloud receives only AES-256-GCM ciphertext
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
- `GET /sync/data` with a bearer token, returning `{ "ciphertext": string, "updatedAt": number }`; return `404` when the account has no snapshot yet.
- `PUT /sync/data` with a bearer token and `{ "ciphertext": string, "updatedAt": number }`.
- `GET /sync/keys` with a bearer token, returning `{ "ciphertext": string, "updatedAt": number }`; return `404` before the first key backup.
- `PUT /sync/keys` with a bearer token and `{ "ciphertext": string, "updatedAt": number }`.

Application snapshot ciphertext uses a locally generated AES-256-GCM key stored at `~/.porticossh/sync.key`. Key backups contain the local `~/.porticossh/*.key` files plus private keys referenced by server and jump-host profiles. Referenced keys are copied into the managed `~/.porticossh` directory, and synchronized profiles use portable key paths that resolve against each device's home directory. Key backups are independently encrypted with AES-256-GCM using a PBKDF2-SHA256 key derived from the user's custom passphrase. Neither encryption key nor passphrase is sent to the service. Authentication passwords should be hashed by the service and must not be stored as plaintext.

## Included cloud sync backend

The repository includes a self-hosted implementation in `server/`. It uses Node.js 24's built-in HTTP, cryptography, and SQLite support, hashes passwords with scrypt, issues seven-day HMAC-SHA256 bearer tokens, rate-limits authentication attempts, and stores application snapshots and key backups per account without decrypting them.

```powershell
$env:PORTICO_SYNC_TOKEN_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run sync-server
```

Configure the desktop app with `http://127.0.0.1:8787` for local development. For a public deployment, serve it behind HTTPS. See `server/README.md` for environment variables, Docker usage, and tests.

To build and publish the sync server image to Docker Hub, then deploy it with Docker Compose, see [`docs/docker-sync-deployment.md`](docs/docker-sync-deployment.md).
