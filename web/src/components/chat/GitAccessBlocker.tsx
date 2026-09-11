import { Link } from "react-router-dom";
import type { GitAccessRequirementDTO } from "../../lib/gitSettings";

const PROVIDER_NAMES = {
  github: "GitHub",
  gitee: "Gitee",
  jihulab: "GitLab 兼容",
};

export function GitAccessBlocker(props: {
  loading: boolean;
  requirements: GitAccessRequirementDTO[];
  error?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
        <div>
          <h2 className="font-semibold">需要配置 Git 仓库凭证</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            以下私有仓库校验未通过：请在「凭证管理」中配置对应仓库的 git
            访问令牌（一仓一凭证），并确认智能体已绑定该凭证。
          </p>
        </div>
        {props.loading ? (
          <div className="text-sm text-muted-foreground">正在检查仓库权限…</div>
        ) : null}
        {props.error ? (
          <div className="rounded bg-destructive-soft p-2 text-sm text-destructive">
            {props.error}
          </div>
        ) : null}
        {props.requirements.map((requirement) => (
          <section
            key={`${requirement.provider}:${requirement.reason}`}
            className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{PROVIDER_NAMES[requirement.provider]}</span>
              <Link
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                to="/credentials"
              >
                前往配置凭证
              </Link>
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
          <button
            type="button"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
            onClick={props.onRetry}
          >
            重新检查
          </button>
        </div>
      </div>
    </div>
  );
}
