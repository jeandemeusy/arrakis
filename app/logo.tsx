/**
 * A dune-shaped A. The main strokes follow the current theme, while the
 * terracotta ridge keeps its identity in both light and dark appearances.
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
      <path
        d="M7.2 16.2 14.4 4.8c.8-1.3 2.4-1.3 3.2 0l6 9.6c-2.9-1.8-5.3-2.9-7.9-2.2-2.9.8-5 2.8-8.5 4ZM4.2 21.1c3.8-3 7.6-4.1 11.4-2.5 3.9 1.6 7.3 4.5 13.2 4.8l1.9 3.1h-6.3c-4.2 0-5.6-4.2-9.4-4.2s-4.3 4.2-7.5 4.2H1.3z"
        fill="currentColor"
      />
      <path
        d="M5.7 18.5c4.1-2.5 7.4-4.8 10.9-4.1 4.1.8 6.7 5.4 10.9 6.6l.5.8c-5.3-.5-8.8-3.7-12.6-4.9-3.5-1.1-6.6-.3-10.8 2.7z"
        fill="#c7714c"
      />
    </svg>
  );
}
