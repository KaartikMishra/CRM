import type { Metadata } from 'next';
import { Cormorant_Garamond, IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

/*
  Three faces, three jobs. The serif carries the brand and nothing else; the
  sans carries the interface; the mono carries anything that lines up in a
  column — enquiry numbers, rates, quantities, the SLA clock.
*/
const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
});

const serif = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-cormorant',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'RoyalStuffs CRM', template: '%s · RoyalStuffs CRM' },
  description: 'Internal CRM for RoyalStuffs.com',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-full font-sans antialiased">
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: 'border border-line bg-surface text-ink shadow-raised',
              description: 'text-muted',
            },
          }}
        />
      </body>
    </html>
  );
}
