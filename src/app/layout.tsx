import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter wordt self-hosted door next/font (geen externe request, geen flits).
// De CSS in globals.css gebruikt var(--font-inter).
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter"
});

export const metadata: Metadata = {
  applicationName: "Tracker",
  title: "Tracker",
  description: "Beveiligde inkoop- en verkooptracker",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Tracker" }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2563eb" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" }
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

// Zet het thema vóór de eerste paint zodat er geen lichte/donkere flits is.
const themeScript = `(function(){try{var t=localStorage.getItem('snus_theme');if(t!=='dark'&&t!=='light'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Nonce van de proxy/middleware (CSP) zodat het inline thema-script niet wordt geblokkeerd.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="nl" className={inter.variable} suppressHydrationWarning>
      <body>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
