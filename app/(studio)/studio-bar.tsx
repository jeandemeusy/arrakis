'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogIn, LogOut } from 'lucide-react';

import { StyleSwitch } from '../style';
import { useSession } from './session';

const LINKS = [
  { href: '/queries', label: 'Queries' },
  { href: '/settings/networks', label: 'Exits' },
];

export function StudioBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, unavailable, signOut } = useSession();

  return (
    <>
      <header className="topbar studio-bar">
        <div className="studio-bar-start">
          <Link className="brand" href="/" aria-label="Dashboard">
            <Image src="/gnosis-owl.svg" alt="" width={230} height={230} />
          </Link>
          <span className="studio-name">Studio</span>
          <nav aria-label="Studio navigation">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={
                  pathname.startsWith(link.href) ? 'page' : undefined
                }
              >
                {link.label}
              </Link>
            ))}
            <Link href="/">Dashboard</Link>
          </nav>
        </div>
        <div className="topbar-end">
          <StyleSwitch />
          {user === undefined ? null : user ? (
            <button
              type="button"
              className="studio-link"
              onClick={() => void signOut().then(() => router.refresh())}
            >
              <LogOut size={14} aria-hidden="true" />
              Lock editing
            </button>
          ) : (
            <Link
              className="studio-link"
              href={`/login?next=${encodeURIComponent(pathname)}`}
            >
              <LogIn size={14} aria-hidden="true" />
              Unlock editing
            </Link>
          )}
        </div>
      </header>
      {unavailable && <output className="studio-banner">{unavailable}</output>}
    </>
  );
}
