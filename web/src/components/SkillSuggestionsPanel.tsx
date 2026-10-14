import { useCallback, useEffect, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  type SkillSuggestionEvent,
  applySkillSuggestion,
  fetchSkillEvents,
} from "../lib/skills";

/**
 * 技能修订建议面板（知识体系轮 P4）：渲染在 SKILL.md 预览弹层内——
 * 萃取产生的 skill_suggestion 事件清单（采纳=预填 diff→确认落盘）+ 晋升记录。
 */
export function SkillSuggestionsPanel(props: {
  packId: string;
  skillName: string;
  editable: boolean;
  onApplied: () => void | Promise<void>;
}) {
  const { packId, skillName, editable } = props;
  const [suggestions, setSuggestions] = useState<SkillSuggestionEvent[]>([]);
  const [promotions, setPromotions] = useState<Array<{ id: string; recordedAt: string; text: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchSkillEvents(skillName)
      .then((r) => {
        setSuggestions(r.suggestions);
        setPromotions(r.promotions);
        setLoaded(true);
      })
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
  }, [skillName]);

  useEffect(() => {
    reload();
  }, [reload]);

  const apply = async (): Promise<void> => {
    if (adopting === null) return;
    setError(null);
    try {
      await applySkillSuggestion({ packId, skillName, content: draft, confirmed });
      setNotice("已采纳并落盘 SKILL.md");
      setAdopting(null);
      setDraft("");
      setConfirmed(false);
      reload();
      await props.onApplied();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const parseDetail = (detail: string | null): { diff: string; rationale: string } => {
    try {
      const parsed = JSON.parse(detail ?? "{}") as { diff?: string; rationale?: string };
      return { diff: parsed.diff ?? "", rationale: parsed.rationale ?? "" };
    } catch {
      return { diff: "", rationale: "" };
    }
  };

  if (!loaded) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 rounded border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">修订建议与晋升记录</span>
        {promotions.length > 0 ? <Badge tone="success">{promotions.length} 次晋升</Badge> : null}
      </div>
      {!editable ? (
        <div className="text-xs text-muted-foreground">
          该技能为 git/builtin 只读源：建议可在上游仓库按 diff 修订后回推（skills-push）。
        </div>
      ) : null}
      {notice ? <div className="text-xs text-muted-foreground">{notice}</div> : null}
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      {suggestions.length === 0 && promotions.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          暂无沉淀事件。开启智能体「对话收尾自动萃取沉淀」的技能修订建议路由后，实战验证的 How-to 会出现在这里。
        </div>
      ) : null}
      {suggestions.map((s) => {
        const { diff, rationale } = parseDetail(s.detail);
        return (
          <div key={s.id} className="rounded border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">建议</Badge>
              <span className="text-muted-foreground">{new Date(s.recordedAt).toLocaleString()}</span>
              {editable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => {
                    setAdopting(s.id);
                    setDraft(diff);
                    setConfirmed(false);
                    setNotice(null);
                    setError(null);
                  }}
                >
                  采纳…
                </Button>
              ) : null}
            </div>
            {rationale ? <div className="mt-1">{rationale}</div> : null}
          </div>
        );
      })}
      {promotions.map((p) => (
        <div key={p.id} className="rounded border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">晋升</Badge>
            <span className="text-muted-foreground">{new Date(p.recordedAt).toLocaleString()}</span>
          </div>
          <div className="mt-1">{p.text}</div>
        </div>
      ))}
      {adopting !== null ? (
        <div className="rounded border p-3">
          <div className="text-xs font-medium">应用建议（将整篇替换 SKILL.md）</div>
          <textarea
            className="mt-2 min-h-40 w-full rounded border bg-background p-2 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已审阅新增内容，确认没有引入未授权的写盘/外发操作
          </label>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void apply()} disabled={!draft.trim()}>
              落盘
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdopting(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
