"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { legacyConfig } from "./legacy-config";
import { legacyMarkup } from "./legacy-markup";

export function LegacyCrm({ assetVersion }: { assetVersion: string }) {
  const [configReady, setConfigReady] = useState(false);

  useEffect(() => {
    window.CRM_CONFIG = legacyConfig;
    window.XLSX = XLSX;
    setConfigReady(true);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/cms-sw.js", { scope: "/cms" }).catch(() => {});
    }
  }, []);

  return (
    <>
      <div id="legacy-root" dangerouslySetInnerHTML={{ __html: legacyMarkup }} />
      {configReady ? <Script src={`/legacy/app.js?v=${encodeURIComponent(assetVersion)}`} strategy="afterInteractive" /> : null}
    </>
  );
}

declare global {
  interface Window {
    CRM_CONFIG: typeof legacyConfig;
    XLSX: typeof XLSX;
  }
}
