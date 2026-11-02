'use client';

import { ArrowRight } from 'lucide-react';

import { LockedLink } from '../locked-link';
import { useSession } from '../session';
import { SETTINGS_PAGES } from './settings-pages';

export function SettingsCards() {
  const { user } = useSession();
  return (
    <div className="settings-cards">
      {SETTINGS_PAGES.map((page) => {
        const locked = page.editorOnly && user === null;
        return (
          <LockedLink
            key={page.href}
            href={page.href}
            className="settings-card"
            title={page.title}
            locked={locked}
          >
            <span className="dashboard-card-head">
              <page.icon size={16} aria-hidden="true" />
              {page.title}
              <ArrowRight className="card-arrow" size={15} aria-hidden="true" />
            </span>
            <span>{page.text}</span>
          </LockedLink>
        );
      })}
    </div>
  );
}
