import type { Metadata } from 'next';

import { RunsMonitor } from './runs-monitor';

export const metadata: Metadata = {
  title: 'Query health',
  robots: { index: false, follow: false },
};

export default function RunsPage() {
  return <RunsMonitor />;
}
