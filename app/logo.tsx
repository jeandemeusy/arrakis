/** Three streams meeting at a point: data becoming an insight. */
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
      <path
        d="M5 7.5h3.2c6.1 0 7.5 6.4 13.3 6.4M5 16h16.5M5 24.5h3.2c6.1 0 7.5-6.4 13.3-6.4"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="25.5" cy="16" r="3.5" fill="#c7714c" />
    </svg>
  );
}
