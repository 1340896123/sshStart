import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Bot,
  Check,
  CircleAlert,
  Container,
  Download,
  ExternalLink,
  FileCode2,
  FilePenLine,
  FolderTree,
  Gauge,
  Image,
  KeyRound,
  ListTree,
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
  Upload,
  Wrench,
  X,
} from "lucide-react";
import { isTauri } from "../lib";
import { DEFAULT_AI_TOOL_SETTINGS, type AiConfig, type AiToolKey } from "../types";

interface Props {
  config: AiConfig;
  onSave: (config: AiConfig) => void | Promise<void>;
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

type SettingsSection = "model" | "agent" | "tools" | "transfer" | "security";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Bot;
}> = [
  { id: "model", label: "模型", description: "接口、密钥与模型能力", icon: Bot },
  { id: "agent", label: "Agent", description: "上下文与会话提示词", icon: SlidersHorizontal },
  { id: "tools", label: "工具能力", description: "终端、诊断与服务工具", icon: Wrench },
  { id: "transfer", label: "文件传输", description: "文件系统与 SFTP 权限", icon: Upload },
  { id: "security", label: "安全策略", description: "高危拦截与变更边界", icon: ShieldCheck },
];

export function SettingsDialog({ config, onSave, onClose }: Props) {
  const [value, setValue] = useState(() => ({
    ...config,
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    autoCompress: config.autoCompress ?? true,
    tools: { ...DEFAULT_AI_TOOL_SETTINGS, ...(config.tools ?? {}) },
  }));
  const [models, setModels] = useState<string[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSection>("model");
  const [navSearch, setNavSearch] = useState("");

  const loadModels = async () => {
    setLoadingModels(true);
    setError("");
    try {
      if (!isTauri()) throw new Error("模型列表仅可在桌面应用中获取");
      const nextModels = await invoke<string[]>("list_ai_models", { config: value });
      setModels(nextModels);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingModels(false);
    }
  };

  const openModelPicker = async () => {
    setModelPickerOpen(true);
    setModelSearch("");
    await loadModels();
  };

  const save = async () => {
    if (!value.endpoint.trim()) {
      setError("请填写接口地址");
      return;
    }
    if (!value.model.trim()) {
      setError("请填写或选择模型");
      return;
    }
    if (!Number.isInteger(value.contextWindow) || value.contextWindow < 1024 || value.contextWindow > 2000000) {
      setError("上下文大小需为 1,024–2,000,000 之间的整数");
      return;
    }
    if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 256 || value.maxOutputTokens > value.contextWindow) {
      setError("输出长度需为 256 到上下文大小之间的整数");
      return;
    }
    if (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) {
      setError("温度需在 0–2 之间");
      return;
    }
    if (!Number.isInteger(value.tools.maxToolRounds) || value.tools.maxToolRounds < 1 || value.tools.maxToolRounds > 12) {
      setError("工具调用轮数需为 1–12 之间的整数");
      return;
    }
    if (!Number.isInteger(value.tools.maxOutputChars) || value.tools.maxOutputChars < 1000 || value.tools.maxOutputChars > 100000) {
      setError("工具输出上限需为 1,000–100,000 字符之间的整数");
      return;
    }
    if (!Number.isInteger(value.tools.commandTimeoutSeconds) || value.tools.commandTimeoutSeconds < 5 || value.tools.commandTimeoutSeconds > 300) {
      setError("命令超时需为 5–300 秒之间的整数");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...value,
        endpoint: value.endpoint.trim(),
        apiKey: value.apiKey.trim(),
        model: value.model.trim(),
        tools: { ...DEFAULT_AI_TOOL_SETTINGS, ...value.tools },
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const enabledToolCount = TOOL_GROUPS
    .flatMap((group) => group.tools)
    .filter((tool) => value.tools[tool.key]).length;
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0];
  const visibleSections = SETTINGS_SECTIONS.filter((section) => {
    const query = navSearch.trim().toLocaleLowerCase();
    return !query || `${section.label} ${section.description}`.toLocaleLowerCase().includes(query);
  });

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
      <form className="settings-workspace" role="dialog" aria-modal="true" aria-labelledby="settings-page-title" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => { if (event.key === "Escape") { if (modelPickerOpen) setModelPickerOpen(false); else onClose(); } }}>
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <span className="settings-brand-mark"><Bot size={17} /></span>
            <span><strong>Portico</strong><small>AI 设置</small></span>
            <button className="icon-button quiet" type="button" onClick={onClose} title="关闭设置" aria-label="关闭设置"><X size={16} /></button>
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
            <button className="settings-save-button" type="submit" disabled={saving}>
              {saving ? <RefreshCw className="spinning" size={15} /> : <Save size={15} />}
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
        </aside>

        <main className="settings-page">
          <header className="settings-page-header">
            <div>
              <span>AI 配置</span>
              <h2 id="settings-page-title">{activeSectionMeta.label}</h2>
              <p>{activeSectionMeta.description}</p>
            </div>
          </header>

          <div className="settings-page-scroll">
            {activeSection === "model" && (
              <>
                <section className="settings-panel">
                  <header><strong>模型服务</strong><small>配置 OpenAI 兼容的大语言模型接入</small></header>
                  <div className="settings-config-row">
                    <span className="settings-row-copy"><strong>Provider</strong><small>选择 LLM 提供商</small></span>
                    <select className="settings-input" defaultValue="openai" aria-label="Provider"><option value="openai">OpenAI 兼容</option></select>
                  </div>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>Base URL</strong><small>API 基础地址</small></span>
                    <input className="settings-input settings-mono-input" value={value.endpoint} onChange={(event) => setValue({ ...value, endpoint: event.target.value })} />
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>API Key</strong><small>密钥保存到系统凭据库</small></span>
                    <input className="settings-input settings-mono-input" type="password" autoComplete="off" value={value.apiKey} onChange={(event) => setValue({ ...value, apiKey: event.target.value })} placeholder="sk-..." />
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>Model</strong><small>{models.length > 0 ? `已获取 ${models.length} 个模型` : "支持手动输入模型名称"}</small></span>
                    <span className="settings-model-control">
                      <input className="settings-input settings-mono-input" value={value.model} onChange={(event) => setValue({ ...value, model: event.target.value })} placeholder="输入模型 ID" />
                      <button type="button" disabled={loadingModels} onClick={() => void openModelPicker()}>
                        <RefreshCw className={loadingModels ? "spinning" : ""} size={14} />
                        {loadingModels ? "获取中" : "选择模型"}
                      </button>
                    </span>
                  </label>
                  <div className="settings-config-row settings-toggle-row">
                    <span className="settings-row-copy"><strong>视觉 / 支持图片</strong><small>允许把粘贴或拖入的图片发送给模型</small></span>
                    <label className="settings-toggle-control">
                      <input type="checkbox" checked={value.supportsImages} onChange={(event) => setValue({ ...value, supportsImages: event.target.checked })} />
                      <span className="switch" aria-hidden="true" />
                      <span><Image size={14} />允许向模型发送图片</span>
                    </label>
                  </div>
                </section>

                <a className="settings-page-link" href="https://platform.openai.com/docs" target="_blank" rel="noreferrer">查看 OpenAI 兼容接口格式 <ExternalLink size={13} /></a>
              </>
            )}

            {activeSection === "agent" && (
              <>
                <section className="settings-panel">
                  <header><strong>会话参数</strong><small>控制模型可读取的上下文和回答随机性</small></header>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>最大上下文长度</strong><small>模型可读取的最大上下文窗口，单位为 tokens</small></span>
                    <span className="settings-number-control"><input className="settings-input settings-mono-input" type="number" min={1024} max={2000000} step={1024} value={value.contextWindow} onChange={(event) => setValue({ ...value, contextWindow: Number(event.target.value) })} /><em>tokens</em></span>
                  </label>
                  <label className="settings-config-row">
                    <span className="settings-row-copy"><strong>输出长度</strong><small>单次回答最多生成的 tokens 数</small></span>
                    <span className="settings-number-control"><input className="settings-input settings-mono-input" type="number" min={256} max={2000000} step={256} value={value.maxOutputTokens} onChange={(event) => setValue({ ...value, maxOutputTokens: Number(event.target.value) })} /><em>tokens</em></span>
                  </label>
                  <div className="settings-config-row settings-toggle-row">
                    <span className="settings-row-copy"><strong>自动压缩上下文</strong><small>接近上限时先总结较早对话，再保留最近几轮继续请求</small></span>
                    <label className="settings-toggle-control">
                      <input type="checkbox" checked={value.autoCompress} onChange={(event) => setValue({ ...value, autoCompress: event.target.checked })} />
                      <span className="switch" aria-hidden="true" />
                      <span>达到上下文阈值时自动压缩</span>
                    </label>
                  </div>
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

            {activeSection === "tools" && (
              <>
                <div className="settings-section-summary"><div><strong>工具权限</strong><small>只向模型暴露已启用的函数工具</small></div><span><ListTree size={14} /> {enabledToolCount}/{TOOL_GROUPS.flatMap((group) => group.tools).length}</span></div>
                <div className="settings-tool-groups">{TOOL_GROUPS.filter((_, index) => index === 0 || index === 2).map(renderToolGroup)}</div>
                <section className="settings-panel settings-policy-panel">
                  <header><strong>执行策略</strong><small>限制每次工具链的运行边界和输出体积</small></header>
                  <div className="tool-policy-grid">
                    <label className="field"><span>最大工具轮数 <small>每次请求</small></span><input type="number" min={1} max={12} step={1} value={value.tools.maxToolRounds} onChange={(event) => setValue({ ...value, tools: { ...value.tools, maxToolRounds: Number(event.target.value) } })} /></label>
                    <label className="field"><span>输出上限 <small>字符</small></span><input type="number" min={1000} max={100000} step={1000} value={value.tools.maxOutputChars} onChange={(event) => setValue({ ...value, tools: { ...value.tools, maxOutputChars: Number(event.target.value) } })} /></label>
                    <label className="field"><span>命令超时 <small>秒</small></span><input type="number" min={5} max={300} step={5} value={value.tools.commandTimeoutSeconds} onChange={(event) => setValue({ ...value, tools: { ...value.tools, commandTimeoutSeconds: Number(event.target.value) } })} /></label>
                  </div>
                </section>
              </>
            )}

            {activeSection === "transfer" && (
              <>
                <div className="settings-section-summary"><div><strong>文件与 SFTP</strong><small>控制模型可使用的远端文件和传输能力</small></div></div>
                <div className="settings-tool-groups">{renderToolGroup(TOOL_GROUPS[1])}</div>
              </>
            )}

            {activeSection === "security" && (
              <>
                <div className="settings-section-summary"><div><strong>安全与知识</strong><small>在执行前检查风险并复用经过整理的命令片段</small></div></div>
                <div className="settings-tool-groups">{renderToolGroup(TOOL_GROUPS[3])}</div>
                <label className="mutating-tools-toggle"><span className="tool-permission-icon"><FilePenLine size={14} /></span><span className="tool-permission-copy"><strong>允许变更型工具</strong><small>写文件、上传、服务重启和进程信号仍会经过高危策略拦截。</small></span><input type="checkbox" checked={value.tools.allowMutatingTools} onChange={(event) => setValue({ ...value, tools: { ...value.tools, allowMutatingTools: event.target.checked } })} /><span className="switch" aria-hidden="true" /></label>
                <div className="settings-note"><ShieldCheck size={15} /><span>风险检查在 Rust 核心执行。命中高危规则时会暂停并等待人工确认，写入型工具默认关闭。</span></div>
              </>
            )}
          </div>
        </main>

        {modelPickerOpen && (
          <div className="model-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModelPickerOpen(false); }}>
            <section className="model-picker" role="dialog" aria-modal="true" aria-labelledby="model-picker-title">
              <header className="model-picker-header">
                <div><span>模型服务</span><h3 id="model-picker-title">选择模型</h3><small>{models.length > 0 ? `${models.length} 个模型可用` : "从当前接口读取模型列表"}</small></div>
                <button className="icon-button quiet" type="button" onClick={() => setModelPickerOpen(false)} title="关闭模型选择" aria-label="关闭模型选择"><X size={16} /></button>
              </header>
              <label className="model-picker-search"><Search size={14} /><input autoFocus value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="筛选模型 ID" aria-label="筛选模型 ID" /></label>
              <div className="model-picker-list" role="listbox" aria-label="可用模型">
                {models.filter((model) => model.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())).map((model) => (
                  <button className={`model-picker-option ${value.model === model ? "selected" : ""}`} type="button" role="option" aria-selected={value.model === model} key={model} onClick={() => { setValue({ ...value, model }); setModelPickerOpen(false); }}>
                    <span className="model-picker-option-icon"><Bot size={14} /></span><span>{model}</span>{value.model === model && <Check size={14} />}
                  </button>
                ))}
                {models.length === 0 && !loadingModels && <div className="model-picker-empty"><CircleAlert size={16} /><span>没有可显示的模型，请检查接口地址和密钥，或直接在文本框输入模型 ID。</span></div>}
                {models.length > 0 && models.filter((model) => model.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase())).length === 0 && <div className="model-picker-empty"><Search size={16} /><span>没有匹配的模型</span></div>}
              </div>
              <footer className="model-picker-footer"><span>当前选择</span><code>{value.model || "未选择"}</code></footer>
            </section>
          </div>
        )}
      </form>
    </div>
  );
}
