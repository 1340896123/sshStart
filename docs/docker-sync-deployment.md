# Docker Hub 与 Compose 部署

本文用于构建 `server/` 中的 Portico SSH 云同步服务镜像，并通过 Docker Compose 部署。

## 前置条件

- 已安装 Docker Engine 或 Docker Desktop，并确认 `docker info` 可以正常返回。
- 已创建 Docker Hub 仓库，例如 `portico-sync`。
- 已执行 `docker login`，登录账号需要对目标仓库有推送权限。
- 生产环境建议准备 HTTPS 反向代理。同步服务本身只提供 HTTP，不负责 TLS。

## 构建并推送

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

## Compose 部署

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

## 更新与回滚

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
