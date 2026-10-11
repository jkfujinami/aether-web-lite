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

// ── TextEncoder / TextDecoder (★レルム跨ぎの是正) ──
//
// jsdom 環境では `globalThis.Uint8Array` が jsdom のものに差し替わる一方、
// `TextEncoder` は (jsdom 由来でも node:util 由来でも) **Node レルムの**
// Uint8Array を返す。結果として
//
//   new TextEncoder().encode(s) instanceof Uint8Array  → false
//
// となり、libsodium の入力型チェックが
// `TypeError: unsupported input type for message` で落ちる。
//
// 「Node のものに揃える」のは解決にならない (むしろ逆方向)。
// 実測: jsdom の TextEncoder も node:util の TextEncoder も、
//       どちらも現行レルムの instanceof を通らなかった。
//
// 出力を現行レルムの Uint8Array へコピーして返す形に包む。
// これは中身を変えないので、本番コード側には一切手を入れなくてよい。
class RealmSafeTextEncoder extends NodeTextEncoder {
  encode(input?: string) {
    const src = super.encode(input);
    // 長さ指定で確保すると現行レルムの ArrayBuffer が裏に付く
    const out = new Uint8Array(src.length);
    out.set(src);
    return out;
  }
}

Object.defineProperty(globalThis, 'TextEncoder', {
  value: RealmSafeTextEncoder, configurable: true, writable: true,
});
Object.defineProperty(globalThis, 'TextDecoder', {
  value: NodeTextDecoder, configurable: true, writable: true,
});

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
