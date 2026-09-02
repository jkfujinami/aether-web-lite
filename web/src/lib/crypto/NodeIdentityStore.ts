import sodium from './sodium';
import { NodeIdentity, NODE_ID_POW, type NodeIdPowParams } from './NodeIdentity';
import { SecretVault, VAULT_PARAMS, type VaultParams } from '../storage/SecretVault';
import type { SealedStore } from './Identity';

const NODE_SLOT = 'node';

/**
 * ノード identity の永続化。
 *
 * NodeId PoW (Argon2id) の採掘は既定パラメータで数秒かかるので、
 * 一度採掘したら封印して保存し、次回以降は復元する。
 *
 * 秘密鍵は {@link SecretVault} で封印してから書く。生で置くと、
 * 押収時に「このノードはリングのこの座標にいた」ことが確定してしまう。
 */
export class NodeIdentityStore {
  /**
   * 保存済みの identity を復元する。無ければ採掘して保存する。
   *
   * @param passphrase 封印のパスフレーズ。未設定なら空文字。
   */
  static async loadOrMine(
    store: SealedStore,
    passphrase: string = '',
    params: NodeIdPowParams = NODE_ID_POW,
    vaultParams: VaultParams = VAULT_PARAMS,
  ): Promise<NodeIdentity> {
    await sodium.ready;

    const restored = await NodeIdentityStore.tryLoad(store, passphrase, params);
    if (restored) {
      console.log(`[NodeIdentityStore] Restored node identity ${restored.peerId.substring(0, 8)}`);
      return restored;
    }

    console.log(`[NodeIdentityStore] Mining new node identity (difficulty ${params.difficulty})...`);
    const started = Date.now();
    const identity = await NodeIdentity.mine(params);
    console.log(
      `[NodeIdentityStore] Mined ${identity.peerId.substring(0, 8)} in ${Date.now() - started}ms ` +
      `(bound position: ${identity.position.toFixed(6)})`,
    );

    await NodeIdentityStore.save(store, identity, passphrase, vaultParams);
    return identity;
  }

  private static async tryLoad(
    store: SealedStore,
    passphrase: string,
    params: NodeIdPowParams,
  ): Promise<NodeIdentity | null> {
    const record = await store.getSealed(NODE_SLOT).catch(() => undefined);
    if (!record) return null;

    const secret = SecretVault.open(record.sealed, passphrase);
    if (!secret) {
      console.warn(`[NodeIdentityStore] Could not unseal node identity.`);
      return null;
    }

    const skBytes = sodium.crypto_sign_SECRETKEYBYTES;
    const pkBytes = sodium.crypto_sign_PUBLICKEYBYTES;
    if (secret.length !== skBytes + pkBytes) return null;

    const powCounter = record.meta?.powCounter;
    if (!Number.isSafeInteger(powCounter) || powCounter < 0) return null;

    const identity = NodeIdentity.fromKeyPair(
      secret.slice(skBytes),
      secret.slice(0, skBytes),
      powCounter,
    );

    // 難易度を引き上げた後などは、保存済みの解が今の基準を満たさない。
    // その場合は捨てて採掘し直す (満たさない identity で参加しても弾かれる)。
    if (!NodeIdentity.verifyClaim(identity.claim(), params)) {
      console.warn(`[NodeIdentityStore] Stored identity no longer meets NodeId PoW policy — re-mining.`);
      return null;
    }

    return identity;
  }

  private static async save(
    store: SealedStore,
    identity: NodeIdentity,
    passphrase: string,
    vaultParams: VaultParams,
  ): Promise<void> {
    const secret = identity.exportSecret();
    const blob = new Uint8Array(secret.privkey.length + secret.pubkey.length);
    blob.set(secret.privkey, 0);
    blob.set(secret.pubkey, secret.privkey.length);

    // powCounter は秘密ではない (どうせ JOIN で全員に送る) ので meta に置く
    await store.saveSealed(NODE_SLOT, SecretVault.seal(blob, passphrase, vaultParams), {
      powCounter: secret.powCounter,
      peerId: identity.peerId,
    });
  }
}
