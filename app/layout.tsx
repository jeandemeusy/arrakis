import type { Metadata } from "next";
import "./globals.css";

const publicSiteUrl = process.env.PUBLIC_SITE_URL;

export const metadata: Metadata = {
  metadataBase: publicSiteUrl ? new URL(publicSiteUrl) : undefined,
  title: "Gnosis VPN — Network Intelligence",
  description:
    "Public, on-chain Gnosis VPN adoption and HOPR network metrics powered by Blokli.",
  openGraph: {
    title: "Gnosis VPN — Network Intelligence",
    description:
      "Private access. Public proof. Finalized on-chain metrics powered by Blokli.",
    type: "website",
    images: publicSiteUrl
      ? [
          {
            url: "/og.png",
            width: 1731,
            height: 909,
            alt: "Gnosis VPN — Private access. Public proof.",
          },
        ]
      : [],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gnosis VPN — Network Intelligence",
    description:
      "Private access. Public proof. Finalized on-chain metrics powered by Blokli.",
    images: publicSiteUrl ? ["/og.png"] : [],
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
