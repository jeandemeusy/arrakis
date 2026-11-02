import type { Metadata } from 'next';

import { Home } from './home';

export const metadata: Metadata = {
  title: { absolute: 'Arrakis' },
  description:
    'Dashboards, each figure traceable to the saved query behind it.',
};

/** Home: every dashboard, the bundled ones first. */
export default function HomePage() {
  return <Home />;
}
