import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RoyalStuffs CRM',
  description: 'Internal CRM for RoyalStuffs.com',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full font-sans antialiased">{children}</body>
    </html>
  );
}
