import type { Metadata, Viewport } from "next";
import { LegacyCrm } from "@/components/LegacyCrm";

export const metadata: Metadata = {
  manifest: "/cms.webmanifest",
  applicationName: "ENTERPRISER",
  appleWebApp: { capable: true, title: "ENTERPRISER", statusBarStyle: "black" },
  icons: {
    icon: [
      { url: "/pwa/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [{ url: "/pwa/apple-touch-icon.png", sizes: "180x180" }]
  }
};

export const viewport: Viewport = {
  themeColor: "#0a0e17"
};

export default function CmsPage() {
  return <LegacyCrm assetVersion={process.env.VERCEL_GIT_COMMIT_SHA || "local"} />;
}
