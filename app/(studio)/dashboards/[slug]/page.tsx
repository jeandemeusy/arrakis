import type { Metadata } from 'next';

import { DashboardView } from '../dashboard-view';
import { Favorite, Visit } from '../../personal';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await params).slug };
}

export default async function DashboardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const search = await searchParams;
  // Variables travel in the address (`?range=7d&client=0x…`) so a view can be
  // linked to exactly; `edit` opens the layout editor.
  const initial: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' && key !== 'edit') initial[key] = value;
  }
  return (
    <>
      <Visit item={{ kind: 'dashboard', slug }} />
      <div className="personal-page-action">
        <Favorite item={{ kind: 'dashboard', slug }} />
      </div>
      <DashboardView
        key={slug}
        slug={slug}
        initialVars={initial}
        initialEditing={search.edit === '1'}
      />
    </>
  );
}
