/**
 * Penpot「icon · model」素材：芯片造型（外框 + 内核 + 四边引脚），
 * 24 网格 / 2 圆头描边，与导航 lucide 同规格；stroke 用 currentColor 随语境着色。
 */
export function ModelIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="9.5" y="9.5" width="5" height="5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
