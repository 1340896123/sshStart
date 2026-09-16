# 安全与可靠性修复记录

## 第一批（2026-09-16）

本批处理数据丢失、目标服务器错绑和关键安全边界，并补充相邻的请求竞态与终端清理修复。

| 问题 | 当前行为 |
| --- | --- |
| 服务器配置编辑后会话错绑 | 会话、文件/进程/容器/AI 面板以及传输重试使用原连接配置快照。服务器列表使用新配置；打开连接时只复用配置相同的会话。 |
| 初始化覆盖用户操作 | 本地加载与初始同步完成之前不开放编辑；本地数据库读取失败时显示错误和重试入口，不保存空数据。 |
| 编辑器忽略 revision | 保存必须提供读取时的大小、mtime 和 SHA-256；写临时文件前及提交前检查冲突。本地保存串行化。 |
| 保存期间新增输入丢失 | 保存返回只更新已提交内容的基线；后续输入继续显示未保存。旧文件的加载/保存结果不能覆盖新文件。各编辑器使用独立 Monaco model。 |
| 替换文件先删除原件 | 优先 SFTP 覆盖重命名；普通 SFTP v3 无法覆盖时，通过同一 SSH 连接执行 coreutils/BusyBox `mv -fT --` 替换同目录临时文件。两种方法均失败时保留原文件，不使用 unlink 降级。 |
| SSH 命令输出阻塞/无限读取 | 非阻塞交替读取 stdout/stderr；普通命令默认 60 秒、合计 8 MiB 输出上限。AI 命令按设置执行，超时范围限制为 5–3600 秒。 |
| 取消命令 | 普通 `run_ssh_command` 可传 `operationId`，由 `cancel_ssh_command` 取消。通过统一执行器运行的 AI 命令随运行取消/异步调用丢弃而通知 SSH worker 关闭通道。 |
| 首次 SSH 连接自动信任 | 身份认证前使用原生对话框展示 SHA-256 指纹，明确确认后才写入 OpenSSH known_hosts。已知密钥变化继续拒绝，不提供覆盖按钮；跳板机和目标机均校验。 |
| 非本机 HTTP 同步泄露认证数据 | HTTP 仅接受 localhost/回环 IP；其他地址必须 HTTPS。禁止自动跟随重定向，避免认证请求正文随重定向泄露。显式记录 10 秒连接、30 秒请求超时。 |
| AI 审批参数替换 | IPC 只接收审批 ID、决定和拒绝原因；执行后端持有的原始调用，不再从前端重写工具参数。 |
| AI 任意文件/日志读取 | 请求批准和审核模式下，`read_file`、`log_analyzer` 都进入审批；完全访问模式仍尊重明确授权。审批针对远端读取及发送给 AI 服务。 |
| 清空凭据无效 | `null`/缺省保持原值，显式空字符串删除凭据，非空字符串原样保存（不再 trim 密码）；主机与跳板机均适用。 |
| 终端残留/启动竞态 | 在连接前原子预留会话，失败或 worker 退出后清理；旧 worker 不能移除新连接。退出事件携带连接代次，前端忽略旧连接的迟到通知。 |
| 文件/系统列表迟到响应 | 每次请求校验代次、服务器和当前视图；旧响应不能覆盖新列表、错误或 loading 状态。 |
| 可预测部署密钥 | 服务端启动拒绝已知示例密钥，示例环境文件默认留空，必须生成随机值。 |
| 部署模板不一致 | systemd 默认数据库放入 `/var/lib/portico-sync` 并创建状态目录；Caddy 示例上游统一为默认 8787。实际部署仍可通过环境配置使用其他端口。 |

## 验证

```powershell
npm run build
npm run test:workspace
npm run test:ai
npm run test:sync
npm run sync-server:test
$env:RUSTUP_TOOLCHAIN = "1.97.1"
$env:CARGO_INCREMENTAL = "0"
$env:RUSTFLAGS = "-C lto=off -C embed-bitcode=no"
cargo check --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

可选的真实 SSH/SFTP 协议测试需要 Python 和 Paramiko，通过临时回环服务运行，无需生产凭据，不读写用户的 known_hosts，不执行外部 shell 命令。测试覆盖超过 SSH 窗口大小的 3 MiB stderr、stdout 完整性、输出上限、超时、取消、SFTP v3 覆盖回退及大小/mtime 相同但内容变化的版本冲突：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib loopback_ssh_handles -- --ignored
```

`PORTICO_TEST_PYTHON` 可指定安装了 Paramiko 的 Python 可执行文件。原有连接真实跳板机的测试仍单独忽略，需要用户指定测试环境。

## 边界与后续批次

- SFTP 标准接口没有跨客户端的原子 compare-and-swap。提交前的 SHA-256 校验能拦截已发生的修改，但不能彻底消除外部程序在最后一次检查和重命名之间写入的极短窗口；没有宣称提供跨客户端事务锁。
- 关闭 SSH 通道不能保证终止已经脱离会话的远端进程。`background_task` 的任务归属、停止语义、并发/时长/日志配额需要独立处理；本批不把后台任务强制绑定窗口关闭。
- 首次主机信任仍需要用户通过可信渠道核对指纹。新增主机对话框的原生 UI 交互未自动化验证；底层接受/拒绝/密钥变化逻辑已有测试。
- 待修：AI 会话删除 tombstone 与冲突版本、解密快照 schema 校验、AI 历史敏感内容保留策略、同步服务注册/磁盘配额、本地密钥权限、renderer 本地文件授权范围、依赖公告升级。
- 本批修改代码及部署模板；未修改正在运行的部署、未发布安装包。

## 参考实现

- OpenSSH 主机信任与指纹确认：[sshconnect.c](https://github.com/openssh/openssh-portable/blob/master/sshconnect.c)。
- libssh2 非阻塞命令读取与 EAGAIN 重试：[ssh2_exec.c](https://github.com/libssh2/libssh2/blob/master/example/ssh2_exec.c)。
- 实现使用现有 SSH/SFTP、OpenSSH known_hosts、HTTPS 和操作系统原生命令，未引入自定义传输协议。
