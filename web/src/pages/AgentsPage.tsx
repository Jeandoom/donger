import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { type AgentListDTO, deleteAgent, fetchAgents } from "../lib/agents";
import { BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";

export function AgentsPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentListDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAgent(pendingDelete.id);
      setAgents((list) => list.filter((a) => a.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const kw = keyword.trim().toLowerCase();
  const match = (a: AgentListDTO) =>
    !kw || a.name.toLowerCase().includes(kw) || (a.description ?? "").toLowerCase().includes(kw);
  const mine = agents.filter((a) => a._mine && match(a));
  const shared = agents.filter((a) => !a._mine && match(a));

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-7">
      <PageHeader
        title="智能体"
        description="管理你的自动化 Agent，配置技能与凭证"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => navigate(`/agent-sessions?agent=${BUILTIN_ASSIST_AGENT_ID}`)}
            >
              <Sparkles aria-hidden="true" size={14} className="inline" />
              AI 生成
            </Button>
            <Button onClick={() => navigate("/agents/new")}>+ 新建智能体</Button>
          </>
        }
      />

      <Input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="🔍 搜索智能体…"
        className="max-w-xs"
      />

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Section
        title="我创建的"
        items={mine}
        onDelete={(a) => setPendingDelete(a)}
        empty={kw ? "没有匹配的智能体" : "还没有智能体，点击右上角新建"}
      />
      <Section title="分享给我的" items={shared} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除智能体「${pendingDelete?.name ?? ""}」？`}
        description="删除后不可恢复；历史会话与分享链接将保留但不再可用。"
        confirmText="删除"
        destructive
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

function Section({
  title,
  items,
  onDelete,
  empty,
}: {
  title: string;
  items: AgentListDTO[];
  onDelete?: (a: AgentListDTO) => void;
  empty?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      {items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((a) => (
            <Card key={a.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/agents/${a.id}`} className="flex min-w-0 items-center gap-2">
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-primary-soft text-xs font-bold text-primary">
                    {a.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate text-[13px] font-semibold hover:underline">
                    {a.name}
                  </span>
                </Link>
                {a.scenario ? <Badge tone="success">{a.scenario}</Badge> : <Badge>通用</Badge>}
              </div>
              <Link
                to={`/agents/${a.id}`}
                className="line-clamp-2 min-h-8 text-xs text-muted-foreground hover:bg-muted/60"
              >
                {a.description ?? "—"}
              </Link>
              <div className="mt-auto flex items-center justify-between">
                <Badge tone={a._mine ? "info" : "primary"}>{a._mine ? "我的" : "共享"}</Badge>
                <div className="flex items-center gap-1.5">
                  <Link to={`/agents/${a.id}/chat`}>
                    <Button variant="secondary" size="sm">
                      对话
                    </Button>
                  </Link>
                  {onDelete ? (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => onDelete(a)}
                      title="删除智能体"
                    >
                      删除
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty ?? "暂无"}</p>
      )}
    </div>
  );
}
