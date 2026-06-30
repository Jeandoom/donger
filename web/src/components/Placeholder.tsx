export function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{hint ?? "占位页（待后续阶段实现）"}</p>
    </div>
  );
}
