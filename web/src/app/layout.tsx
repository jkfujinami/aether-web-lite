import type { Metadata } from "next";
import { Space_Grotesk, Inter, Space_Mono } from "next/font/google";
import "./globals.css";
import { P2PProvider } from "@/providers/P2PProvider";
import { AppHeader } from "@/components/AppHeader";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "AETHER Web-Lite v2",
  description: "Dual-Strand IPv4/IPv6 P2P Network",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="light">
      <body className={`${spaceGrotesk.variable} ${inter.variable} ${spaceMono.variable}`}>
        <div id="app" className="app-root">
          <P2PProvider>
            <AppHeader />
            <main>
              {children}
            </main>
          </P2PProvider>
        </div>
      </body>
    </html>
  );
}
