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
        d="M8.1 15.4 14.5 5.2c.8-1.3 2.2-1.3 3 0l5.8 9.2c-3.4-1.8-4.8-2.9-7-2.2-2.5.8-4.6 2.9-8.2 3.2ZM5.8 19.2c3.7-3.4 7.6-5.5 11.1-4.5 3.6 1 5.8 5.2 10.2 6.2l1 1.8c-5-.6-8.1-3.6-11.4-4.8-3.8-1.4-7.3-.3-10.9 1.3ZM4.3 21.6c4.2-3.5 8.1-3.7 11.9-2.1 3.5 1.5 6.5 4.2 12.5 4.9l1.3 2.1h-5.8c-3.8 0-5.4-4.9-9.3-4.9-3.6 0-4.4 4.9-7.4 4.9H2z"
        fill="currentColor"
      />
      <path
        d="M14.5 13.7c3.9-3.5 5.9-1.9 8.4.3l3.4 5.5c-4.7-1.2-6.5-6.2-11.8-5.8Z"
        fill="#c7714c"
      />
    </svg>
  );
}
