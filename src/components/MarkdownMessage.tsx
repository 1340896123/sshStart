import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import remarkGfm from "remark-gfm";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);

const LANGUAGE_ALIASES: Record<string, string> = {
  console: "bash",
  html: "markup",
  js: "javascript",
  jsonc: "json",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  "shell-session": "bash",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash",
};

const HIGHLIGHTED_LANGUAGES = new Set([
  "bash",
  "css",
  "javascript",
  "json",
  "jsx",
  "markup",
  "python",
  "rust",
  "tsx",
  "typescript",
  "yaml",
]);

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

function CodeBlock({ code, language = "text" }: { code: string; language?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const normalizedLanguage = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  const highlightLanguage = HIGHLIGHTED_LANGUAGES.has(normalizedLanguage) ? normalizedLanguage : undefined;

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  };

  const copyLabel = copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制代码";

  return (
    <div className="markdown-code">
      <div className="markdown-code-header">
        <span>{language.toUpperCase()}</span>
        <button
          type="button"
          className={`markdown-copy-button ${copyState}`}
          title={copyLabel}
          aria-label={copyLabel}
          onClick={() => void copyCode()}
        >
          {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <SyntaxHighlighter
        language={highlightLanguage}
        useInlineStyles={false}
        wrapLongLines={false}
        PreTag="pre"
        CodeTag="code"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

const markdownComponents: Components = {
  a({ href, children, title }) {
    const isExternal = /^https?:\/\//i.test(href ?? "");
    return (
      <a href={href} title={title} target={isExternal ? "_blank" : undefined} rel={isExternal ? "noreferrer" : undefined}>
        {children}
      </a>
    );
  },
  code({ className, children }) {
    return <code className={className}>{children}</code>;
  },
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<CodeElementProps>(child)) return <pre>{children}</pre>;

    const language = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1];
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock code={code} language={language} />;
  },
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="message-copy markdown-body prose prose-sm max-w-none">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
    </div>
  );
}
