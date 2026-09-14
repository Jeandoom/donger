import { Check, Copy } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import { useState } from "react";

/** 代码块头部：语言标签 + 复制按钮（MarkdownTextPrimitive CodeHeader 扩展点） */
export function MarkdownCodeHeader({
  language,
  code,
}: {
  language: string | undefined;
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）→ 静默
    }
  };

  return (
    <div className="flex items-center justify-between rounded-t-lg bg-[#282c34] px-4 py-1.5 text-xs text-zinc-300">
      <span className="font-mono lowercase">{language || "text"}</span>
      <button
        type="button"
        aria-label="复制代码"
        onClick={() => void copy()}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
      >
        {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/** 代码块高亮渲染（MarkdownTextPrimitive SyntaxHighlighter 扩展点） */
export function MarkdownSyntaxHighlighter({
  language,
  code,
}: {
  language: string;
  code: string;
  components: {
    Pre: React.ComponentType<{ children?: React.ReactNode }>;
    Code: React.ComponentType<{ children?: React.ReactNode }>;
  };
}) {
  return (
    <Highlight code={code} language={language || "text"} theme={themes.oneDark}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`overflow-x-auto rounded-b-lg ${className}`}
          style={{ ...style, margin: 0, padding: "0.75rem 1rem" }}
        >
          {tokens.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态 token 行/列永不重排，index 即稳定键
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, key) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上，token 流为一次性静态渲染
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
