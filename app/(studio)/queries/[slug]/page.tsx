import type { Metadata } from 'next';

import { Workbench } from '../workbench';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await params).slug };
}

export default async function QueryPage({ params }: Props) {
  const { slug } = await params;
  // Keyed by slug so moving between queries starts from a clean workbench.
  return <Workbench key={slug} slug={slug} />;
}
