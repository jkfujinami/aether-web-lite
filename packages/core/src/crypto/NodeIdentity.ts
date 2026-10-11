import sodium from './sodium';
import { Encoding } from '../common/Encoding';
import { meetsDifficulty } from './PowPolicy';

/**
 * NodeIdentity — Bound Identity (本家 AETHER 18.5.3)
 *
 * 旧実装の欠陥:
 *   peerId は randomBytes(16)、position は乱数で、両者に何の関係もなかった。
 *   さらに JOIN ハンドラが相手の申告した position を無検証で採用していた。
 *   結果として攻撃者は
 *     - 狙った topicHash の真隣に着地して K=5 の保持者になる
 *     - 特定ノードを取り囲んで eclipse する
 *     - リング上の連続した弧を占拠して範囲内の全コンテンツを支配する
 *   が自由にできた。
 *
 * 対策 (Bound Identity):
 *   peerId   = SHA256("AETHER/v3/peerid"   ‖ pubkey)[0..16]
 *   position = SHA256("AETHER/v3/position" ‖ peerId)[0..8] / 2^64
 *
 *   position は peerId の純粋関数なので、ネットワーク上で position を
 *   「申告」する必要がなくなる。受信側は peerId から自分で導出する。
 *   これだけで position 詐称という攻撃面が丸ごと消える。
 *
 *   さらに peerId は pubkey に束縛されるため、狙った座標に着地するには
 *   鍵をグラインドするしかない。Ed25519 の鍵生成は毎秒数十万回できるので、
 *   これを NodeId PoW (Argon2id) で殴って現実的でないコストにする。
 *
 *   ハッシュ関数の使い分けは本家 18.11 に従う:
 *     - Gossip PoW  : SHA-256   (全ノードが全件検証するので限界まで軽く)
 *     - NodeId PoW  : Argon2id  (検証は新規ピア登録時のみ。ASIC 優位を潰す)
 */

/** Argon2id ベースの NodeId PoW パラメータ */
export interface NodeIdPowParams {
  /** 要求する先頭ゼロビット数 */
  difficulty: number;
  /** Argon2id opslimit (t_cost) */
  opsLimit: number;
  /** Argon2id memlimit (bytes)。Rust 側は KiB に直して渡す */
  memLimit: number;
}

/**
 * 既定パラメータ。
 *
 * 実測 (libsodium WASM, Node 20): memLimit=1MiB / opsLimit=1 で 1 ハッシュ 3.4ms。
 *   - 採掘: difficulty=10 → 平均 1024 回 ≒ 3.5 秒。端末ごとに一度だけ払えばよく、
 *     以降は IndexedDB から復元するので起動のたびには掛からない。
 *   - 検証: 常に 1 ハッシュ = 3.4ms。隣人 16 人でも 55ms。
 *     ただし検証はそれなりに重いので、呼び出し側で
 *     (a) 安価な束縛検査と署名検査を先に通す (b) 結果を pubkey 単位でキャッシュする
 *     (c) レートリミッタで JOIN の頻度を絞る、の 3 点を必ず併用すること。
 *
 * difficulty を上げるほど座標グラインドのコストが 2 倍ずつ増えるが、
 * 初回起動の待ち時間も 2 倍になる。運用規模に応じて調整する値。
 */
export const NODE_ID_POW: NodeIdPowParams = {
  difficulty: 10,
  opsLimit: 1,
  memLimit: 1 << 20,
};

/** テストや開発環境で採掘待ちを避けるための軽量パラメータ */
export const NODE_ID_POW_FAST: NodeIdPowParams = {
  difficulty: 4,
  opsLimit: 1,
  memLimit: 8192,
};

/** Argon2id の salt (16 バイト固定)。ドメイン分離子として使う。 */
const NODE_ID_SALT = new Uint8Array([
  0x41, 0x45, 0x54, 0x48, 0x45, 0x52, 0x2f, 0x76, // "AETHER/v"
  0x33, 0x2f, 0x6e, 0x6f, 0x64, 0x65, 0x69, 0x64, // "3/nodeid"
]);

const PEER_ID_DOMAIN = new TextEncoder().encode('AETHER/v3/peerid');
const POSITION_DOMAIN = new TextEncoder().encode('AETHER/v3/position');
const JOIN_DOMAIN = new TextEncoder().encode('AETHER/v3/join');

/** peerId のバイト長 (hex 表記では 32 文字) */
export const PEER_ID_BYTES = 16;

/** チャレンジのバイト長 */
export const CHALLENGE_BYTES = 32;

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u64be(value: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), false);
  return buf;
}

/**
 * ネットワーク上でピアが自分を名乗るときの主張。
 * position は含まない (peerId から導出できるため、載せると詐称の余地が生まれる)。
 */
export interface NodeClaim {
  /** hex 32 文字 */
  peerId: string;
  /** Ed25519 公開鍵 (32 バイト) */
  pubkey: Uint8Array;
  /** NodeId PoW の解 (u64) */
  powCounter: number;
}

/** 所有証明つきの JOIN メッセージ */
export interface SignedNodeClaim extends NodeClaim {
  /** 相手から受け取った challenge をそのまま echo する */
  challenge: Uint8Array;
  /** Ed25519(JOIN_DOMAIN ‖ challenge) */
  signature: Uint8Array;
}

export class NodeIdentity {
  private constructor(
    public readonly peerId: string,
    public readonly position: number,
    public readonly pubkey: Uint8Array,
    private readonly privkey: Uint8Array,
    public readonly powCounter: number,
  ) {}

  // ── 導出 (純粋関数) ──

  /** peerId = SHA256("AETHER/v3/peerid" ‖ pubkey)[0..16] を hex 化 */
  static derivePeerId(pubkey: Uint8Array): string {
    const h = sodium.crypto_hash_sha256(concat([PEER_ID_DOMAIN, pubkey]));
    return Encoding.toHex(h.slice(0, PEER_ID_BYTES));
  }

  /**
   * position = SHA256("AETHER/v3/position" ‖ peerIdBytes)[0..8] / 2^64
   *
   * peerId から一意に定まるので、ネットワークから受け取った peerId に対して
   * 各ノードが独立に計算する。申告された position は一切信用しない。
   */
  static derivePosition(peerId: string): number {
    const idBytes = Encoding.fromHex(peerId);
    const h = sodium.crypto_hash_sha256(concat([POSITION_DOMAIN, idBytes]));
    const view = new DataView(h.buffer, h.byteOffset, 8);
    // 2^64 で割って [0, 1) に写す。Number は 53bit しか持てないが、
    // リング座標としての分解能は十分 (2^53 分割)。
    return Number(view.getBigUint64(0, false)) / 18446744073709551616;
  }

  /** NodeId PoW のハッシュ: Argon2id(pubkey ‖ counter, salt=固定) */
  static nodeIdPowHash(
    pubkey: Uint8Array,
    counter: number,
    params: NodeIdPowParams = NODE_ID_POW,
  ): Uint8Array {
    return sodium.crypto_pwhash(
      32,
      concat([pubkey, u64be(counter)]),
      NODE_ID_SALT,
      params.opsLimit,
      params.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  }

  // ── 検証 ──

  /**
   * peerId が pubkey に束縛されており、かつ NodeId PoW を満たすかを検証する。
   * 所有証明 (署名) は含まないので、{@link verifySignedClaim} と併用すること。
   */
  static verifyClaim(claim: NodeClaim, params: NodeIdPowParams = NODE_ID_POW): boolean {
    if (typeof claim?.peerId !== 'string') return false;
    if (claim.peerId.length !== PEER_ID_BYTES * 2) return false;
    if (!/^[0-9a-f]+$/.test(claim.peerId)) return false;

    const pubkey = claim.pubkey instanceof Uint8Array ? claim.pubkey : null;
    if (!pubkey || pubkey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false;

    if (!Number.isSafeInteger(claim.powCounter) || claim.powCounter < 0) return false;

    // 1. peerId が pubkey のハッシュであること
    if (NodeIdentity.derivePeerId(pubkey) !== claim.peerId) return false;

    // 2. NodeId PoW を満たすこと (座標グラインドのコストを引き上げる)
    if (params.difficulty > 0) {
      const hash = NodeIdentity.nodeIdPowHash(pubkey, claim.powCounter, params);
      if (!meetsDifficulty(hash, params.difficulty)) return false;
    }

    return true;
  }

  /**
   * 所有証明つきの検証。
   *
   * challenge は「検証する側が生成してその場で送った乱数」でなければならない。
   * これが無いと、攻撃者が他人の JOIN を傍受してそのまま再生し、
   * 被害者になりすませてしまう (replay)。
   */
  static verifySignedClaim(
    claim: SignedNodeClaim,
    expectedChallenge: Uint8Array,
    params: NodeIdPowParams = NODE_ID_POW,
  ): boolean {
    if (!NodeIdentity.verifyClaim(claim, params)) return false;

    const challenge = claim.challenge instanceof Uint8Array ? claim.challenge : null;
    const signature = claim.signature instanceof Uint8Array ? claim.signature : null;
    if (!challenge || !signature) return false;
    if (challenge.length !== expectedChallenge.length) return false;

    // タイミング差で challenge を推測されないよう定数時間比較を使う
    if (!sodium.memcmp(challenge, expectedChallenge)) return false;

    try {
      return sodium.crypto_sign_verify_detached(
        signature,
        concat([JOIN_DOMAIN, challenge]),
        claim.pubkey,
      );
    } catch {
      return false;
    }
  }

  /** 検証する側が送るチャレンジを生成する */
  static newChallenge(): Uint8Array {
    return sodium.randombytes_buf(CHALLENGE_BYTES);
  }

  // ── 生成・復元 ──

  /**
   * 新しいノード identity を採掘する。
   *
   * NodeId PoW を満たす鍵ペアが出るまで鍵生成を繰り返す方式ではなく、
   * 鍵ペアは 1 つ固定してカウンタを回す。こうすると秘密鍵が変わらないので
   * 「一度採掘したら永続化して使い回す」が成立する。
   */
  static async mine(params: NodeIdPowParams = NODE_ID_POW): Promise<NodeIdentity> {
    await sodium.ready;
    const kp = sodium.crypto_sign_keypair();
    const counter = NodeIdentity.solveNodeIdPow(kp.publicKey, params);
    return NodeIdentity.fromKeyPair(kp.publicKey, kp.privateKey, counter);
  }

  /** 与えられた公開鍵に対する PoW 解を探索する */
  static solveNodeIdPow(pubkey: Uint8Array, params: NodeIdPowParams = NODE_ID_POW): number {
    if (params.difficulty <= 0) return 0;
    for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
      if (meetsDifficulty(NodeIdentity.nodeIdPowHash(pubkey, counter, params), params.difficulty)) {
        return counter;
      }
    }
    throw new Error('NodeIdentity: PoW search exhausted');
  }

  /** 永続化済みの鍵ペアから復元する */
  static fromKeyPair(pubkey: Uint8Array, privkey: Uint8Array, powCounter: number): NodeIdentity {
    const peerId = NodeIdentity.derivePeerId(pubkey);
    const position = NodeIdentity.derivePosition(peerId);
    return new NodeIdentity(peerId, position, pubkey, privkey, powCounter);
  }

  // ── 自分を名乗る ──

  /** 署名なしの主張 (トラッカーへの join 等) */
  claim(): NodeClaim {
    return { peerId: this.peerId, pubkey: this.pubkey, powCounter: this.powCounter };
  }

  /** 相手のチャレンジに署名した主張 (P2P の JOIN) */
  signClaim(challenge: Uint8Array): SignedNodeClaim {
    return {
      ...this.claim(),
      challenge,
      signature: sodium.crypto_sign_detached(concat([JOIN_DOMAIN, challenge]), this.privkey),
    };
  }

  /** 永続化用。秘密鍵を含むので取り扱い注意 */
  exportSecret(): { pubkey: Uint8Array; privkey: Uint8Array; powCounter: number } {
    return { pubkey: this.pubkey, privkey: this.privkey, powCounter: this.powCounter };
  }
}
