import { useState } from "react";
import type { PendingApproval, PendingCredential } from "../../types";
import { Button } from "../ui/button";

export interface PendingInteractionProps {
  approval: PendingApproval | null;
  credential: PendingCredential | null;
  approvalError?: string;
  credentialError?: string;
  onResolveApproval: (approved: boolean, reason?: string) => void;
  onSubmitCredential: (values: Record<string, string>) => void;
}

export function PendingInteraction({
  approval,
  credential,
  approvalError,
  credentialError,
  onResolveApproval,
  onSubmitCredential,
}: PendingInteractionProps) {
  return (
    <>
      {approval ? (
        <fieldset
          aria-label="审批请求"
          className="rounded-lg border border-yellow-400 bg-yellow-50 p-3"
        >
          <div className="font-semibold text-yellow-800">{approval.title}</div>
          <div className="mt-1 text-sm text-yellow-700">{approval.summary}</div>
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
            <p role="alert" className="mt-2 text-sm text-red-700">
              {approvalError}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {credential ? (
        <CredentialCard
          key={credential.reqId}
          items={credential.items}
          error={credentialError}
          onSubmit={onSubmitCredential}
        />
      ) : null}
    </>
  );
}

function CredentialCard({
  items,
  error,
  onSubmit,
}: {
  items: PendingCredential["items"];
  error?: string;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <div className="rounded-lg border border-blue-400 bg-blue-50 p-3">
      <div className="font-semibold text-blue-800">需要凭证</div>
      <div className="mt-1 text-sm text-blue-700">
        运行此任务需要以下凭证。提交值只保存在当前组件内存。
      </div>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <label key={item.key} className="block text-sm text-blue-800">
            {item.label}（{item.packName}）
            <input
              type={item.secret ? "password" : "text"}
              className="mt-1 w-full rounded border border-blue-300 bg-white px-2 py-1"
              value={values[item.key] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [item.key]: event.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <Button
        className="mt-3"
        size="sm"
        onClick={() => {
          const filled = Object.fromEntries(
            Object.entries(values).filter(([, value]) => value.length > 0),
          );
          onSubmit(filled);
        }}
      >
        提交并继续
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
