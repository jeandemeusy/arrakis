/** A cairn: three stacked stones, the top one marked, a trail of figures built up from data. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="logo"
    >
      <rect x="4" y="22" width="24" height="7" rx="3.5" fill="currentColor" />
      <rect
        x="8"
        y="13.5"
        width="16"
        height="6.5"
        rx="3.25"
        fill="currentColor"
      />
      <rect x="12" y="5" width="8" height="6.5" rx="3.25" fill="#c7714c" />
    </svg>
  );
}
