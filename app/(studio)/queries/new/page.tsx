import type { Metadata } from 'next';

import { Workbench } from '../workbench';

export const metadata: Metadata = {
  title: 'New query',
  robots: { index: false, follow: false },
};

export default function NewQueryPage() {
  return <Workbench slug={null} />;
}
