import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { sodiumReady } from '@aether/core';

window.addEventListener('error', (e) => {
  console.error('[UNCAUGHT ERROR]', e.error ? (e.error.stack || e.error) : e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason ? (e.reason.stack || e.reason) : e.reason);
});

async function bootstrap() {
  try {
    await sodiumReady;
    const rootEl = document.getElementById('root');
    if (!rootEl) return;
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (err) {
    console.error('Failed to initialize libsodium or mount UI:', err);
  }
}

bootstrap();
