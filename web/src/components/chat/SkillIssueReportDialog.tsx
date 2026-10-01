import { useEffect, useState } from "react";
import { fetchSkillAudit, reportSkillIssue } from "../../lib/share";
import { Button } from "../ui/button";
import { DialogShell } from "../ui/dialog-shell";

/**
 * 技能问题上报弹窗（2026-10-01 共享智能体技能修复轮 C）：
 * 打开即后端对账展示缺失技能，用户可附一句说明；对账无缺失且无说明则
 * 不产生通知（后端 reported=false），提示用户补说明或放弃。
 */
export function SkillIssueReportDialog(props: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [auditError, setAuditError] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"reported" | "nothing-to-report" | null>(null);

  useEffect(() => {
    fetchSkillAudit(props.agentId)
      .then((r) => setMissing(r.missing))
      .catch(() => setAuditError("技能对账失败，请稍后重试"));
  }, [props.agentId]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await reportSkillIssue(props.agentId, { message: message.trim() || undefined });
      if (r.reported) {
        setResult("reported");
      } else {
        setResult("nothing-to-report");
      }
    } catch {
      setAuditError("上报失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogShell
      title={`向分享者上报技能问题`}
      subtitle={`智能体「${props.agentName}」`}
      onClose={props.onClose}
      footer={
        result ? (
          <Button variant="default" size="sm" onClick={props.onClose}>
            关闭
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              取消
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={submitting || missing === null}
              onClick={() => void submit()}
            >
              {submitting ? "提交中…" : "发送给分享者"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <p className="text-sm text-muted-foreground">
          {result === "reported"
            ? "已发送。分享者会在通知中心收到反馈，修复后技能自动对本智能体生效。"
            : "平台对账未检测到缺失技能。如仍遇到问题，请补充说明后再发送。"}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {auditError ? (
            <p className="text-sm text-destructive">{auditError}</p>
          ) : missing === null ? (
            <p className="text-sm text-muted-foreground">对账中…</p>
          ) : missing.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              平台对账未检测到缺失技能。若你观察到的现象与此不符，可在下方说明。
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">检测到缺失技能</span>
              {missing.map((skill) => (
                <span
                  key={skill}
                  className="rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-1.5 font-mono text-xs"
                >
                  {skill}
                </span>
              ))}
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">补充说明（可选）</span>
            <textarea
              value={message}
              maxLength={500}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="描述你遇到的现象，帮助分享者定位（不超过 500 字）"
              className="w-full rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-sm"
            />
          </label>
        </div>
      )}
    </DialogShell>
  );
}
