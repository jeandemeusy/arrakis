import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Arrakis',
  description:
    'Public, on-chain Gnosis VPN adoption and HOPR network metrics powered by Blokli.',
  openGraph: {
    title: 'Arrakis',
    description:
      'Private access. Public proof. Finalized on-chain metrics powered by Blokli.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arrakis',
    description:
      'Private access. Public proof. Finalized on-chain metrics powered by Blokli.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
