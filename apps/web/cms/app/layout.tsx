import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ENTERPRISER",
  description: "Sistemas de gestão da ENTERPRISER",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
