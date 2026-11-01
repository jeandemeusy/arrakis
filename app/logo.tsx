/**
 * Arrakis's mark: a sun over two dunes, drawn in the current text colour so it
 * follows the style and the theme. The favicon is the same drawing, with
 * colours of its own.
 */
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
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="8"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <circle cx="21.5" cy="10.5" r="3.4" fill="currentColor" />
      <path
        d="M2.5 23.5C7 18.5 12 18 17 21.5c3.5 2.4 7 2.2 12.5-1.5V25a5.5 5.5 0 0 1-5.5 5.5H8A5.5 5.5 0 0 1 2.5 25z"
        fill="currentColor"
      />
    </svg>
  );
}
