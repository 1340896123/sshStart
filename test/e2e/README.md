# 文件编辑保存 E2E

Windows 下使用真实 WebView2、Tauri IPC、Rust SSH 客户端和本地 Paramiko SSH/SFTP 服务。
测试页面挂载生产 `FilePane` / `FileEditor` / Monaco，不替换 `invoke`。
本地服务提供确定的 Unix 权限、所有者、符号链接和故障注入；不访问生产服务器。

## 运行

```powershell
rustup toolchain install 1.97.1 --profile minimal
cargo +1.97.1 install tauri-driver --locked
python -m pip install -r test/e2e/requirements.txt
npm run test:e2e:files
```

Selenium 自动定位或下载匹配 Microsoft Edge 的 WebDriver。测试使用独立的
`com.portico.ssh.e2e` 应用标识和本地回环地址，结束时清理本次测试的主机密钥记录。
若本项目的 Vite 已在 1420 端口运行，则复用；否则启动并在结束后关闭。

```powershell
npm run test:files
python test/e2e/file_editor_e2e.py --skip-build --failfast
```

`--skip-build` 仅用于已经按 `test/e2e/tauri.conf.json` 构建过的调试程序。
原有 Windows Rust 单测程序缺少 Common Controls v6 manifest 时会以
`STATUS_ENTRYPOINT_NOT_FOUND` 退出；可用 Windows SDK 的 `mt.exe` 将应用的
manifest 嵌入单测程序后运行，桌面应用和上述 E2E 不受影响。

## 覆盖范围

- 双击打开、按钮保存、Ctrl+S、关闭后重新打开验证远端内容。
- 不同服务器同路径、同服务器不同会话的编辑器隔离。
- 保存期间继续编辑、服务器名称变化保持未保存内容。
- 相同大小及修改时间的内容冲突、上传临时文件之后的冲突。
- 写入中途失败、提交失败及重试、文件属性设置失败保留原文件。
- 符号链接实际目标更新，权限、所有者及用户组保留，临时文件以 0600 创建。
- 拒绝非 UTF-8 文本、保留 UTF-8 BOM、含引号及 URI 特殊字符的文件名。

结果与截图位于 `output/file-editor-e2e/`。同目录的 `result.json` 记录测试数量和结果。
测试配置与页面不参与生产前端构建。

## 保存行为

打开的文档绑定打开时的服务器连接。修改服务器的名称或分组不会重新读取文件；
修改连接地址后，应关闭原文档并在新连接中重新打开。
保存检查路径、大小、修改时间及 SHA-256，上传之后再次校验，并串行提交同一目标。
符号链接指向的目标变化也视为冲突。SFTP v3 不支持覆盖时使用同目录 `mv` 替换；
不支持该命令的服务器会明确保存失败并保留原文件。
这些检查无法锁住远端其他进程在最后一次校验与替换之间的写入。
