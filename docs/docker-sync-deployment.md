# Docker Compose 配置与部署说明

本文说明如何使用仓库中的 `docker-compose.yml` 部署 Portico SSH 云同步服务。当前仅生成和检查配置，不在本机执行 Docker 命令；文中的命令留待 Docker 环境就绪后使用。

## 部署边界

Compose 只运行 `server/` 中的云同步 API，不运行 Tauri 桌面客户端。桌面端仍需安装 Portico SSH，并在“设置 → 云端同步”中填写该服务的访问地址。

仓库中的相关文件如下：

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 定义同步服务、端口映射、健康检查和数据卷 |
| `deploy/portico-sync.env.example` | 环境变量模板；复制后填写镜像地址和密钥 |
| `server/Dockerfile` | 构建 Node.js 24 Alpine 同步服务镜像 |
| `server/.dockerignore` | 排除测试、数据库和构建无关文件 |

## Compose 配置说明

`docker-compose.yml` 当前包含一个 `portico-sync` 服务：

- 使用 `DOCKERHUB_IMAGE` 指定已发布的同步服务镜像。
- 容器监听 `8787`；默认只将宿主机的 `127.0.0.1:8787` 暴露出来。
- 使用命名卷 `portico-sync-data` 保存 `/data/portico-sync.sqlite`，容器重建不会丢失账号和同步快照。
- 当前数据层是 SQLite，按单实例部署；不要直接将该服务扩展为多个副本。
- 通过 `/healthz` 做健康检查，服务未就绪时 Compose 能识别异常状态。
- 使用非 root 用户运行，并启用 `no-new-privileges`；服务只保存加密后的同步密文。
- `PORTICO_SYNC_TOKEN_SECRET` 是令牌签名密钥，必须至少 32 字节，并且在升级、重启和多副本之间保持不变。

## 环境变量

先复制 `deploy/portico-sync.env.example` 为 `deploy/portico-sync.env`，然后修改以下值：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DOCKERHUB_IMAGE` | 是 | 完整镜像地址，例如 `docker.io/example/portico-sync:0.1.0` |
| `PORTICO_SYNC_TOKEN_SECRET` | 是 | 随机生成的长期密钥，至少 32 字节；不要提交到 Git |
| `PORTICO_SYNC_BIND_ADDRESS` | 否 | 宿主机绑定地址，默认 `127.0.0.1` |
| `PORTICO_SYNC_HOST_PORT` | 否 | 宿主机端口，默认 `8787` |
| `PORTICO_SYNC_TRUST_PROXY` | 否 | 仅当可信反向代理会覆盖 `X-Forwarded-For` 时设为 `true` |

## 环境就绪后的步骤

- 已安装 Docker Engine 或 Docker Desktop，并确认 Docker Compose 可用。
- 已创建 Docker Hub 仓库，例如 `portico-sync`。
- 已执行 `docker login`，登录账号需要对目标仓库有推送权限。
- 生产环境建议准备 HTTPS 反向代理。同步服务本身只提供 HTTP，不负责 TLS。

### 构建并推送镜像

在仓库根目录执行。将 `your-dockerhub-username` 替换为自己的 Docker Hub 用户名：

```powershell
$env:DOCKERHUB_IMAGE = "docker.io/your-dockerhub-username/portico-sync:latest"
docker login
docker build -f server/Dockerfile -t $env:DOCKERHUB_IMAGE server
docker push $env:DOCKERHUB_IMAGE
```

建议同时推送不可变版本标签，便于回滚：

```powershell
$env:DOCKERHUB_IMAGE = "docker.io/your-dockerhub-username/portico-sync:0.1.0"
docker build -f server/Dockerfile -t $env:DOCKERHUB_IMAGE server
docker push $env:DOCKERHUB_IMAGE
```

如果使用版本标签部署，只需在部署机的环境文件中将 `DOCKERHUB_IMAGE` 改为对应标签。

### Compose 部署

复制环境变量模板，填写镜像地址和随机密钥。不要把包含真实密钥的文件提交到 Git：

```powershell
Copy-Item deploy/portico-sync.env.example deploy/portico-sync.env
```

生成随机密钥并写入 `deploy/portico-sync.env`，或手动设置至少 32 字节的随机值：

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

启动、检查状态和查看日志：

```powershell
docker compose --env-file deploy/portico-sync.env pull
docker compose --env-file deploy/portico-sync.env up -d
docker compose --env-file deploy/portico-sync.env ps
docker compose --env-file deploy/portico-sync.env logs -f portico-sync
```

健康检查应返回 `{"status":"ok"}`：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/healthz | Select-Object -ExpandProperty Content
```

桌面端的云同步地址填写部署后的 HTTPS 地址，例如 `https://sync.example.com`。如果不使用反向代理，可在环境文件中将 `PORTICO_SYNC_BIND_ADDRESS` 改为 `0.0.0.0`，但不建议直接将 HTTP 服务暴露到公网。

### 更新与回滚

修改 `DOCKERHUB_IMAGE` 为新标签后重新拉取并启动：

```powershell
docker compose --env-file deploy/portico-sync.env pull
docker compose --env-file deploy/portico-sync.env up -d
```

回滚时改回旧标签，再执行相同命令。SQLite 数据保存在 Docker volume `portico-sync-data` 中，更新和重建容器不会丢失数据。

## 备份与安全

- 定期备份 `portico-sync-data` 中的 `portico-sync.sqlite` 文件。
- `PORTICO_SYNC_TOKEN_SECRET` 必须长期保持不变；更换后所有现有登录令牌都会失效。
- 不要将 `deploy/portico-sync.env`、数据库文件或 Docker Hub 凭据提交到仓库。
- 仅在反向代理可信且会覆盖 `X-Forwarded-For` 时设置 `PORTICO_SYNC_TRUST_PROXY=true`。
- 镜像使用非 root 用户运行，数据目录为 `/data`。

## 桌面端配置

服务可用后，在 Portico SSH 的“设置 → 云端同步”中填写：

- 本机测试：`http://127.0.0.1:8787`
- 生产环境：反向代理提供的 HTTPS 地址，例如 `https://sync.example.com`

同步服务不会解密桌面端上传的应用快照或密钥备份。应用快照使用本机 `~/.porticossh/sync.key` 加密；用户也可以在“云端同步”设置中用自定义口令单独加密备份 `~/.porticossh/*.key`，用于新设备恢复。自定义口令不会上传，遗忘后服务端无法恢复密钥备份。
