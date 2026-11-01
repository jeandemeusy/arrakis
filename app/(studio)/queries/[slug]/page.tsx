import type { Metadata } from 'next';

import { Workbench } from '../workbench';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await params).slug, robots: { index: false, follow: false } };
}

export default async function QueryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const search = await searchParams;
  const one = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;
  // Keyed by slug so moving between queries starts from a clean workbench.
  // `?tab=charts&chart=<id>` opens one of its charts: where a dashboard tile
  // links to.
  return (
    <Workbench
      key={slug}
      slug={slug}
      initialTab={one(search.tab)}
      initialChart={one(search.chart)}
    />
  );
}
