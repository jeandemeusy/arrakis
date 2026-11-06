import type { Metadata } from 'next';

import { BundleSettings } from './bundle-settings';

export const metadata: Metadata = {
  title: 'Bundles',
  robots: { index: false, follow: false },
};

export default function BundlesPage() {
  return <BundleSettings />;
}
