import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { fetchPlatformNotes, savePlatformNotes } from "../lib/platform";

/**
 * 平台环境约束编辑卡（知识体系轮 P1，admin 可见）：沙箱工具面、路径校验怪癖等
 * 全平台共享事实的单点维护入口；保存即对新会话生效（orchestrator 每轮现取注入）。
 */
export function PlatformNotesCard() {
  const [notes, setNotes] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPlatformNotes()
      .then((n) => {
        setNotes(n);
        setLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await savePlatformNotes(notes);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">平台环境约束</div>
          <div className="text-xs text-muted-foreground">
            全平台共享的环境事实（沙箱工具面、路径校验怪癖等），注入所有智能体的系统提示词；admin 维护，改即生效。
          </div>
        </div>
        <div className="flex items-center gap-2">
          {savedAt ? <span className="text-xs text-muted-foreground">已保存 {savedAt}</span> : null}
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
      <Textarea
        className="mt-3 min-h-32 font-mono text-xs"
        value={notes}
        placeholder={"示例：\n- 沙箱只有 node/npm/git，没有 python/uv/curl/ssh\n- Bash 内容里的前导斜杠路径、正则 \\n 会被路径校验误判，先赋变量再引用"}
        onChange={(e) => setNotes(e.target.value)}
      />
      {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
    </Card>
  );
}
