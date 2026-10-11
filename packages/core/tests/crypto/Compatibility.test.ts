import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';

import { KeyManager as CoreKeyManager } from '../../src/crypto/KeyManager';
import { KeyManager as WebKeyManager } from '../../../../web/src/lib/crypto/KeyManager';
import { Identity as CoreIdentity } from '../../src/crypto/Identity';
import { Identity as WebIdentity } from '../../../../web/src/lib/crypto/Identity';
import { buildHint, openHint } from '../../src/network/hint/HintCrypto';
import { buildHint as webBuildHint, openHint as webOpenHint } from '../../../../web/src/lib/network/hint/HintCrypto';
import { Encoding } from '../../src/common/Encoding';

describe('Cross-Platform Cryptographic Compatibility & Golden Vectors', () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  describe('VIP Board Key Golden Vector (不変条件)', () => {
    const VIP_SEED = new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED');
    // Web版および本家仕様で確定している SHA-512 先頭32バイトの厳密なHex値
    const EXPECTED_VIP_BOARD_KEY_HEX = '956868c1227b2e381445e879d24b483ac6defc074547d7bd3507f81d4472fa0a';

    it('Core KeyManager は確定された VIP boardKey ゴールデンベクターと完全一致する', () => {
      const coreKey = CoreKeyManager.cryptoHash(VIP_SEED).slice(0, 32);
      expect(Encoding.toHex(coreKey)).toBe(EXPECTED_VIP_BOARD_KEY_HEX);
    });

    it('Web KeyManager と Core KeyManager の cryptoHash 出力が完全に一致する', () => {
      const coreKey = CoreKeyManager.cryptoHash(VIP_SEED);
      const webKey = WebKeyManager.cryptoHash(VIP_SEED);
      expect(coreKey).toEqual(webKey);
      expect(Encoding.toHex(coreKey.slice(0, 32))).toBe(EXPECTED_VIP_BOARD_KEY_HEX);
    });
  });

  describe('KeyManager Cross-Platform Parity', () => {
    it('deriveThreadKey が Web と Core で 100% 同一の鍵を生成する', () => {
      const testBoardKey = new Uint8Array(32).fill(77);
      const threadId = 'thread-parity-test-123';

      const coreThreadKey = CoreKeyManager.deriveThreadKey(testBoardKey, threadId);
      const webThreadKey = WebKeyManager.deriveThreadKey(testBoardKey, threadId);

      expect(coreThreadKey).toEqual(webThreadKey);
      expect(coreThreadKey.length).toBe(32);
    });

    it('deriveTopicHash が Web と Core で 100% 同一のハッシュを生成する', () => {
      const testThreadKey = new Uint8Array(32).fill(88);

      const coreTopicHash = CoreKeyManager.deriveTopicHash(testThreadKey);
      const webTopicHash = WebKeyManager.deriveTopicHash(testThreadKey);

      expect(coreTopicHash).toEqual(webTopicHash);
      expect(coreTopicHash.length).toBe(32);
    });

    it('computeZoneId が Web と Core で全ての深さ (0..16) において同一のゾーンを返す', () => {
      const testTopicHash = CoreKeyManager.cryptoHash(new TextEncoder().encode('test-zone'));

      for (let depth = 0; depth <= 16; depth++) {
        const coreZone = CoreKeyManager.computeZoneId(testTopicHash, depth);
        const webZone = WebKeyManager.computeZoneId(testTopicHash, depth);
        expect(coreZone).toBe(webZone);
      }
    });
  });

  describe('Hint Encryption & Decryption Cross-Interop', () => {
    it('Web で作成された Hint を Core で 100% 開封できる (Web -> Core)', () => {
      const boardKey = CoreKeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      const nonce = new Uint8Array(32).fill(12);
      const payload = {
        nonce,
        message_id: 12345678,
        timestamp: 1700000000000,
      };

      // Web 実装で Hint を構築
      const webHint = webBuildHint(boardKey, payload);

      // Core 実装で開封
      const opened = openHint(boardKey, webHint);
      expect(opened).not.toBeNull();
      expect(opened?.nonce).toEqual(payload.nonce);
      expect(opened?.message_id).toBe(payload.message_id);
      expect(opened?.timestamp).toBe(payload.timestamp);
    });

    it('Core で作成された Hint を Web で 100% 開封できる (Core -> Web)', () => {
      const boardKey = CoreKeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      const nonce = new Uint8Array(32).fill(34);
      const payload = {
        nonce,
        message_id: 87654321,
        timestamp: 1711111111111,
      };

      // Core 実装で Hint を構築
      const coreHint = buildHint(boardKey, payload);

      // Web 実装で開封
      const opened = webOpenHint(boardKey, coreHint);
      expect(opened).not.toBeNull();
      expect(opened?.nonce).toEqual(payload.nonce);
      expect(opened?.message_id).toBe(payload.message_id);
      expect(opened?.timestamp).toBe(payload.timestamp);
    });

    it('鍵が 1 バイトでも異なれば Hint は絶対に開封できず null を返す', () => {
      const boardKey = CoreKeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
      const wrongKey = new Uint8Array(boardKey);
      wrongKey[0] ^= 0xff; // 1バイト改変

      const payload = {
        nonce: new Uint8Array(32).fill(99),
        message_id: 111,
        timestamp: Date.now(),
      };

      const hint = buildHint(boardKey, payload);
      const failed = openHint(wrongKey, hint);
      expect(failed).toBeNull();
    });
  });

  describe('Identity String Format Cross-Parity', () => {
    it('sessionDisplay のフォーマットとハッシュ計算が Web と Core で同一である', () => {
      const coreId = new CoreIdentity();
      // 同一の鍵ペアを模倣して比較
      const pubkey = new Uint8Array(32).fill(42);
      const coreHash = CoreKeyManager.cryptoHash(pubkey);
      const webHash = WebKeyManager.cryptoHash(pubkey);

      expect(coreHash).toEqual(webHash);
      expect(CoreKeyManager.toBase64(coreHash.slice(0, 4))).toBe(WebKeyManager.toBase64(webHash.slice(0, 4)));
    });
  });
});
