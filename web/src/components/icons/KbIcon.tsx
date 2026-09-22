/**
 * 知识库导航 icon（打开的书）：24 网格、1.5 圆头描边与导航 lucide 同规格，
 * stroke 用 currentColor 随语境着色。后续可由 Penpot 素材替换（同 PlusIcon 流程）。
 */
export function KbIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2 5.6C3.5 4.9 5.2 4.5 7 4.5c2 0 3.8.6 5 1.7 1.2-1.1 3-1.7 5-1.7 1.8 0 3.5.4 5 1.1v13c-1.5-.7-3.2-1.1-5-1.1-2 0-3.8.6-5 1.7-1.2-1.1-3-1.7-5-1.7-1.8 0-3.5.4-5 1.1v-13Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 6.2v13.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
