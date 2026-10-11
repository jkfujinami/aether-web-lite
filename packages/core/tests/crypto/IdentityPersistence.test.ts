import { describe, it, expect, beforeAll } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { NodeIdentityStore } from '../../src/crypto/NodeIdentityStore';
import { Identity, type SealedStore } from '../../src/crypto/Identity';
import { SecretVault, VAULT_PARAMS_FAST } from '../../src/storage/SecretVault';

const FAST = { difficulty: 0, opsLimit: 1, memLimit: 8192 };

function memoryStore(): SealedStore & { slots: Map<string, any> } {
  const slots = new Map<string, any>();
  return {
    slots,
    async getSealed(slot) { return slots.get(slot); },
    async saveSealed(slot, sealed, meta) { slots.set(slot, { sealed, meta }); },
    async deleteSealed(slot) { slots.delete(slot); },
  };
}

describe('端末に残す秘密の扱い (H4)', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  it('既定 (ephemeral) ではノード鍵を保存せず、起動ごとに別の peerId になる', async () => {
    const store = memoryStore();
    const a = await NodeIdentityStore.mineEphemeral(store, FAST);
    const b = await NodeIdentityStore.mineEphemeral(store, FAST);
    expect(a.peerId).not.toBe(b.peerId);
    expect(store.slots.size).toBe(0);
  });

  it('以前の版が保護なしで保存したノード鍵は ephemeral 起動時に消す', async () => {
    const store = memoryStore();
    await store.saveSealed('node', SecretVault.seal(new Uint8Array(96), '', VAULT_PARAMS_FAST), { powCounter: 0 });
    await NodeIdentityStore.mineEphemeral(store, FAST);
    expect(store.slots.has('node')).toBe(false);
  });

  it('パスフレーズで保護された保存済みの鍵は ephemeral 起動でも消さない', async () => {
    const store = memoryStore();
    await store.saveSealed('node', SecretVault.seal(new Uint8Array(96), 'pw', VAULT_PARAMS_FAST), { powCounter: 0 });
    await NodeIdentityStore.mineEphemeral(store, FAST);
    expect(store.slots.has('node')).toBe(true);
  });

  it('永続化にはパスフレーズが必須で、正しいパスフレーズでのみ同じ peerId に戻る', async () => {
    const store = memoryStore();
    await expect(NodeIdentityStore.loadOrMine(store, '', FAST, VAULT_PARAMS_FAST)).rejects.toThrow(RangeError);

    const first = await NodeIdentityStore.loadOrMine(store, 'correct horse', FAST, VAULT_PARAMS_FAST);
    expect(store.slots.get('node').sealed.protected).toBe(true);
    const again = await NodeIdentityStore.loadOrMine(store, 'correct horse', FAST, VAULT_PARAMS_FAST);
    expect(again.peerId).toBe(first.peerId);
  });

  it('トリップは空のパスフレーズでは生成・保存できない', async () => {
    const store = memoryStore();
    const id = new Identity();
    await expect(id.generateTrip(store, '', VAULT_PARAMS_FAST)).rejects.toThrow(RangeError);
    expect(store.slots.size).toBe(0);

    await id.generateTrip(store, 'pw', VAULT_PARAMS_FAST);
    expect(store.slots.get('trip').sealed.protected).toBe(true);
  });
});
