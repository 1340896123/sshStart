import { useState } from "react";
import { Check, Copy, Search } from "lucide-react";

const SNIPPETS = [
  { name: "磁盘空间", command: "df -hT" },
  { name: "内存和交换分区", command: "free -h" },
  { name: "系统负载", command: "uptime" },
  { name: "失败的 systemd 服务", command: "systemctl --failed --no-pager" },
  { name: "最近的错误日志", command: "journalctl -p err -n 120 --no-pager" },
  { name: "监听端口", command: "ss -tlpn" },
];

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
}

export function SnippetPane({ search, onSearchChange }: Props) {
  const [copyState, setCopyState] = useState<{ command: string; copied: boolean }>();
  const query = search.trim().toLocaleLowerCase();
  const snippets = SNIPPETS.filter((snippet) => `${snippet.name} ${snippet.command}`.toLocaleLowerCase().includes(query));

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState({ command, copied: true });
    } catch {
      setCopyState({ command, copied: false });
    }
  };

  return (
    <aside id="snippet-sidebar" className="server-sidebar snippet-sidebar" aria-label="命令片段">
      <div className="sidebar-heading">
        <div><span className="eyebrow">工具箱</span><h1>命令片段</h1></div>
      </div>
      <label className="search-field">
        <Search size={14} aria-hidden="true" />
        <input aria-label="搜索命令片段" placeholder="搜索名称或命令" value={search} onChange={(event) => onSearchChange(event.target.value)} />
      </label>
      <p className="snippet-hint">复制命令后粘贴到终端使用。</p>
      <div className="snippet-list">
        {snippets.map((snippet) => (
          <article className="snippet-card" key={snippet.command}>
            <div className="snippet-card-heading">
              <strong>{snippet.name}</strong>
              <button className="icon-button quiet" title={`复制${snippet.name}`} aria-label={`复制${snippet.name}`} onClick={() => { void copy(snippet.command); }}>
                {copyState?.command === snippet.command && copyState.copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <code>{snippet.command}</code>
          </article>
        ))}
        {snippets.length === 0 && <p className="snippet-hint">没有匹配的命令片段</p>}
      </div>
      <p className="snippet-copy-status" role="status">{copyState && (copyState.copied ? "命令已复制" : "复制失败，请选择命令文字后复制")}</p>
    </aside>
  );
}
