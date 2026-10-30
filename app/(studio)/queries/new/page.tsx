import type { Metadata } from 'next';

import { Workbench } from '../workbench';

export const metadata: Metadata = { title: 'New query' };

export default function NewQueryPage() {
  return <Workbench slug={null} />;
}
