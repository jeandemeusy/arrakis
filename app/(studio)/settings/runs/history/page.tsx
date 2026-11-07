import type { Metadata } from 'next';

import { RunHistory } from './run-history';

export const metadata: Metadata = {
  title: 'All runs',
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Every recorded run, filterable: the table behind the Run time chart. */
export default async function RunHistoryPage({ searchParams }: Props) {
  const search = await searchParams;
  const one = (name: string) =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  return (
    <RunHistory
      initial={{
        query: one('query'),
        network: one('network'),
        status: one('status'),
      }}
    />
  );
}
