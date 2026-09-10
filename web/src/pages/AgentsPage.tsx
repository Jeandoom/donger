import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type AgentListDTO, deleteAgent, fetchAgents } from "../lib/agents";
import { BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

export function AgentsPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<AgentListDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = () =>
    fetchAgents()
      .then(setAgents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    reload();
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

  const mine = agents.filter((a) => a._mine);
  const shared = agents.filter((a) => !a._mine);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">智能体</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border px-3 py-1.5 hover:bg-accent"
            onClick={() => navigate(`/agent-sessions?agent=${BUILTIN_ASSIST_AGENT_ID}`)}
          >
            ✨ AI 生成
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-primary-foreground"
            onClick={() => navigate("/agents/new")}
          >
            + 新建
          </button>
        </div>
      </div>

      {loading ? <p className="text-muted-foreground">加载中…</p> : null}
      {error ? <p className="text-destructive">{error}</p> : null}

      <Section title="我创建的" items={mine} onDelete={(a) => setPendingDelete(a)} />
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
}: {
  title: string;
  items: AgentListDTO[];
  onDelete?: (a: AgentListDTO) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm text-muted-foreground">{title}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((a) => (
          <div key={a.id} className="flex items-start justify-between rounded border p-3">
            <Link to={`/agents/${a.id}`} className="block flex-1 hover:bg-accent">
              <div className="font-medium">{a.name}</div>
              <div className="line-clamp-2 text-sm text-muted-foreground">
                {a.description ?? "—"}
              </div>
            </Link>
            <div className="ml-2 flex shrink-0 items-center gap-1.5">
              <Link
                to={`/agents/${a.id}/chat`}
                className="rounded border px-2 py-1 text-xs hover:bg-accent"
              >
                对话
              </Link>
              {onDelete ? (
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-destructive"
                  onClick={() => onDelete(a)}
                >
                  删除
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
