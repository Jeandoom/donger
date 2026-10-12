import { useState } from "react";
import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface PendingInteractionProps {
  approval: PendingApproval | null;
  credential: PendingCredential | null;
  approvalError?: string;
  credentialError?: string;
  onResolveApproval: (approved: boolean, reason?: string, adoptPrefix?: string) => void;
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
      {approval ? <ApprovalCard approval={approval} error={approvalError} onResolve={onResolveApproval} /> : null}
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

/** 审批卡：通过/驳回 + 可选「通过并记住」（admin 轮 host_exec 审批时携带 adopt 草稿） */
function ApprovalCard({
  approval,
  error,
  onResolve,
}: {
  approval: PendingApproval;
  error?: string;
  onResolve: (approved: boolean, reason?: string, adoptPrefix?: string) => void;
}) {
  // adopt 前缀的文本态：卡片装载后一次性以草稿初始化，可编辑
  const [adoptPrefix, setAdoptPrefix] = useState(approval.adoptDraft?.prefix ?? "");
  return (
    <fieldset
      aria-label="审批请求"
      className="rounded-xl border border-warning/50 bg-warning-soft p-4"
    >
      <div className="text-sm font-semibold text-warning-foreground">{approval.title}</div>
      <div className="mt-1 text-sm text-warning-foreground">{approval.summary}</div>
      {approval.adoptDraft ? (
        <div className="mt-2.5 rounded-lg border border-warning/30 bg-white/60 p-2.5">
          <div className="text-xs text-slate-600">
            通过并记住此类命令（主机 <span className="font-mono">{approval.adoptDraft.hostCode}</span>
            ，前缀命中即免审批；可在前缀框调整粒度）：
          </div>
          <Input
            mono
            className="mt-1.5 h-8 text-[13px]"
            value={adoptPrefix}
            aria-label="免审批前缀"
            spellCheck={false}
            onChange={(e) => setAdoptPrefix(e.target.value)}
          />
          <div className="mt-2">
            <Button
              size="sm"
              disabled={!adoptPrefix.trim()}
              title="批准本次执行，并把该前缀写为主机执行策略（下次免审批）"
              onClick={() => onResolve(true, undefined, adoptPrefix.trim())}
            >
              通过并记住此类命令
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => onResolve(true)}>
          通过
        </Button>
        <Button size="sm" variant="outline" onClick={() => onResolve(false, "Web 驳回")}>
          驳回
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
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
