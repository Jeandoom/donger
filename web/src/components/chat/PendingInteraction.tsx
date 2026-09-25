import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";

export interface PendingInteractionProps {
  approval: PendingApproval | null;
  credential: PendingCredential | null;
  approvalError?: string;
  credentialError?: string;
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onDecideCredentialMissing: (decision: string) => void;
}

export function PendingInteraction({
  approval,
  credential,
  approvalError,
  credentialError,
  onResolveApproval,
  onDecideCredentialMissing,
}: PendingInteractionProps) {
  return (
    <>
      {approval ? (
        <fieldset
          aria-label="审批请求"
          className="rounded-xl border border-warning/50 bg-warning-soft p-4"
        >
          <div className="text-sm font-semibold text-warning-foreground">{approval.title}</div>
          <div className="mt-1 text-sm text-warning-foreground">{approval.summary}</div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => onResolveApproval(true)}>
              通过
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onResolveApproval(false, "Web 驳回")}
            >
              驳回
            </Button>
          </div>
          {approvalError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {approvalError}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {credential ? (
        <MissingCredentialsCard
          key={credential.reqId}
          items={credential.items}
          error={credentialError}
          onDecide={onDecideCredentialMissing}
        />
      ) : null}
    </>
  );
}

/** 凭证缺失问询卡：继续执行（跳过）/ 暂停 / 配置后重试 / 取消 */
function MissingCredentialsCard({
  items,
  error,
  onDecide,
}: {
  items: PendingCredential["items"];
  error?: string;
  onDecide: (decision: string) => void;
}) {
  return (
    <div className="rounded-xl border border-primary/40 bg-primary-soft p-4">
      <div className="font-semibold text-blue-800">缺少凭证</div>
      <div className="mt-1 text-sm text-blue-700">
        当前智能体需要以下凭证，但你的账号尚未配置（值仅存你个人账号）：
      </div>
      <ul className="mt-1 list-inside list-disc text-sm text-blue-800">
        {items.map((item) => (
          <li key={item.code}>
            {item.name}（<span className="font-mono">{item.code}</span>）需要键：
            {(item.keys ?? []).join(", ")}
          </li>
        ))}
      </ul>
      <div className="mt-1 text-xs text-blue-600">
        请先到
        <a
          className="mx-0.5 font-medium underline"
          href={`/settings/credentials?fill=${encodeURIComponent(items[0]?.code ?? "")}`}
          target="_blank"
          rel="noreferrer"
        >
          凭证管理
        </a>
        页填写缺失项，完成后点「重试」。
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onDecide("continue")}>
          继续执行（跳过缺失）
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("pause")}>
          暂停
        </Button>
        <Button size="sm" onClick={() => onDecide("retry")}>
          已配置，重试
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => onDecide("cancel")}
        >
          取消任务
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
