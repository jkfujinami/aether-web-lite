import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { KeyManager } from '../../src/crypto/KeyManager';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import type { IIdentity } from '../../src/types';

const keyManager = {
  deriveThreadKey: KeyManager.deriveThreadKey,
  deriveTopicHash: KeyManager.deriveTopicHash,
  computeZoneId: KeyManager.computeZoneId,
};
const powEngine = { compute: async (h: any) => PoWEngine.computeSync(h) };

function identityWith(tripPubkey: Uint8Array | null, tripSign: ((d: Uint8Array) => Uint8Array) | null): IIdentity {
  const session = sodium.crypto_sign_keypair();
  return {
    sign: (data: Uint8Array) => ({
      sessionPubkey: session.publicKey,
      sessionSignature: sodium.crypto_sign_detached(data, session.privateKey),
      tripPubkey,
      tripSignature: tripSign ? tripSign(data) : null,
    }),
  };
}

async function roundTrip(identity: IIdentity) {
  const threadKey = sodium.randombytes_buf(32);
  const engine = new CryptoEngine();
  const packet = await PacketBuilder.build(
    'hello', threadKey, identity, engine, powEngine, keyManager, 'b', 't', 0, null, 8, 0,
  );
  return PacketBuilder.verifyAndDecrypt(packet, threadKey, engine);
}

describe('PacketBuilder トリップ署名', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('トリップ無しの投稿は trip_pubkey=null で受理される', async () => {
    const post = await roundTrip(identityWith(null, null));
    expect(post).not.toBeNull();
    expect(post.trip_pubkey).toBeNull();
  });

  it('正しいトリップ署名は受理され、公開鍵が返る', async () => {
    const trip = sodium.crypto_sign_keypair();
    const post = await roundTrip(identityWith(trip.publicKey, d => sodium.crypto_sign_detached(d, trip.privateKey)));
    expect(post).not.toBeNull();
    expect(Array.from(post.trip_pubkey)).toEqual(Array.from(trip.publicKey));
  });

  it('他人のトリップ公開鍵に不正な署名を付けた投稿は拒否される', async () => {
    const victim = sodium.crypto_sign_keypair();
    const post = await roundTrip(identityWith(victim.publicKey, () => new Uint8Array(64)));
    expect(post).toBeNull();
  });

  it('トリップ公開鍵だけで署名の無い投稿は拒否される', async () => {
    const victim = sodium.crypto_sign_keypair();
    const post = await roundTrip(identityWith(victim.publicKey, null));
    expect(post).toBeNull();
  });
});
