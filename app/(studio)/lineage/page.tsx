import type { Metadata } from 'next';

import { LineageView } from './lineage-view';

export const metadata: Metadata = { title: 'Lineage' };

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `?focus=query:<slug>` (or `chart:<id>`, `table:<name>`…) opens on one item. */
export default async function LineagePage({ searchParams }: Props) {
  const { focus } = await searchParams;
  return (
    <LineageView initialFocus={typeof focus === 'string' ? focus : undefined} />
  );
}
