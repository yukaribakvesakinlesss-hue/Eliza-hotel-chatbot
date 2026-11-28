import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PreferencesProvider } from '@/components/Preferences';
import './globals.css';

export const metadata: Metadata = {
  title: 'AXON PMS',
  description: 'AXON Hotel PMS · room status board',
  robots: { index: false, follow: false }
};

// Theme is applied before paint so light-mode users never see a dark flash.
const themeScript = `try{if(localStorage.getItem('axon-pms-theme')==='light')document.documentElement.classList.add('light')}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700&display=swap" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen font-sans">
        <PreferencesProvider>{children}</PreferencesProvider>
      </body>
    </html>
  );
}
