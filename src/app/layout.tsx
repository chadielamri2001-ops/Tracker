import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tracker",
  description: "Beveiligde inkoop- en verkooptracker"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
