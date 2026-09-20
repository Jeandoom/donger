/**
 * Penpot「icon · invite」素材：邀请用户（人形 + 右侧加号），
 * 24 网格 / 2 圆头描边，与导航 lucide 同规格；stroke 用 currentColor 随语境着色。
 */
export function InviteIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="9" cy="7" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20M19 8v6M16 11h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
