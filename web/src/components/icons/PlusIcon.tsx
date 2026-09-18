/**
 * Penpot「icon · plus」素材（P20 · 侧边栏折叠 画板）：14×14 双线加号，
 * 1.5 圆头描边与既有 icon · chat/logout 同规格；stroke 用 currentColor 随语境着色。
 */
export function PlusIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path d="M0 7H14M7 0V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
