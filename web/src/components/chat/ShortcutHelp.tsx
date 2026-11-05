import { DialogShell } from "../ui/dialog-shell";

/** 快捷键帮助（chat UE 优化轮 E4-C 尾巴）：`?` 唤起；只列实际生效的契约，不画饼 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["Ctrl / ⌘ + K", "搜索会话（命令面板，↑↓ 选择、Enter 跳转）"],
    ["Enter", "发送消息（Shift + Enter 换行）"],
    ["Esc", "关闭浮层；生成中且输入框聚焦时停止输出"],
    ["/", "聚焦消息输入框"],
    ["?", "显示本帮助"],
    ["← / →", "文件预览弹窗内切换文件"],
  ];
  return (
    <DialogShell
      title="键盘快捷键"
      subtitle="对话页当前生效的快捷键"
      onClose={onClose}
      ariaLabel="键盘快捷键"
      className="max-w-md"
      footer={<span />}
    >
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map(([keys, desc]) => (
          <div key={keys} className="flex items-start gap-3">
            <dt className="w-36 shrink-0">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {keys}
              </kbd>
            </dt>
            <dd className="min-w-0 flex-1 text-muted-foreground">{desc}</dd>
          </div>
        ))}
      </dl>
    </DialogShell>
  );
}
