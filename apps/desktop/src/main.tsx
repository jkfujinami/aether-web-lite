import React from 'react';
import ReactDOM from 'react-dom/client';
import { AetherApp } from '@aether/ui';
import '@aether/ui/styles.css';
import { sodiumReady } from '@aether/core';

window.addEventListener('error', (e) => {
  console.error('[UNCAUGHT ERROR]', e.error ? (e.error.stack || e.error) : e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason ? (e.reason.stack || e.reason) : e.reason);
});

/**
 * トラッカーの既定値 (開発用)。配布物に入れると全利用者がその相手に接続するので、
 * 入れるなら運営者と配布元を明示すること。検証を通らない値は使われない。
 */
const DEFAULT_TRACKER_URL: string | null = import.meta.env.VITE_AETHER_TRACKER_URL || null;

async function bootstrap() {
  try {
    await sodiumReady;
    const rootEl = document.getElementById('root');
    if (!rootEl) return;
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <AetherApp badge="Desktop Full Node" defaultTrackerUrl={DEFAULT_TRACKER_URL} />
      </React.StrictMode>,
    );
  } catch (err) {
    console.error('Failed to initialize libsodium or mount UI:', err);
  }
}

bootstrap();
