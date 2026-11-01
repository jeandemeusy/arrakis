import type { Metadata } from 'next';

import { BundleSettings } from './bundle-settings';

export const metadata: Metadata = {
  title: 'Bundled dashboards',
  robots: { index: false, follow: false },
};

export default function BundlesPage() {
  return <BundleSettings />;
}
