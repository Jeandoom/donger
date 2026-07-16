import { Link, useLocation } from "react-router-dom";
import type { GitAccessRequirementDTO } from "../../lib/gitSettings";

const PROVIDER_NAMES = {
  github: "GitHub",
  gitee: "Gitee",
  jihulab: "极狐 GitLab",
};

const AUTH_REASONS = new Set([
  "connection_missing",
  "token_expired",
  "token_revoked",
  "access_denied",
]);

export function GitAccessBlocker(props: {
  loading: boolean;
  requirements: GitAccessRequirementDTO[];
  error?: string;
  onGrant: (repositoryIds: string[]) => void;
  onRetry: () => void;
}) {
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const grants = props.requirements
    .filter((item) => item.reason === "grant_missing")
    .flatMap((item) => item.repositories.map((repository) => repository.id));
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl space-y-4 rounded-xl border bg-background p-5 shadow-sm">
        <div>
          <h2 className="font-semibold">需要 Git 仓库授权</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            完成以下仓库权限校验后才能开始智能体对话。
          </p>
        </div>
        {props.loading ? (
          <div className="text-sm text-muted-foreground">正在检查仓库权限…</div>
        ) : null}
        {props.error ? (
          <div className="rounded bg-red-50 p-2 text-sm text-red-700">{props.error}</div>
        ) : null}
        {props.requirements.map((requirement) => (
          <section
            key={`${requirement.provider}:${requirement.reason}`}
            className="space-y-2 rounded border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{PROVIDER_NAMES[requirement.provider]}</span>
              {AUTH_REASONS.has(requirement.reason) ? (
                <Link
                  className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                  to={`/settings/git?returnTo=${encodeURIComponent(returnTo)}`}
                >
                  前往授权
                </Link>
              ) : null}
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {requirement.repositories.map((repository) => (
                <li key={repository.id}>• {repository.fingerprint}</li>
              ))}
            </ul>
            <div className="text-xs text-muted-foreground">原因：{requirement.reason}</div>
          </section>
        ))}
        <div className="flex gap-2">
          {grants.length > 0 ? (
            <button
              type="button"
              className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
              onClick={() => props.onGrant(grants)}
            >
              授权此智能体读取并继续
            </button>
          ) : null}
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            onClick={props.onRetry}
          >
            重新检查
          </button>
        </div>
      </div>
    </div>
  );
}
