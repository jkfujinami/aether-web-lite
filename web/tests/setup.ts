/**
 * Vitest グローバルセットアップ
 *
 * ブラウザ専用 API のうち、テスト対象コードが同期的に触るものだけを最小限に補う。
 * ネットワーク層 (WebRTC / WebSocket) は各テストが差し込むフェイクで代替するため、
 * ここでは埋めない。
 */
import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util';
import sodium from 'libsodium-wrappers-sumo';
import { beforeAll } from 'vitest';

// ── TextEncoder / TextDecoder ──
// jsdom 環境では window が別レルムになり、jsdom 由来の TextEncoder が返す
// Uint8Array が libsodium 側の `instanceof Uint8Array` を通らない
// ("unsupported input type for message" になる)。Node のものに揃える。
Object.defineProperty(globalThis, 'TextEncoder', { value: NodeTextEncoder, configurable: true, writable: true });
Object.defineProperty(globalThis, 'TextDecoder', { value: NodeTextDecoder, configurable: true, writable: true });

// ── crypto.getRandomValues / crypto.subtle ──
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// ── localStorage (RingPosition / ZoneManager が使用) ──
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number) { return Array.from(this.map.keys())[index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}

// ── btoa / atob (Encoding が使用) ──
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
}

// libsodium は WASM の初期化が非同期なので、全テストの前に一度だけ待つ。
beforeAll(async () => {
  await sodium.ready;
});
