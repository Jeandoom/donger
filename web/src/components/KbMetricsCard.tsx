import { useEffect, useState } from "react";
import { Card } from "../components/ui/card";
import { fetchMe } from "../lib/auth";
import { type KbMetric, fetchKbMetrics } from "../lib/platform";

/**
 * KB 治理指标卡（知识体系轮 P5，admin 可见）：近 2000 次 kb_* 工具调用按库聚合，
 * 「被读/条目」比值暴露只写不读的库——支撑晋升与清理决策。
 */
export function KbMetricsCard() {
  const [metrics, setMetrics] = useState<KbMetric[] | null>(null);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    fetchMe()
      .then((me) => setAdmin(me?.role === "admin"))
      .catch(() => {});
    fetchKbMetrics()
      .then(setMetrics)
      .catch(() => setMetrics([]));
  }, []);

  if (!admin || !metrics || metrics.length === 0) return null;
  return (
    <Card className="p-4">
      <div className="text-sm font-medium">库治理指标（admin）</div>
      <div className="text-xs text-muted-foreground">
        近期 kb_* 工具调用按库聚合；「被读/条目」比值低=只写不读，优先考虑晋升进技能或清理。
      </div>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1">库</th>
            <th className="py-1 text-right">条目</th>
            <th className="py-1 text-right">读</th>
            <th className="py-1 text-right">检索</th>
            <th className="py-1 text-right">写/删</th>
            <th className="py-1 text-right">被读/条目</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.kbId} className="border-t">
              <td className="py-1">
                {m.name}
                {m.personal ? <span className="ml-1 text-muted-foreground">（个人）</span> : null}
              </td>
              <td className="py-1 text-right">{m.entries}</td>
              <td className="py-1 text-right">{m.read}</td>
              <td className="py-1 text-right">{m.search}</td>
              <td className="py-1 text-right">{m.write}</td>
              <td className="py-1 text-right">{m.readRatio}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
