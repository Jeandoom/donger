import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import {
  type PlatformNoteCandidate,
  fetchPlatformCandidates,
  fetchPlatformNotes,
  resolvePlatformCandidate,
  savePlatformNotes,
} from "../lib/platform";

/**
 * 平台环境约束编辑卡（知识体系轮 P1/P3，admin 可见）：约束文本编辑 + 萃取器
 * platformNote 候选池审阅（合并/忽略）；保存即对新会话生效。
 */
export function PlatformNotesCard() {
  const [notes, setNotes] = useState("");
  const [candidates, setCandidates] = useState<PlatformNoteCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([fetchPlatformNotes(), fetchPlatformCandidates()])
      .then(([n, c]) => {
        setNotes(n);
        setCandidates(c);
        setLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

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

  const resolve = async (index: number, action: "merge" | "dismiss"): Promise<void> => {
    setError(null);
    try {
      if (action === "merge") {
        setNotes((cur) => (cur.trim() ? `${cur.trimEnd()}\n- ${candidates[index]?.content ?? ""}` : `- ${candidates[index]?.content ?? ""}`));
      }
      await resolvePlatformCandidate(index, action);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!loaded) return null;
  return (
    <div className="flex flex-col gap-3">
      {candidates.length > 0 ? (
        <Card className="border-amber-500/40 p-4">
          <div className="text-sm font-medium">平台约束候选（{candidates.length}）</div>
          <div className="text-xs text-muted-foreground">
            来自智能体收尾萃取的 platformNote 路由，审阅后合并进约束或忽略。
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {candidates.map((c, i) => (
              <li key={`${c.createdAt}-${i}`} className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1">{c.content}</span>
                <Button size="sm" variant="secondary" onClick={() => void resolve(i, "merge")}>
                  合并
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void resolve(i, "dismiss")}>
                  忽略
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
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
    </div>
  );
}
