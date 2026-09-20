/**
 * Penpot「icon · credential」素材：钥匙造型（环体 + 斜杆 + 单齿），
 * 24 网格 / 2 圆头描边，与导航 lucide 同规格；stroke 用 currentColor 随语境着色。
 */
export function CredentialIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="7.5" cy="16.5" r="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="M10.5 13.5 20 4M16 8l3 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
