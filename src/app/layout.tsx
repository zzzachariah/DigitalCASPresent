import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Source_Sans_3, Source_Code_Pro } from "next/font/google";
import "./globals.css";

// Display face for names and titles (characterful grotesque), body face for
// everything else, mono for metadata. Chinese falls through to the system
// CJK stack (see tailwind.config.ts) — no multi-hundred-KB CJK web font.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
  variable: "--font-display",
  display: "swap",
});
const sans = Source_Sans_3({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  variable: "--font-sans",
  display: "swap",
});
const mono = Source_Code_Pro({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Digital CAS · TOK Exhibition",
  description:
    "Scan a student's code to meet their digital guide and explore their IBDP TOK Exhibition.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1013" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
