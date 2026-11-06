'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A destination that exists but needs the editing password. Keeping it visible
 * makes the studio discoverable; rendering a non-link prevents accidental
 * navigation while the hint works for both pointer and keyboard users.
 */
export function LockedLink({
  href,
  locked = false,
  className,
  title,
  onClick,
  active = false,
  children,
}: {
  href: string;
  locked?: boolean;
  className?: string;
  title: string;
  onClick?: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  if (!locked)
    return (
      <Link
        href={href}
        className={className}
        title={title}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
      >
        {children}
      </Link>
    );
  const hint = 'Locked: unlock editing to use this.';
  return (
    <a
      href={href}
      className={`${className ?? ''} locked-control`}
      aria-disabled="true"
      aria-current={active ? 'page' : undefined}
      title={hint}
      onClick={(event) => event.preventDefault()}
    >
      {children}
      <Lock className="locked-indicator" size={14} aria-label={hint} />
    </a>
  );
}

/** A focusable action that explains why it is unavailable without running it. */
export function LockedButton({
  locked = false,
  className,
  title,
  onClick,
  children,
}: {
  locked?: boolean;
  className?: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const hint = 'Locked: unlock editing to use this.';
  return (
    <button
      type="button"
      className={`${className ?? ''}${locked ? ' locked-control' : ''}`}
      aria-disabled={locked || undefined}
      title={locked ? hint : title}
      onClick={locked ? undefined : onClick}
    >
      {children}
      {locked && <Lock className="locked-indicator" size={14} aria-label={hint} />}
    </button>
  );
}
