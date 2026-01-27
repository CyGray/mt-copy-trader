import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'ByTrader Dashboard',
  description: 'Marine Trader Crypto Bot dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-marine-navy">
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}
