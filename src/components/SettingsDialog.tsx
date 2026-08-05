import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Bot,
  Check,
  CircleAlert,
  Cloud,
  Container,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileCode2,
  FilePenLine,
  FolderTree,
  Gauge,
  KeyRound,
  ListTree,
  LogIn,
  LogOut,
  Network,
  Play,
  RefreshCw,
  Save,
  Search,
  ScrollText,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Upload,
  UserPlus,
  Wrench,
  X,
} from "lucide-react";
import { isTauri } from "../lib";
import { getCloudSyncStatus, loginCloudSync, logoutCloudSync, registerCloudSync, type CloudSyncStatus } from "../storage";
import { DEFAULT_AI_TOOL_SETTINGS, normalizeAiConfig, type AiConfig, type AiToolKey } from "../types";

interface Props {
  config: AiConfig;
  onSave: (config: AiConfig) => void | Promise<void>;
  onRemoveSavedKey: () => void | Promise<void>;
  onClose: () => void;
}

const TOOL_GROUPS: Array<{
  title: string;
  description: string;
  icon: typeof SquareTerminal;
  tools: Array<{ key: AiToolKey; label: string; description: string; icon: typeof SquareTerminal; write?: boolean }>;
}> = [
  {
    title: "终端与命令",
    description: "让助手读取状态、执行命令和处理交互提示。",
    icon: SquareTerminal,
    tools: [
      { key: "executeCommand", label: "单条命令", description: "执行 Shell 并返回 stdout、stderr 和退出码。", icon: Play },
      { key: "backgroundTask", label: "后台作业", description: "启动长时任务并返回后台 PID。", icon: Activity },
      { key: "ptyInteraction", label: "交互式终端", description: "向需要输入的命令传入一次性响应。", icon: KeyRound, write: true },
    ],
  },
  {
    title: "文件与 SFTP",
    description: "使用结构化文件工具处理远端目录和传输。",
    icon: FolderTree,
    tools: [
      { key: "readFile", label: "读取文件", description: "按路径读取远端文本内容。", icon: FileCode2 },
      { key: "writeFile", label: "写入文件", description: "覆写远端文件，默认关闭。", icon: FilePenLine, write: true },
      { key: "sftpUpload", label: "SFTP 上传", description: "从本机上传文件到远端，默认关闭。", icon: Upload, write: true },
      { key: "sftpDownload", label: "SFTP 下载", description: "把远端文件下载到本机。", icon: Download },
      { key: "listDirectory", label: "目录列表", description: "读取目录树和文件元数据。", icon: ListTree },
    ],
  },
  {
    title: "诊断与服务",
    description: "把常用运维检查封装为可控的结构化工具。",
    icon: Gauge,
    tools: [
      { key: "getSystemMetrics", label: "系统指标", description: "CPU、内存、磁盘、网络和 GPU。", icon: Gauge },
      { key: "processManager", label: "进程管理", description: "检索高占用进程并按需发信号。", icon: Activity, write: true },
      { key: "networkChecker", label: "网络诊断", description: "端口、连接、网卡和连通性检查。", icon: Network },
      { key: "dockerManager", label: "Docker 管理", description: "容器、镜像和容器日志。", icon: Container, write: true },
      { key: "systemdControl", label: "systemd 服务", description: "查看服务状态、日志和生命周期。", icon: ServerCog, write: true },
      { key: "logAnalyzer", label: "日志分析", description: "抓取错误日志交给模型归因。", icon: ScrollText },
    ],
  },
  {
    title: "安全与知识",
    description: "在执行前评估风险，并复用经过整理的片段。",
    icon: ShieldCheck,
    tools: [
      { key: "riskChecker", label: "高危拦截", description: "识别删除、格式化、防火墙等危险动作。", icon: CircleAlert },
      { key: "snippetLibrary", label: "代码片段库", description: "提供常用的只读运维命令模板。", icon: FileCode2 },
    ],
  },
];

type SettingsSection = "model" | "agent" | "tools" | "transfer" | "server-data" | "security" | "cloud-sync";
type ModelPickerTarget = "agent" | "reviewer";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Bot;
}> = [
  { id: "model", label: "模型", description: "接口、密钥与模型能力", icon: Bot },
  { id: "agent", label: "Agent", description: "运行参数与系统提示词", icon: SlidersHorizontal },
  { id: "tools", label: "工具能力", description: "终端、诊断与服务工具", icon: Wrench },
  { id: "transfer", label: "文件传输", description: "文件系统与 SFTP 权限", icon: Upload },
  { id: "server-data", label: "导入导出", description: "服务器列表与密钥策略", icon: Download },
  { id: "security", label: "安全策略", description: "高危拦截与变更边界", icon: ShieldCheck },
  { id: "cloud-sync", label: "云端同步", description: "登录、加密与自动同步", icon: Cloud },
];

export function SettingsDialog({ config, onSave, onRemoveSavedKey, onClose }: Props) {
  const [value, setValue] = useState(() => normalizeAiConfig(config));
  const [savedValue, setSavedValue] = useState(() => normalizeAiConfig(config));
  const [models, setModels] = useState<string[]>([]);
  const [modelPickerTarget, setModelPickerTarget] = useState<ModelPickerTarget>();
  const [modelSearch, setModelSearch] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [error, setError] = useState("");
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>();
  const [syncEmail, setSyncEmail] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection>("model");
  const [navSearch, setNavSearch] = useState("");
  const modelPickerOpen = Boolean(modelPickerTarget);
  const selectedPickerModel = modelPickerTarget === "reviewer" ? value.reviewerModel : value.model;
  const isDirty = JSON.stringify(value) !== JSON.stringify(savedValue);

  useEffect(() => {
    if (!isTauri()) return;
    void getCloudSyncStatus().then(setSyncStatus).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const authenticateSync = async (mode: "login" | "register") => {
    setSyncBusy(true);
    setError("");
    try {
      const result = mode === "register"
        ? await registerCloudSync(value.cloudSync.endpoint, syncEmail, syncPassword)
        : await loginCloudSync(value.cloudSync.endpoint, syncEmail, syncPassword);
      setSyncStatus((current) => ({ ...(current ?? { keyPath: "" }), authenticated: true, email: result.email }));
      setSyncPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSyncBusy(false);
    }
  };

  const logoutSync = async () => {
    setSyncBusy(true);
    setError("");
    try {
      await logoutCloudSync();
      setSyncStatus((current) => ({ ...(current ?? { keyPath: "" }), authenticated: false, email: undefined }));
      const nextValue = normalizeAiConfig({ ...value, cloudSync: { ...value.cloudSync, enabled: false } });
      await onSave(nextValue);
      setValue(nextValue);
      setSavedValue(nextValue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSyncBusy(false);
    }
  };

  const loadModels = async () => {
    setLoadingModels(true);
    setError("");
    try {
      if (!isTauri()) throw new Error("模型列表仅可在桌面应用中获取");
      const nextModels = await invoke<string[]>("list_rig_models", { config: value });
      setModels(nextModels);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingModels(false);
    }
  };

  const openModelPicker = async (target: ModelPickerTarget) => {
    setModelPickerTarget(target);
    setModelSearch("");
    await loadModels();
  };

  const save = async () => {
    if (!isDirty) return;
    if (!value.endpoint.trim()) {
      setError("请填写接口地址");
      return;
    }
    if (!value.model.trim()) {
      setError("请填写或选择模型");
      return;
    }
    if (!Number.isInteger(value.contextWindow) || value.contextWindow < 1) {
      setError("上下文大小需为正整数");
      return;
    }
    if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 256) {
      setError("输出长度需为不小于 256 的整数");
      return;
    }
    if (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) {
      setError("温度需在 0–2 之间");
      return;
    }
    if (!Number.isInteger(value.tools.maxToolRounds) || value.tools.maxToolRounds < 1) {
      setError("工具调用轮数需为不小于 1 的整数");
      return;
    }
    if (!Number.isInteger(value.tools.maxOutputChars) || value.tools.maxOutputChars < 1) {
      setError("工具输出上限需为正整数");
      return;
    }
    if (!Number.isInteger(value.tools.commandTimeoutSeconds) || value.tools.commandTimeoutSeconds < 5) {
      setError("命令超时需为不小于 5 秒的整数");
      return;
    }
    if (value.cloudSync.enabled && !value.cloudSync.endpoint.trim()) {
      setError("启用同步前请填写同步服务地址");
      return;
    }
    if (value.cloudSync.enabled && !syncStatus?.authenticated) {
      setError("启用同步前请先登录或注册同步账号");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nextValue = normalizeAiConfig({
        ...value,
        endpoint: value.endpoint.trim(),
        apiKey: value.apiKey.trim(),
        model: value.model.trim(),
        reviewerModel: value.reviewerModel.trim(),
        tools: { ...DEFAULT_AI_TOOL_SETTINGS, ...value.tools },
      });
      await onSave(nextValue);
      setValue(nextValue);
      setSavedValue(nextValue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeSavedKey = async () => {
    setRemovingKey(true);
    setError("");
    try {
      await onRemoveSavedKey();
      setValue((current) => ({ ...current, apiKey: "" }));
      setSavedValue((current) => ({ ...current, apiKey: "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRemovingKey(false);
    }
  };

  const enabledToolCount = TOOL_GROUPS
    .flatMap((group) => group.tools)
    .filter((tool) => value.tools[tool.key]).length;
  const busy = saving || removingKey;
  const visibleSections = SETTINGS_SECTIONS.filter((section) => {
    const query = navSearch.trim().toLocaleLowerCase();
    return !query || `${section.label} ${section.description}`.toLocaleLowerCase().includes(query);
  });
  const visibleActiveSection = visibleSections.some((section) => section.id === activeSection)
    ? activeSection
    : visibleSections[0]?.id;
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === visibleActiveSection);

  useEffect(() => {
    if (!visibleSections.some((section) => section.id === activeSection) && visibleSections[0]) {
      setActiveSection(visibleSections[0].id);
    }
  }, [activeSection, visibleSections]);

  const renderToolGroup = (group: (typeof TOOL_GROUPS)[number]) => {
    const GroupIcon = group.icon;
    const enabledCount = group.tools.filter((tool) => value.tools[tool.key]).length;
    return (
      <section className="settings-tool-group" key={group.title}>
        <div className="settings-tool-group-header">
          <span className="settings-tool-group-icon"><GroupIcon size={15} /></span>
          <span><strong>{group.title}</strong><small>{group.description}</small></span>
          <em>{enabledCount}/{group.tools.length}</em>
        </div>
        <div className="settings-tool-grid">
          {group.tools.map((tool) => {
            const ToolIcon = tool.icon;
            return (
              <label className={`tool-permission ${tool.write ? "write-tool" : ""}`} key={tool.key}>
                <span className="tool-permission-icon"><ToolIcon size={14} /></span>
                <span className="tool-permission-copy"><strong>{tool.label}</strong><small>{tool.description}</small></span>
                <input type="checkbox" checked={value.tools[tool.key]} onChange={(event) => setValue({ ...value, tools: { ...value.tools, [tool.key]: event.target.checked } })} />
                <span className="switch" aria-hidden="true" />
              </label>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="settings-backdrop">
      <form className="settings-workspace" role="dialog" aria-modal="true" aria-labelledby="settings-page-title" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => { if (event.key === "Escape") { if (modelPickerOpen) setModelPickerTarget(undefined); else if (!busy && (!isDirty || window.confirm("设置有未保存的修改，确定要退出吗？"))) onClose(); } }}>
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <span className="settings-brand-mark"><Bot size={17} /></span>
            <span><strong>Portico</strong><small>AI 设置</small></span>
            <button className="icon-button quiet" type="button" disabled={busy} onClick={() => { if (!isDirty || window.confirm("设置有未保存的修改，确定要退出吗？")) onClose(); }} title="关闭设置" aria-label="关闭设置"><X size={16} /></button>
          </div>

          <label className="settings-search">
            <Search size={14} />
            <input value={navSearch} onChange={(event) => setNavSearch(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
          </label>

          <nav className="settings-nav" aria-label="设置分类">
            {visibleSections.map((section) => {
              const SectionIcon = section.icon;
              return (
                <button
                  className={`settings-nav-button ${activeSection === section.id ? "active" : ""}`}
                  type="button"
                  key={section.id}
                  aria-current={activeSection === section.id ? "page" : undefined}
                  onClick={() => setActiveSection(section.id)}
                >
                  <SectionIcon size={16} />
                  <span><strong>{section.label}</strong><small>{section.description}</small></span>
                  {section.id === "tools" && <em>{enabledToolCount}</em>}
                </button>
              );
            })}
            {visibleSections.length === 0 && <p className="settings-nav-empty">没有匹配的设置</p>}
          </nav>

          <div className="settings-sidebar-footer">
            {error && <div className="settings-save-error" role="alert"><CircleAlert size={13} /><span>{error}</span></div>}
            {isDirty && <div className="settings-save-pending" role="status"><CircleAlert size={13} /><span>有未保存的修改</span></div>}
            <button className={`settings-save-button ${isDirty ? "" : "clean"}`} type="submit" disabled={busy || !isDirty}>
              {saving ? <RefreshCw className="spinning" size={15} /> : <Save size={15} />}
              {saving ? "保存中…" : isDirty ? "保存设置" : "已保存"}
            </button>
          </div>
        </aside>

        <main className="settings-page">
          <header className="settings-page-header">
            {activeSectionMeta ? (
              <div>
                <span>{visibleActiveSection === "server-data" || visibleActiveSection === "cloud-sync" ? "服务器设置" : "AI 配置"}</span>
                <h2 id="settings-page-title">{activeSectionMeta.label}</h2>
                <p>{activeSectionMeta.description}</p>
              </div>
            ) : (
              <div>
                <span>AI 配置</span>
                <h2 id="settings-page-title">没有匹配的设置</h2>
                <p>尝试使用其他关键词搜索。</p>
              </div>
            )}
          </header>

          <div className="settings-page-scroll">
            {visibleActiveSection === "model" && (
              <>
                <section className="settings-panel">
                  <header><strong>模型服务</strong><small>配置 OpenAI 兼容的大语言模型接入；可选择 Chat Completions 或 Responses 接口</small></header>
                  <div className="settings-config-row">
                    <span className="settings-row-copy"><strong>Provider</strong><small>使用 Bearer API Key 的 OpenAI 兼容服务</small></span>
                    <span className="settings-static-value">OpenAI 兼容</span>
                  </div>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>接口模式</strong><small>Responses 使用 /responses 与类型化 SSE 事件；旧配置默认保持 Chat Completions</small></span>
                    <select className="settings-input settings-mono-input" value={value.apiMode} onChange={(event) => setValue({ ...value, apiMode: event.target.value as AiConfig["apiMode"] })}>
                      <option value="chat-completions">Chat Completions</option>
                      <option value="responses">Responses</option>
                    </select>
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>Base URL</strong><small>可填写 API 基础地址，也可填写当前模式的完整接口地址</small></span>
                    <input className="settings-input settings-mono-input" value={value.endpoint} onChange={(event) => setValue({ ...value, endpoint: event.target.value })} />
                  </label>
                  <div className="settings-config-row">
                    <label className="settings-row-copy" htmlFor="ai-api-key"><strong>API Key</strong><small>桌面端安全保存到系统凭据库，并在启动时自动恢复</small></label>
                    <span className="settings-secret-control">
                      <input id="ai-api-key" className="settings-input settings-mono-input" type={apiKeyVisible ? "text" : "password"} autoComplete="off" spellCheck={false} value={value.apiKey} onChange={(event) => setValue({ ...value, apiKey: event.target.value })} placeholder="sk-..." />
                      <button className="settings-secret-toggle" type="button" onClick={() => setApiKeyVisible((visible) => !visible)} aria-label={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"} aria-pressed={apiKeyVisible} title={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"}>
                        {apiKeyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </span>
                  </div>
                  <div className="settings-config-row">
                    <span className="settings-row-copy"><strong>移除已保存密钥</strong><small>从系统凭据库永久删除当前密钥；此操作不能通过清空输入框完成</small></span>
                    <button className="danger-button" type="button" disabled={busy} onClick={() => void removeSavedKey()}>
                      {removingKey ? <RefreshCw className="spinning" size={14} /> : <Trash2 size={14} />}
                      {removingKey ? "移除中…" : "移除已保存密钥"}
                    </button>
                  </div>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>Model</strong><small>{models.length > 0 ? `已获取 ${models.length} 个模型` : "支持手动输入模型名称"}</small></span>
                    <span className="settings-model-control">
                      <input className="settings-input settings-mono-input" value={value.model} onChange={(event) => setValue({ ...value, model: event.target.value })} placeholder="输入模型 ID" />
                      <button type="button" disabled={loadingModels} onClick={() => void openModelPicker("agent")}>
                        <RefreshCw className={loadingModels ? "spinning" : ""} size={14} />
                        {loadingModels ? "获取中" : "选择模型"}
                      </button>
                    </span>
                  </label>
                </section>

                <a className="settings-page-link" href={value.apiMode === "responses" ? "https://developers.openai.com/api/reference/resources/responses/methods/create" : "https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create"} target="_blank" rel="noreferrer">查看当前接口格式 <ExternalLink size={13} /></a>
              </>
            )}

            {visibleActiveSection === "agent" && (
              <>
                <section className="settings-panel">
                  <header><strong>Agent 运行参数</strong><small>由 Rig 管理多轮调用、工具循环和 provider 差异</small></header>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>最大上下文</strong><small>模型上下文预算；Portico 不额外限制可填写的上限</small></span>
                    <span className="settings-number-control"><input className="settings-input settings-mono-input" type="number" min={1} step={1} value={value.contextWindow} onChange={(event) => setValue({ ...value, contextWindow: Number(event.target.value) })} /><em>tokens</em></span>
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>输出长度</strong><small>单次回答最多生成的 tokens 数</small></span>
                    <span className="settings-number-control"><input className="settings-input settings-mono-input" type="number" min={256} step={1} value={value.maxOutputTokens} onChange={(event) => setValue({ ...value, maxOutputTokens: Number(event.target.value) })} /><em>tokens</em></span>
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>温度</strong><small>较低值更稳定，较高值更发散</small></span>
                    <span className="settings-range-control"><input type="range" min={0} max={2} step={0.1} value={value.temperature} onChange={(event) => setValue({ ...value, temperature: Number(event.target.value) })} /><output>{value.temperature.toFixed(1)}</output></span>
                  </label>
                </section>
                <section className="settings-panel">
                  <header><strong>系统提示词</strong><small>定义助手在每个 SSH 会话中的角色与执行边界</small></header>
                  <label className="settings-prompt-field"><span className="sr-only">系统提示词</span><textarea rows={9} value={value.systemPrompt} onChange={(event) => setValue({ ...value, systemPrompt: event.target.value })} /></label>
                </section>
              </>
            )}

            {visibleActiveSection === "tools" && (
              <>
                <div className="settings-section-summary"><div><strong>工具权限</strong><small>只向模型暴露已启用的函数工具</small></div><span><ListTree size={14} /> {enabledToolCount}/{TOOL_GROUPS.flatMap((group) => group.tools).length}</span></div>
                <div className="settings-tool-groups">{TOOL_GROUPS.filter((_, index) => index === 0 || index === 2).map(renderToolGroup)}</div>
                <section className="settings-panel settings-policy-panel">
                  <header><strong>执行策略</strong><small>配置每次工具链的运行轮次、输出体积和命令超时</small></header>
                  <div className="tool-policy-grid">
                    <label className="field"><span>最大工具轮数 <small>每次请求</small></span><input type="number" min={1} step={1} value={value.tools.maxToolRounds} onChange={(event) => setValue({ ...value, tools: { ...value.tools, maxToolRounds: Number(event.target.value) } })} /></label>
                    <label className="field"><span>单轮输出上限 <small>字符</small></span><input type="number" min={1} step={1} value={value.tools.maxOutputChars} onChange={(event) => setValue({ ...value, tools: { ...value.tools, maxOutputChars: Number(event.target.value) } })} /></label>
                    <label className="field"><span>命令超时 <small>秒</small></span><input type="number" min={5} step={1} value={value.tools.commandTimeoutSeconds} onChange={(event) => setValue({ ...value, tools: { ...value.tools, commandTimeoutSeconds: Number(event.target.value) } })} /></label>
                  </div>
                </section>
              </>
            )}

            {visibleActiveSection === "transfer" && (
              <>
                <div className="settings-section-summary"><div><strong>文件与 SFTP</strong><small>控制模型可使用的远端文件和传输能力</small></div></div>
                <div className="settings-tool-groups">{renderToolGroup(TOOL_GROUPS[1])}</div>
              </>
            )}

            {visibleActiveSection === "server-data" && (
              <>
                <section className="settings-panel">
                  <header><strong>服务器导入</strong><small>从 JSON 文件批量创建服务器；文件中的分组信息会被保留</small></header>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>默认导入分组</strong><small>当记录没有提供分组时使用；留空则导入到未分组</small></span>
                    <input className="settings-input" value={value.serverImportExport.defaultImportGroup} onChange={(event) => setValue({ ...value, serverImportExport: { ...value.serverImportExport, defaultImportGroup: event.target.value } })} placeholder="例如：生产环境" />
                  </label>
                  <div className="settings-config-row">
                    <span className="settings-row-copy"><strong>支持的格式</strong><small>兼容 Portico 导出的文件，也接受服务器数组或包含 servers/data 数组的 JSON</small></span>
                    <span className="settings-static-value">JSON / Portico Server List</span>
                  </div>
                </section>
                <section className="settings-panel">
                  <header><strong>服务器导出</strong><small>导出当前列表或选定分组，便于备份和迁移</small></header>
                  <label className="mutating-tools-toggle">
                    <span className="tool-permission-icon"><KeyRound size={14} /></span>
                    <span className="tool-permission-copy"><strong>导出包含密钥和密码</strong><small>包含密码、跳板机口令和密钥口令；私钥文件本身不会复制到导出文件</small></span>
                    <input type="checkbox" checked={value.serverImportExport.includeSecretsInExport} onChange={(event) => setValue({ ...value, serverImportExport: { ...value.serverImportExport, includeSecretsInExport: event.target.checked } })} />
                    <span className="switch" aria-hidden="true" />
                  </label>
                </section>
                <div className="settings-note"><CircleAlert size={15} /><span>启用密钥导出后，生成的 JSON 会包含登录密码和口令。请只通过安全渠道传输，并在迁移完成后及时删除文件。</span></div>
              </>
            )}

            {visibleActiveSection === "security" && (
              <>
                <div className="settings-section-summary"><div><strong>安全与知识</strong><small>在执行前检查风险并复用经过整理的命令片段</small></div></div>
                <div className="settings-tool-groups">{renderToolGroup(TOOL_GROUPS[3])}</div>
                <section className="settings-panel">
                  <header><strong>审批审核模型</strong><small>供会话中的“替我审批”策略评估单次工具调用</small></header>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>审核模型</strong><small>复用主模型的接口模式、Base URL 与 API Key；未配置时只能人工审批</small></span>
                    <span className="settings-model-control">
                      <input className="settings-input settings-mono-input" value={value.reviewerModel} onChange={(event) => setValue({ ...value, reviewerModel: event.target.value })} placeholder="输入审核模型 ID" />
                      <button type="button" disabled={loadingModels} onClick={() => void openModelPicker("reviewer")}>
                        <RefreshCw className={loadingModels ? "spinning" : ""} size={14} />
                        {loadingModels ? "获取中" : "选择模型"}
                      </button>
                    </span>
                  </label>
                </section>
                <label className="mutating-tools-toggle"><span className="tool-permission-icon"><FilePenLine size={14} /></span><span className="tool-permission-copy"><strong>允许 Agent 请求变更</strong><small>开启后 Rig 可提出写入、上传、服务和进程操作；是否放行由当前会话的审批策略决定。</small></span><input type="checkbox" checked={value.tools.allowMutatingTools} onChange={(event) => setValue({ ...value, tools: { ...value.tools, allowMutatingTools: event.target.checked } })} /><span className="switch" aria-hidden="true" /></label>
                <div className="settings-note"><ShieldCheck size={15} /><span>审核模型返回无法解析的结果或请求失败时，Portico 会退回人工审批，不会默认放行。</span></div>
              </>
            )}

            {visibleActiveSection === "cloud-sync" && (
              <>
                <section className="settings-panel">
                  <header><strong>云端同步</strong><small>服务器列表和全部设置会在本地加密后再上传，云端永远只保存密文</small></header>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>同步服务地址</strong><small>填写团队或自建同步服务的 API 根地址</small></span>
                    <input className="settings-input settings-mono-input" value={value.cloudSync.endpoint} onChange={(event) => setValue({ ...value, cloudSync: { ...value.cloudSync, endpoint: event.target.value } })} placeholder="https://sync.example.com/api" />
                  </label>
                  <label className="mutating-tools-toggle">
                    <span className="tool-permission-icon"><Cloud size={14} /></span>
                    <span className="tool-permission-copy"><strong>开启自动同步</strong><small>保存服务器或设置后自动上传；启动时自动下载最新密文</small></span>
                    <input type="checkbox" checked={value.cloudSync.enabled} onChange={(event) => setValue({ ...value, cloudSync: { ...value.cloudSync, enabled: event.target.checked } })} />
                    <span className="switch" aria-hidden="true" />
                  </label>
                </section>
                <section className="settings-panel">
                  <header><strong>同步账号</strong><small>{syncStatus?.authenticated ? `已登录：${syncStatus.email ?? "当前账号"}` : "必须登录后才能开启同步"}</small></header>
                  {!syncStatus?.authenticated ? (
                    <>
                      <label className="settings-config-row"><span className="settings-row-copy"><strong>邮箱</strong><small>用于登录或注册同步账号</small></span><input className="settings-input" type="email" autoComplete="username" value={syncEmail} onChange={(event) => setSyncEmail(event.target.value)} placeholder="you@example.com" /></label>
                      <label className="settings-config-row"><span className="settings-row-copy"><strong>密码</strong><small>仅用于认证请求，不会写入本地状态</small></span><input className="settings-input" type="password" autoComplete="current-password" value={syncPassword} onChange={(event) => setSyncPassword(event.target.value)} placeholder="至少 8 位" /></label>
                      <div className="settings-action-row"><button className="secondary-button" type="button" disabled={syncBusy} onClick={() => void authenticateSync("login")}>{syncBusy ? <RefreshCw className="spinning" size={14} /> : <LogIn size={14} />}登录</button><button className="secondary-button" type="button" disabled={syncBusy} onClick={() => void authenticateSync("register")}>{syncBusy ? <RefreshCw className="spinning" size={14} /> : <UserPlus size={14} />}注册并登录</button></div>
                    </>
                  ) : (
                    <div className="settings-config-row"><span className="settings-row-copy"><strong>当前账号</strong><small>令牌保存在系统凭据库；加密密钥保存在 {syncStatus.keyPath || "~/.porticossh/"}</small></span><button className="danger-button" type="button" disabled={syncBusy} onClick={() => void logoutSync()}>{syncBusy ? <RefreshCw className="spinning" size={14} /> : <LogOut size={14} />}退出登录</button></div>
                  )}
                </section>
                <div className="settings-note"><KeyRound size={15} /><span>同步密钥由桌面端首次运行时生成并保存在 ~/.porticossh/sync.key。密钥不会上传；丢失密钥时云端密文无法恢复。</span></div>
              </>
            )}
          </div>
        </main>

        {modelPickerOpen && (
          <div className="model-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModelPickerTarget(undefined); }}>
            <section className="model-picker" role="dialog" aria-modal="true" aria-labelledby="model-picker-title">
              <header className="model-picker-header">
                <div><span>模型服务</span><h3 id="model-picker-title">{modelPickerTarget === "reviewer" ? "选择审核模型" : "选择模型"}</h3><small>{models.length > 0 ? `${models.length} 个模型可用` : "从当前接口读取模型列表"}</small></div>
                <button className="icon-button quiet" type="button" onClick={() => setModelPickerTarget(undefined)} title="关闭模型选择" aria-label="关闭模型选择"><X size={16} /></button>
              </header>
              <label className="model-picker-search"><Search size={14} /><input autoFocus value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="筛选模型 ID" aria-label="筛选模型 ID" /></label>
              <div className="model-picker-list" role="listbox" aria-label="可用模型">
                {models.filter((model) => model.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())).map((model) => (
                  <button className={`model-picker-option ${selectedPickerModel === model ? "selected" : ""}`} type="button" role="option" aria-selected={selectedPickerModel === model} key={model} onClick={() => { setValue(modelPickerTarget === "reviewer" ? { ...value, reviewerModel: model } : { ...value, model }); setModelPickerTarget(undefined); }}>
                    <span className="model-picker-option-icon"><Bot size={14} /></span><span>{model}</span>{selectedPickerModel === model && <Check size={14} />}
                  </button>
                ))}
                {models.length === 0 && !loadingModels && <div className="model-picker-empty"><CircleAlert size={16} /><span>没有可显示的模型，请检查接口地址和密钥，或直接在文本框输入模型 ID。</span></div>}
                {models.length > 0 && models.filter((model) => model.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())).length === 0 && <div className="model-picker-empty"><Search size={16} /><span>没有匹配的模型</span></div>}
              </div>
              <footer className="model-picker-footer"><span>当前选择</span><code>{selectedPickerModel || "未选择"}</code></footer>
            </section>
          </div>
        )}
      </form>
    </div>
  );
}
