import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type AgentListDTO, fetchAgents } from "../lib/agents";
import { BUILTIN_ASSIST_AGENT_ID } from "../lib/assist";

export function AgentsPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

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

      <Section title="我创建的" items={mine} />
      <Section title="分享给我的" items={shared} />
    </div>
  );
}

function Section({ title, items }: { title: string; items: AgentListDTO[] }) {
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
            <Link
              to={`/agents/${a.id}/chat`}
              className="ml-2 shrink-0 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              对话
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
