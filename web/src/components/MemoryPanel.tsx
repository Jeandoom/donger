import { useCallback, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { fetchMe } from "../lib/auth";
import {
  type KbMemoryDTO,
  type MemoryChannelMode,
  fetchKbMemory,
  migrateKbLegacyMemory,
  saveMemoryChannel,
} from "../lib/platform";

const MODE_LABEL: Record<MemoryChannelMode, string> = {
  curated: "curated（索引常驻）",
  legacy: "legacy（关键词检索）",
  off: "off（关闭）",
};

/**
 * 个人库记忆分区（知识体系轮 P2）：通道模式、curated 条目清单、索引健康度、
 * legacy 旧条目一键迁移。admin 可改全局档位（orchestrator 每轮现取，改即生效）。
 */
export function MemoryPanel({ kbId }: { kbId: string }) {
  const [mem, setMem] = useState<KbMemoryDTO | null>(null);
  const [admin, setAdmin] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchKbMemory(kbId)
      .then(setMem)
      .catch((e) => setError(String(e)));
  }, [kbId]);

  useEffect(() => {
    reload();
    fetchMe()
      .then((me) => setAdmin(me?.role === "admin"))
      .catch(() => {});
  }, [reload]);

  const migrate = async (): Promise<void> => {
    setMigrating(true);
    setError(null);
    try {
      const moved = await migrateKbLegacyMemory(kbId);
      setNotice(`已迁移 ${moved} 条旧记忆至 archive/`);
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setMigrating(false);
    }
  };

  const changeMode = async (mode: MemoryChannelMode): Promise<void> => {
    setError(null);
    try {
      await saveMemoryChannel(mode);
      setNotice(`记忆通道已切换为 ${MODE_LABEL[mode]}`);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  if (error && !mem) return <div className="text-sm text-destructive">{error}</div>;
  if (!mem) return <div className="text-sm text-muted-foreground">加载中…</div>;
  const indexHealth =
    mem.indexLines > 180 ? "warn" : mem.indexLines > 0 ? "ok" : "empty";

  return (
    <div className="flex flex-col gap-4">
      {notice ? <div className="text-sm text-muted-foreground">{notice}</div> : null}
      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">通道模式</div>
            <div className="text-xs text-muted-foreground">
              curated=收尾萃取精选+索引常驻注入（推荐）；legacy=每任务原文倾倒+关键词检索（兼容）；off=不注入不沉淀
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={mem.mode === "curated" ? "success" : "info"}>
              {MODE_LABEL[mem.mode]}
            </Badge>
            {admin ? (
              <select
                className="rounded border bg-background px-2 py-1 text-xs"
                value={mem.mode}
                onChange={(e) => void changeMode(e.target.value as MemoryChannelMode)}
              >
                <option value="curated">切换为 curated</option>
                <option value="legacy">切换为 legacy</option>
                <option value="off">切换为 off</option>
              </select>
            ) : null}
          </div>
        </div>
      </Card>

      {mem.legacyCount > 0 ? (
        <Card className="border-amber-500/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">
                检测到 {mem.legacyCount} 条旧格式自动记忆（memory/ 顶层）
              </div>
              <div className="text-xs text-muted-foreground">
                迁移到 archive/ 归档保存，与 curated 精选层隔离；归档条目不再注入会话。
              </div>
            </div>
            <Button size="sm" onClick={() => void migrate()} disabled={migrating}>
              {migrating ? "迁移中…" : "移入 archive/"}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">精选记忆（curated）</div>
          <div className="text-xs text-muted-foreground">
            索引 {mem.indexLines}/200 行
            {indexHealth === "warn" ? "（超限告警，将在整理时压缩）" : ""}
            {indexHealth === "empty" ? "（暂无索引——由收尾萃取自动生成）" : ""}
          </div>
        </div>
        {mem.curated.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground">
            暂无精选条目。开启智能体的「对话收尾自动萃取沉淀」后，个性化事实与偏好会沉淀到这里。
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-1">
            {mem.curated.map((c) => (
              <li key={c.filename} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{c.summary || c.filename}</span>
                <code className="shrink-0 text-xs text-muted-foreground">{c.filename}</code>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
