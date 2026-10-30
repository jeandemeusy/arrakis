import type { Metadata } from 'next';

import { ExitSettings } from './exit-settings';

export const metadata: Metadata = { title: 'Exits' };

export default function NetworksPage() {
  return <ExitSettings />;
}
