import { useState } from "react";
import { Eye, EyeOff, KeyRound, Network, Server, Trash2, X } from "lucide-react";
import { uid } from "../lib";
import type { ServerProfile } from "../types";

interface Props {
  server?: ServerProfile;
  initialGroup?: string;
  onClose: () => void;
  onSave: (server: ServerProfile) => void | Promise<void>;
  onDelete?: () => void;
}

export function ServerDialog({ server, initialGroup, onClose, onSave, onDelete }: Props) {
  const [value, setValue] = useState<ServerProfile>(server ?? {
    id: uid("server"),
    name: "",
    group: initialGroup ?? "个人服务器",
    host: "",
    port: 22,
    username: "root",
    authType: "password",
    password: "",
    color: "var(--accent)",
    jumpHost: {
      enabled: false,
      host: "",
      port: 22,
      username: "root",
      authType: "password",
      password: "",
    },
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showJumpPassword, setShowJumpPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof ServerProfile>(key: K, next: ServerProfile[K]) =>
    setValue((current) => ({ ...current, [key]: next }));
  const setJump = <K extends keyof NonNullable<ServerProfile["jumpHost"]>>(key: K, next: NonNullable<ServerProfile["jumpHost"]>[K]) =>
    setValue((current) => ({
      ...current,
      jumpHost: {
        enabled: false,
        host: "",
        port: 22,
        username: "root",
        authType: "password",
        ...current.jumpHost,
        [key]: next,
      },
    }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const host = value.host.trim();
      if (!host) throw new Error("请输入主机地址");
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("主机端口无效");
      if (value.jumpHost?.enabled) {
        if (!value.jumpHost.host.trim()) throw new Error("请输入跳板机地址");
        if (!Number.isInteger(value.jumpHost.port) || value.jumpHost.port < 1 || value.jumpHost.port > 65535) throw new Error("跳板机端口无效");
        if (!value.jumpHost.username.trim()) throw new Error("请输入跳板机用户名");
        if (value.jumpHost.authType === "key" && !value.jumpHost.privateKeyPath?.trim()) throw new Error("请输入跳板机私钥路径");
      }
      await onSave({ ...value, host, name: value.name.trim() || host, jumpHost: value.jumpHost?.enabled ? { ...value.jumpHost, host: value.jumpHost.host.trim() } : value.jumpHost });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog server-dialog" onSubmit={submit}>
        <div className="dialog-header">
          <div className="dialog-icon"><Server size={17} /></div>
          <div><h2>{server ? "编辑服务器" : "添加服务器"}</h2><p>连接凭据由系统凭据库加密保存。</p></div>
          <button type="button" className="icon-button quiet" onClick={onClose} title="关闭"><X size={16} /></button>
        </div>

        <div className="form-grid">
          <label className="field span-2"><span>显示名称</span><input autoFocus value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="例如：生产环境 API" /></label>
          <label className="field"><span>分组</span><input value={value.group} onChange={(e) => set("group", e.target.value)} /></label>
          <label className="field"><span>用户名</span><input value={value.username} onChange={(e) => set("username", e.target.value)} required /></label>
          <label className="field host-field"><span>主机地址</span><input value={value.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.10" required /></label>
          <label className="field port-field"><span>端口</span><input type="number" min={1} max={65535} value={value.port} onChange={(e) => set("port", Number(e.target.value))} required /></label>
        </div>

        <div className="auth-section">
          <div className="section-caption"><KeyRound size={14} /><span>身份验证</span></div>
          <div className="segmented-control">
            <button type="button" className={value.authType === "password" ? "active" : ""} onClick={() => set("authType", "password")}>密码</button>
            <button type="button" className={value.authType === "key" ? "active" : ""} onClick={() => set("authType", "key")}>私钥</button>
          </div>
          {value.authType === "password" ? (
            <label className="field password-field"><span>密码</span><div className="input-with-action"><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={value.password ?? ""} onChange={(e) => set("password", e.target.value)} /><button type="button" onClick={() => setShowPassword((show) => !show)} title={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>
          ) : (
            <div className="form-grid">
              <label className="field span-2"><span>私钥路径</span><input value={value.privateKeyPath ?? ""} onChange={(e) => set("privateKeyPath", e.target.value)} placeholder="C:\\Users\\name\\.ssh\\id_ed25519" /></label>
              <label className="field span-2"><span>私钥口令（可选）</span><input type="password" autoComplete="current-password" value={value.passphrase ?? ""} onChange={(e) => set("passphrase", e.target.value)} /></label>
            </div>
          )}
        </div>

        <section className="jump-host-section">
          <label className="jump-host-toggle">
            <input type="checkbox" checked={Boolean(value.jumpHost?.enabled)} onChange={(event) => setJump("enabled", event.target.checked)} />
            <span className="toggle-track" aria-hidden="true"><span /></span>
            <span><strong>通过跳板机连接</strong><small>先连接跳板机，再访问目标服务器</small></span>
          </label>
          {value.jumpHost?.enabled && (
            <div className="jump-host-fields">
              <div className="section-caption"><Network size={14} /><span>跳板机配置</span></div>
              <div className="form-grid">
                <label className="field host-field"><span>跳板机地址</span><input value={value.jumpHost.host} onChange={(e) => setJump("host", e.target.value)} placeholder="202.104.115.238" required /></label>
                <label className="field port-field"><span>端口</span><input type="number" min={1} max={65535} value={value.jumpHost.port} onChange={(e) => setJump("port", Number(e.target.value))} required /></label>
                <label className="field"><span>用户名</span><input value={value.jumpHost.username} onChange={(e) => setJump("username", e.target.value)} required /></label>
              </div>
              <div className="jump-auth-row">
                <div className="segmented-control">
                  <button type="button" className={value.jumpHost.authType === "password" ? "active" : ""} onClick={() => setJump("authType", "password")}>密码</button>
                  <button type="button" className={value.jumpHost.authType === "key" ? "active" : ""} onClick={() => setJump("authType", "key")}>私钥</button>
                </div>
                {value.jumpHost.authType === "password" ? (
                  <label className="field password-field"><span>密码</span><div className="input-with-action"><input type={showJumpPassword ? "text" : "password"} autoComplete="current-password" value={value.jumpHost.password ?? ""} onChange={(e) => setJump("password", e.target.value)} /><button type="button" onClick={() => setShowJumpPassword((show) => !show)} title={showJumpPassword ? "隐藏密码" : "显示密码"}>{showJumpPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>
                ) : (
                  <div className="form-grid jump-key-fields"><label className="field"><span>私钥路径</span><input value={value.jumpHost.privateKeyPath ?? ""} onChange={(e) => setJump("privateKeyPath", e.target.value)} placeholder="C:\\Users\\name\\.ssh\\id_ed25519" required /></label><label className="field"><span>私钥口令（可选）</span><input type="password" autoComplete="current-password" value={value.jumpHost.passphrase ?? ""} onChange={(e) => setJump("passphrase", e.target.value)} /></label></div>
                )}
              </div>
            </div>
          )}
        </section>

        {error && <div className="dialog-inline-error">{error}</div>}
        <div className="dialog-footer">
          {onDelete && <button type="button" className="danger-button" onClick={() => confirm("删除这台服务器及其打开的会话？") && onDelete()}><Trash2 size={14} /> 删除</button>}
          <span className="footer-spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? "保存中…" : "保存并连接"}</button>
        </div>
      </form>
    </div>
  );
}
