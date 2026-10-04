import type { Metadata } from "next";
import { Urbanist } from "next/font/google";
import "./globals.css";

const urbanist = Urbanist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-urbanist",
});

export const metadata: Metadata = {
  title: "ENTERPRISER",
  description: "Sistemas de gestão da ENTERPRISER",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={urbanist.variable}>
      <body className={urbanist.className}>{children}</body>
    </html>
  );
}
