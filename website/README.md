# sshStar 产品官网

线上地址：**https://sshstar.123756.xyz/**

独立的 Vite + TypeScript 静态官网。产品介绍、下载链接、FAQ 和 SEO 元数据直接输出到 HTML，关闭 JavaScript 仍可阅读和下载；脚本只负责移动导航、界面预览切换和复制校验值。无需运行 Node 服务，也不依赖在线字体或第三方脚本。

## 本地开发

使用 Node.js 22.12+ 或 Node.js 24，以及 npm。在仓库根目录执行：

```powershell
npm --prefix website ci
npm run dev:website
```

访问 http://127.0.0.1:4321/。也可以单独在 `website/` 执行 `npm ci` 和 `npm run dev`。

## 安装包与构建

```powershell
npm --prefix website run release:sync
npm run build:website
npm run preview:website
```

同步脚本读取仓库最新稳定 GitHub Release，下载 EXE、MSI 和校验文件，同时校验 GitHub asset digest、SHA256SUMS.txt、文件大小与实际 SHA-256。已验证的缓存会复用。安装包放在被 Git 忽略的 `website/public/downloads/`，随构建复制到 `website/dist/downloads/`。

构建使用 `src/release.json` 注入版本、发布日期、文件大小、下载路径和校验值，生成 `/release.json` 供部署校验。页面无需在访客端请求 GitHub API。

发布新桌面版本时，先更新 `src/release.json` 的版本以及 `index.html` 中的更新说明，再运行同步脚本。脚本发现最新 Release 与官网版本不一致时会停止，避免显示旧更新日志却下载新安装包。

## fwd 部署

先在 Cloudflare 添加 DNS 记录：`sshstar`，类型 `A`，地址 `120.24.235.17`，选择“仅 DNS”。Caddy 会自动申请证书并重定向 HTTP 到 HTTPS。

```powershell
npm run deploy:website
```

默认使用本机 SSH 别名 `fwd`。脚本会安装官网依赖、同步并校验安装包、构建、打包上传，然后执行远端部署。若安装包已同步，可直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/deploy-website.ps1 -SkipReleaseSync
```

服务器目录：

- `/var/www/sshstar/releases/<UTC 时间>-<随机标识>/`：各次完整网站发布。
- `/var/www/sshstar/current`：当前版本的符号链接。
- `/etc/caddy/sshstar-website.Caddyfile`：该域名的独立配置。
- `/var/backups/sshstar-website/<发布标识>/`：原 Caddy 配置与前一版本目标。

部署程序先校验上传内容及安装包，再验证 Caddy 候选配置，原子切换站点目录并无中断重载。现有 Caddy 主配置只追加一次官网配置的 `import`。配置验证或重载失败时恢复原配置和站点链接。历史发布和备份会保留，供检查和回滚。

回滚只需将 `current` 原子切换到已知的历史版本；无需重载 Caddy：

```bash
# 将 <release-id> 替换成 /var/www/sshstar/releases 中实际存在的版本
ln -s /var/www/sshstar/releases/<release-id> /var/www/sshstar/current.rollback
mv -Tf /var/www/sshstar/current.rollback /var/www/sshstar/current
```

## 界面素材与验证

`public/images/` 的 WebP 图片来自桌面项目浏览器预览，使用 `192.0.2.10` 示例服务器地址，不包含真实凭据。`social.png` 是社交分享封面。品牌图标沿用桌面项目的 `public/favicon.svg`。

部署后检查首页、三个预览标签、手机导航、FAQ、EXE/MSI 下载、SHA-256、404、HTTP 到 HTTPS 重定向。构建和部署命令不修改桌面应用版本，也不创建新的桌面 Release。

启动 `npm run preview:website` 后，可使用已安装 Python Playwright 与 Edge 的环境运行 `npm run test:e2e:website`。对线上站点运行 `python test/e2e/website_e2e.py https://sshstar.123756.xyz`。测试覆盖响应式布局、键盘操作、手机导航、FAQ、复制校验值、无 JavaScript 浏览，以及实际下载安装包后的大小和 SHA-256 校验。
