"use client";

import dynamic from "next/dynamic";

/**
 * `Ask` reads `localStorage` (the X-User-Id) while rendering and streams SSE off the
 * gateway, so it cannot server-render — `app/api.ts` is client-only by design. Loading it
 * with `ssr: false` keeps the prerender to a shell and mounts the app in the browser.
 */
const Ask = dynamic(() => import("@/components/Ask").then((m) => m.App), {
  ssr: false,
  loading: () => <div className="empty">Loading…</div>,
});

export default function Home() {
  return <Ask route="app" />;
}
