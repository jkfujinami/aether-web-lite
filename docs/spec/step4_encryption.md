# Step 4: 暗号化 — 詳細仕様

**ステータス**: 📝 設計中
**更新日**: 2026-03-20
**前提**: Step 1-3 完了（Ring-Mesh + Zone + Gossip + Mailbox）
**参照**: `aether_web_lite_design.md` §5, §6.8, §9, §10

---

## 1. 概要

AETHERの暗号化は**3つの独立したレイヤー**で構成される:

```
┌─────────────────────────────────────────────────┐
│ Layer 3: PoW (Proof of Work)                    │
│  パケット外側（平文部分）に付与                    │
│  スパム防止・帯域保護                              │
├─────────────────────────────────────────────────┤
│ Layer 2: 共通鍵暗号 (ChaCha20-Poly1305)          │
│  thread_key で暗号化                              │
│  URLを知る人だけが復号可能                          │
├─────────────────────────────────────────────────┤
│ Layer 1: 署名 (Ed25519)                          │
│  投稿者の認証・改竄検知                            │
│  暗号化の内側に配置                                │
└─────────────────────────────────────────────────┘
```

---

## 2. 鍵の階層構造

### 2.1 鍵派生ツリー

```
[boardkey]   ← 板のURL (#以降) に埋め込み。32バイトのランダム値。
    │
    ├── thread_key = HMAC-SHA256(boardkey, "thread:" + thread_id)
    │     │   └── レスの暗号化/復号に使用（32バイト）
    │     │
    │     ├── topic_hash = SHA256(thread_key)
    │     │     └── DHT Mailbox の検索キー（32バイト）
    │     │         thread_keyを知らないと計算できない
    │     │
    │     └── zone_id = topic_hash[0..depth_bits]
    │           └── Adaptive Zoneの自動配置に使用
    │
    └── board_topic_hash = SHA256(boardkey)
          └── 板全体のMailbox検索キー（スレッド一覧の保管先）
```

### 2.2 鍵の種類と管理

```typescript
interface KeyHierarchy {
  /** 板の共通鍵（URLフラグメントから取得） */
  boardkey: Uint8Array;          // 32 bytes, ランダム生成

  /** スレッドの暗号化鍵（boardkeyから派生） */
  threadKey: Uint8Array;         // 32 bytes, HMAC-SHA256(boardkey, "thread:"+id)

  /** DHTの検索キー（thread_keyから派生） */
  topicHash: Uint8Array;         // 32 bytes, SHA256(thread_key)

  /** ゾーンID（topic_hashの先頭ビット） */
  zoneId: number;                // 0..4095, topic_hash[0..depth]
}
```

### 2.3 URL形式

```
公開板:
  https://reiwa-2ch.net/board/vip#boardkey=Base64URL(32bytes)

秘密スレッド（板と無関係な独立鍵）:
  https://reiwa-2ch.net/secret#key=Base64URL(32bytes)

URLフラグメント (#以降) は:
  - HTTPリクエストに含まれない → サーバーに鍵が渡らない
  - ブラウザのアドレスバーに表示される → コピペで共有可能
  - JavaScriptの location.hash で取得可能
```

### 2.4 実装

```typescript
// KeyManager.ts

import { crypto_auth, crypto_hash } from 'libsodium-wrappers';

export class KeyManager {
  /**
   * URLフラグメントからboardkeyを抽出
   */
  static parseBoardKey(url: string): Uint8Array {
    const hash = new URL(url).hash;  // "#boardkey=XXXX"
    const params = new URLSearchParams(hash.slice(1));
    const b64 = params.get('boardkey') ?? params.get('key');
    if (!b64) throw new Error('No key in URL');
    return base64UrlDecode(b64);
  }

  /**
   * boardkey → thread_key を派生
   */
  static deriveThreadKey(boardkey: Uint8Array, threadId: string): Uint8Array {
    // HMAC-SHA256(boardkey, "thread:" + threadId)
    return crypto_auth(
      new TextEncoder().encode(`thread:${threadId}`),
      boardkey,
    );
  }

  /**
   * thread_key → topic_hash を派生
   */
  static deriveTopicHash(threadKey: Uint8Array): Uint8Array {
    return crypto_hash(threadKey).slice(0, 32);
  }

  /**
   * topic_hash → zone_id を計算
   */
  static computeZoneId(topicHash: Uint8Array, depth: number): number {
    if (depth === 0) return 0;
    const bits = (topicHash[0] << 8 | topicHash[1]) >> (16 - depth);
    return bits;
  }

  /**
   * 新しい板の鍵を生成
   */
  static generateBoardKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  /**
   * 秘密スレッドの独立鍵を生成
   */
  static generateSecretThreadKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
  }
}
```

---

## 3. ChaCha20-Poly1305 暗号化

### 3.1 なぜChaCha20-Poly1305か

| 暗号方式 | 速度(WASM) | AEAD | ストリーム暗号 | 採用 |
|:---------|:-----------|:----:|:--------:|:----:|
| AES-256-GCM | 高速(HW) | ✅ | ❌ | ❌ |
| **ChaCha20-Poly1305** | **高速(SW)** | **✅** | **✅** | **✅** |
| XChaCha20-Poly1305 | 高速(SW) | ✅ | ✅ | △ |

- **AEAD (Authenticated Encryption with Associated Data)**: 暗号化と認証が一体化。改竄検知が自動。
- **ストリーム暗号**: 部分復号が可能 → マジックバイトフィルタに必須。
- **ソフトウェア実装が高速**: WASM/JSでもナノ秒レベルのXOR演算。AES-NI非対応のモバイルでも高速。
- **libsodium.js**: `crypto_aead_chacha20poly1305_ietf_encrypt/decrypt` で利用可能。

### 3.2 暗号化フロー

```typescript
// CryptoEngine.ts

import sodium from 'libsodium-wrappers';

export class CryptoEngine {
  private static readonly MAGIC = new Uint8Array([0x41, 0x45, 0x54, 0x48]); // "AETH"
  private static readonly NONCE_SIZE = 12; // IETF ChaCha20-Poly1305 nonce

  /**
   * 暗号化（送信時）
   *
   * plaintext = "AETH" + msgpack(innerPayload)
   * → ChaCha20-Poly1305(thread_key, nonce, plaintext)
   */
  static encrypt(
    threadKey: Uint8Array,
    innerPayload: Uint8Array,
  ): { ciphertext: Uint8Array; nonce: Uint8Array } {
    // マジックバイトを先頭に付与
    const plaintext = new Uint8Array(4 + innerPayload.length);
    plaintext.set(CryptoEngine.MAGIC, 0);
    plaintext.set(innerPayload, 4);

    // ランダムnonce生成
    const nonce = sodium.randombytes_buf(CryptoEngine.NONCE_SIZE);

    // AEAD暗号化（認証タグ16B付き）
    const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      plaintext,
      null,     // additional data (なし)
      null,     // nsec (未使用)
      nonce,
      threadKey,
    );

    return { ciphertext, nonce };
  }

  /**
   * 復号（受信時）
   *
   * 成功: innerPayload (マジックバイト除去済み)
   * 失敗: null
   */
  static decrypt(
    threadKey: Uint8Array,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
  ): Uint8Array | null {
    try {
      const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
        null,       // nsec
        ciphertext,
        null,       // additional data
        nonce,
        threadKey,
      );

      // マジックバイト検証
      if (plaintext.length < 4) return null;
      if (plaintext[0] !== 0x41 || plaintext[1] !== 0x45 ||
          plaintext[2] !== 0x54 || plaintext[3] !== 0x48) return null;

      // マジックバイト除去して返す
      return plaintext.slice(4);
    } catch {
      return null; // 復号失敗（鍵が違う or 改竄検知）
    }
  }
}
```

### 3.3 マジックバイト部分復号フィルタ

```
Broadcast Veil では全パケットを全thread_keyで復号を試みる。
フル復号は重いので、先頭4バイトだけの超軽量判定を行う。

ChaCha20がストリーム暗号のため:
  ciphertext[0..3] XOR keystream[0..3] = plaintext[0..3]
  → plaintext[0..3] == "AETH" なら自分宛て

実装:
  1. ChaCha20のキーストリーム先頭4バイトを生成
     keystream = ChaCha20Block(thread_key, nonce, counter=1) // counter=1はAEAD仕様
  2. ciphertext[0..3] XOR keystream[0..3] を計算
  3. 結果が "AETH" (0x41455448) か判定

コスト:
  フル復号: ~500ns/回 × 1000回/秒 = 500μs/秒
  部分復号: ~5ns/回 (XOR 4回) × 1000回/秒 = 5μs/秒 → 100倍高速
```

```typescript
// MagicFilter.ts

export class MagicFilter {
  private static readonly MAGIC = 0x41455448; // "AETH" as uint32

  /**
   * 先頭4バイトの部分復号で「自分宛てか」を超高速判定
   *
   * @returns true なら自分宛ての可能性 → フル復号実行
   *          false なら確実に無関係 → スキップ
   */
  static quickCheck(
    threadKey: Uint8Array,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
  ): boolean {
    // ChaCha20のキーストリーム先頭ブロックを生成
    // AEADの場合、counter=1が暗号文の先頭に対応
    const keystream = sodium.crypto_stream_chacha20_ietf(
      4,       // 4バイトだけ生成
      nonce,
      threadKey,
    );

    // XORで部分復号
    const magic =
      ((ciphertext[0] ^ keystream[0]) << 24) |
      ((ciphertext[1] ^ keystream[1]) << 16) |
      ((ciphertext[2] ^ keystream[2]) << 8)  |
      ((ciphertext[3] ^ keystream[3]));

    return magic === MagicFilter.MAGIC;
  }
}
```

### 3.4 受信パイプライン

```
パケット受信時の処理フロー:

  for (const threadKey of mySubscribedKeys) {
    // Phase 1: 超高速フィルタ（4バイトXOR、~5ns）
    if (!MagicFilter.quickCheck(threadKey, ciphertext, nonce)) {
      continue;  // ★ 99%以上はここでスキップ
    }

    // Phase 2: フル復号（AEAD、~500ns）
    const payload = CryptoEngine.decrypt(threadKey, ciphertext, nonce);
    if (!payload) continue;  // 誤検知（1/2^32 ≈ 0%）

    // Phase 3: デシリアライズ + 署名検証
    const post = msgpack.decode(payload);
    if (!Identity.verify(post)) continue;

    // Phase 4: UIに表示
    displayPost(post);
    break;  // 復号成功、ループ終了
  }

パフォーマンス（20スレ購読、50パケット/秒）:
  Phase 1: 50 × 20 = 1000回 × 5ns = 5μs/秒 → ゼロコスト
  Phase 2: ~2-3回/秒（ヒットしたときだけ）
  Phase 3: ~2-3回/秒
```

---

## 4. Ed25519 デジタル署名

### 4.1 2種類のアイデンティティ

```
1. セッションID（一時鍵ペア）
   - タブを開くたびに新規生成
   - スレッド内での「ID:XXXXXXXX」に相当
   - 1日経過 or タブを閉じたら消滅
   - 目的: 同一人物の連続投稿を紐付ける（自演防止）

2. トリップ（永続鍵ペア）
   - IndexedDBに永続保存
   - 2chの「◆トリップ」と同等の機能
   - 目的: IPが変わっても同一人物であることを暗号学的に証明
   - 任意: 使わなくてもOK（名無し投稿可能）
```

### 4.2 鍵の生成と管理

```typescript
// Identity.ts

export class Identity {
  /** セッションID（一時的） */
  private sessionKeyPair: sodium.KeyPair;
  /** トリップ（永続的、オプション） */
  private tripKeyPair: sodium.KeyPair | null = null;

  constructor() {
    // セッション鍵ペアを自動生成
    this.sessionKeyPair = sodium.crypto_sign_keypair();
  }

  /**
   * トリップの初期化（IndexedDBから読み込み or 新規生成）
   */
  async initTrip(db: Database): Promise<void> {
    const stored = await db.getTrip();
    if (stored) {
      this.tripKeyPair = {
        publicKey: stored.publicKey,
        privateKey: stored.privateKey,
        keyType: 'ed25519',
      };
    }
    // トリップなし = 名無し投稿モード（正常）
  }

  /**
   * トリップを新規生成して永続化
   */
  async generateTrip(db: Database): Promise<string> {
    this.tripKeyPair = sodium.crypto_sign_keypair();
    await db.saveTrip(this.tripKeyPair);
    return this.tripDisplay;
  }

  }

  /**
   * セッションIDの表示文字列（8文字）
   * = 公開鍵のSHA256の先頭4バイトのBase64
   */
  get sessionDisplay(): string {
    const hash = sodium.crypto_hash(this.sessionKeyPair.publicKey);
    return base64Encode(hash.slice(0, 4)); // "Abc1Ef==" (8文字)
  }

  /**
   * トリップの表示文字列（10文字）
   * = 公開鍵のSHA256の先頭5バイトのBase64
   */
  get tripDisplay(): string {
    if (!this.tripKeyPair) return '';
    const hash = sodium.crypto_hash(this.tripKeyPair.publicKey);
    return '◆' + base64Encode(hash.slice(0, 5)); // "◆AbCdEfGh==" (12文字)
  }

  /**
   * 投稿データに署名
   */
  sign(postData: Uint8Array): {
    sessionPubkey: Uint8Array;
    sessionSignature: Uint8Array;
    tripPubkey: Uint8Array | null;
    tripSignature: Uint8Array | null;
  } {
    return {
      sessionPubkey: this.sessionKeyPair.publicKey,
      sessionSignature: sodium.crypto_sign_detached(
        postData, this.sessionKeyPair.privateKey,
      ),
      tripPubkey: this.tripKeyPair?.publicKey ?? null,
      tripSignature: this.tripKeyPair
        ? sodium.crypto_sign_detached(postData, this.tripKeyPair.privateKey)
        : null,
    };
  }

  /**
   * 署名検証
   */
  static verify(
    postData: Uint8Array,
    sessionPubkey: Uint8Array,
    sessionSignature: Uint8Array,
  ): boolean {
    return sodium.crypto_sign_verify_detached(
      sessionSignature, postData, sessionPubkey,
    );
  }
}
```

### 4.3 投稿の署名範囲

```
署名対象（改竄検知される範囲）:
  ✅ content         (本文)
  ✅ post_number     (レス番号)
  ✅ reply_to        (アンカー先)
  ✅ created_at      (作成時刻)
  ✅ thread_id       (スレッドID)
  ✅ board_id        (板ID)

署名対象外:
  ❌ hop_count       (中継ノードが書き換える)
  ❌ pow_nonce       (送信者が計算)
  ❌ packet_id       (パケットのハッシュ)
  ❌ timestamp       (外側のタイムスタンプ)
```

---

## 5. 3層パケット構造

### 5.1 パケット全体像

```
┌─────────────────────────────────────── 外側（平文）───┐
│ packet_id      : [32B]  SHA256(payload)              │
│ hop_count      : u8     TTL (0〜30)                  │
│ pow_nonce      : u64    PoW証明ナンス                 │
│ pow_difficulty  : u8     計算時の難易度                │
│ timestamp      : u64    送信時刻 (UNIX ms)            │
│ zone_id        : u16    ★ 宛先ゾーンID               │
│ nonce          : [12B]  ChaCha20ナンス                │
│ payload_size   : u32    暗号化データのサイズ            │
│ payload        : [bytes] 暗号化済みデータ本体          │
├──────────────────── 暗号化層（thread_keyで暗号化）────┤
│ magic          : [4B]   "AETH" (0x41455448)          │
│ board_id       : string  板名 ("vip")                │
│ thread_id      : string  スレッドID ("12345")        │
│ post_type      : u8      0=post, 1=thread_meta       │
│ inner_payload  : [bytes] 署名済みデータ               │
├──────────────────── 署名層（Ed25519署名）─────────────┤
│ content        : string  本文                         │
│ post_number    : u32     レス番号                      │
│ reply_to       : u32?    アンカー先                    │
│ created_at     : u64     作成時刻 (UNIX ms)           │
│ session_pubkey : [32B]   セッション公開鍵              │
│ session_sig    : [64B]   Ed25519署名                  │
│ trip_pubkey    : [32B]?  トリップ公開鍵（任意）        │
│ trip_sig       : [64B]?  トリップ署名（任意）          │
└──────────────────────────────────────────────────────┘
```

### 5.2 各層の可視性

| 層 | 見える人 | 見る目的 |
|:---|:---------|:---------|
| **外側** | 全中継ノード | 重複排除、TTL管理、PoW検証、ゾーンフィルタ |
| **暗号化層** | URLを知る人のみ | どのスレッドか特定、投稿種別判別 |
| **署名層** | URLを知る人のみ | 本文閲覧、投稿者の認証（改竄検知） |

### 5.3 パケットサイズ

```
外側ヘッダー: 32 + 1 + 8 + 1 + 8 + 2 + 12 + 4 = 68 bytes
暗号化層ヘッダー: 4 + ~10 + ~10 + 1 = ~25 bytes
署名層（通常投稿）: ~200B本文 + 4 + 4 + 8 + 32 + 64 = ~312 bytes
Poly1305タグ: 16 bytes

合計: 68 + 25 + 312 + 16 ≈ 421 bytes（通常の短文投稿）
最大: 68 + 25 + 2048 + 16 = 2157 bytes（2KBキャップ適用時）
```

### 5.4 パケット構築フロー

```typescript
// PacketBuilder.ts

export class PacketBuilder {
  static build(
    content: string,
    threadKey: Uint8Array,
    identity: Identity,
    boardId: string,
    threadId: string,
    postNumber: number,
    replyTo: number | null,
    powDifficulty: number,
  ): GossipPacket {
    // Step 1: 署名層を構築
    const signedData = msgpack.encode({
      content,
      post_number: postNumber,
      reply_to: replyTo,
      created_at: Date.now(),
      board_id: boardId,
      thread_id: threadId,
    });

    const sig = identity.sign(signedData);

    const innerPayload = msgpack.encode({
      ...msgpack.decode(signedData),
      session_pubkey: sig.sessionPubkey,
      session_sig: sig.sessionSignature,
      trip_pubkey: sig.tripPubkey,
      trip_sig: sig.tripSignature,
    });

    // Step 2: 暗号化層
    const encPayload = msgpack.encode({
      board_id: boardId,
      thread_id: threadId,
      post_type: 0, // post
      inner_payload: innerPayload,
    });

    const { ciphertext, nonce } = CryptoEngine.encrypt(threadKey, encPayload);

    // Step 3: PoW計算
    const powNonce = PoWEngine.compute(ciphertext, powDifficulty);

    // Step 4: 外側パケット構築
    const packetId = sodium.crypto_hash(ciphertext).slice(0, 32);

    return {
      packet_id: packetId,
      hop_count: 0,
      pow_nonce: powNonce,
      pow_difficulty: powDifficulty,
      timestamp: Date.now(),
      zone_id: KeyManager.computeZoneId(
        KeyManager.deriveTopicHash(threadKey),
        currentDepth,
      ),
      nonce,
      payload: ciphertext,
    };
  }
}
```

---

## 6. PoW (Proof of Work)

### 6.1 目的

```
1. スパム防止: 書き込みに計算コストを強制
2. 帯域保護: 大量の不正パケットを構造的に排除
3. DoS耐性: 攻撃者にも同じ計算コストを要求
```

### 6.2 アルゴリズム: Argon2id (WASM)

```
なぜ Argon2id か:

  SHA256ベースPoW:
    → GPU/ASICで大量並列計算可能 → ボットが有利

  Argon2id:
    → メモリハード関数 → GPU/ASICでの並列化が困難
    → ブラウザのWASM実装で十分な速度（~0.5秒/回）
    → argon2-browser パッケージで利用可能
```

### 6.3 PoW計算

```typescript
// PoWEngine.ts

import argon2 from 'argon2-browser';

export class PoWEngine {
  static readonly PARAMS = {
    type: argon2.ArgonType.Argon2id,
    mem: 1024,        // 1MB メモリ
    time: 1,          // 1イテレーション
    parallelism: 1,
    hashLen: 32,
  };

  /**
   * PoW計算: difficulty ビットの先頭ゼロを見つける
   *
   * 計算対象: Argon2id(payload + nonce_bytes)
   * nonceをインクリメントしてdifficultyを満たすまでループ
   */
  static async compute(
    payload: Uint8Array,
    difficulty: number,
  ): Promise<bigint> {
    let nonce = 0n;

    while (true) {
      const input = concat(payload, bigintToBytes(nonce));
      const result = await argon2.hash({
        ...PoWEngine.PARAMS,
        pass: input,
        salt: input.slice(0, 16), // 先頭16バイトをsaltに使用
      });

      if (PoWEngine.checkDifficulty(result.hash, difficulty)) {
        return nonce;
      }
      nonce++;
    }
  }

  /**
   * PoW検証（受信側: 1回のハッシュ計算だけ）
   */
  static async verify(
    payload: Uint8Array,
    nonce: bigint,
    difficulty: number,
  ): Promise<boolean> {
    const input = concat(payload, bigintToBytes(nonce));
    const result = await argon2.hash({
      ...PoWEngine.PARAMS,
      pass: input,
      salt: input.slice(0, 16),
    });

    return PoWEngine.checkDifficulty(result.hash, difficulty);
  }

  /**
   * ハッシュの先頭 difficulty ビットがゼロか判定
   */
  private static checkDifficulty(hash: Uint8Array, difficulty: number): boolean {
    const fullBytes = Math.floor(difficulty / 8);
    const remainBits = difficulty % 8;

    for (let i = 0; i < fullBytes; i++) {
      if (hash[i] !== 0) return false;
    }

    if (remainBits > 0) {
      const mask = 0xFF << (8 - remainBits);
      if ((hash[fullBytes] & mask) !== 0) return false;
    }

    return true;
  }
}
```

### 6.4 難易度の自律合意

```typescript
// DifficultyEstimator.ts

export class DifficultyEstimator {
  static readonly WINDOW = 100;              // 直近100件
  static readonly TARGET_INTERVAL = 3000;    // 目標: 3秒/件
  static readonly BASE_DIFFICULTY = 12;
  static readonly MIN_DIFFICULTY = 8;
  static readonly MAX_DIFFICULTY = 24;

  /**
   * ローカルの過去ログから難易度を自律計算
   *
   * 全ノードが同じ100件を見ている（Broadcast Veil保証）
   * → 全ノードが同じ難易度を独立計算 → 自然に合意
   */
  static compute(recentTimestamps: number[]): number {
    if (recentTimestamps.length < 2) return DifficultyEstimator.MIN_DIFFICULTY;

    const sorted = [...recentTimestamps].sort((a, b) => a - b);
    const windowSize = Math.min(DifficultyEstimator.WINDOW, sorted.length);
    const elapsed = sorted[sorted.length - 1] - sorted[sorted.length - windowSize];
    const actualInterval = elapsed / windowSize;
    const ratio = DifficultyEstimator.TARGET_INTERVAL / actualInterval;

    const difficulty = Math.round(
      DifficultyEstimator.BASE_DIFFICULTY + Math.log2(ratio),
    );

    return Math.max(
      DifficultyEstimator.MIN_DIFFICULTY,
      Math.min(DifficultyEstimator.MAX_DIFFICULTY, difficulty),
    );
  }
}
```

### 6.5 ペイロードサイズ連動

```
difficulty = baseDifficulty + floor(log2(payload_size / 256))

256B → +0  (基準)
512B → +1
1KB  → +2
2KB  → +3

→ 大きいパケットほどPoWコストが高い → 巨大スパムが困難
```

### 6.6 難易度と計算時間の対応

| 状況 | 投稿間隔 | difficulty | PoW計算時間 |
|:-----|:---------|:-----------|:-----------|
| 過疎 | 1時間/件 | 8 (最低) | ~0.1秒 |
| 平常 | 3秒/件 | 12 | ~0.5秒 |
| 盛況 | 0.3秒/件 | 15 | ~3秒 |
| 炎上 | 0.03秒/件 | 18 | ~30秒 |

---

## 7. パケット検証パイプライン（受信側）

```
パケット受信時の検証順序（早い段階で不正パケットを弾く）:

  1. サイズチェック            → 2KBキャップ超過 → ドロップ
  2. packet_id 重複チェック    → SeenCache にある → ドロップ
  3. hop_count チェック        → 30超過 → ドロップ
  4. timestamp チェック        → 5分以上古い → ドロップ
  5. PoW検証 (Argon2id)        → difficultyを満たさない → ドロップ
  6. SeenCacheに登録           → 以後の重複を防止
  7. hop_count++ してリレー    → ゾーンフィルタリング適用

  ── ここまでは全ノードが実行（平文部分のみ）──

  8. マジックバイト部分復号    → 全thread_keyで4バイトXOR
  9. フル復号 (ChaCha20)       → ヒットしたkeyでAEAD復号
  10. 署名検証 (Ed25519)       → 改竄検知
  11. デシリアライズ           → UIに表示

  ── ここは復号成功時のみ（URLを知る人だけ）──
```

---

## 8. ストレージ (IndexedDB / Dexie.js)

### 8.1 スキーマ定義

```typescript
// Database.ts

import Dexie from 'dexie';

export class AetherDB extends Dexie {
  // Ring-Mesh
  ringPosition!: Dexie.Table<{ key: string; position: number }>;

  // 鍵管理
  boards!: Dexie.Table<{
    boardId: string;
    boardkey: Uint8Array;
    name: string;
    addedAt: number;
  }>;

  // 過去ログ
  posts!: Dexie.Table<{
    id: string;          // packet_id
    boardId: string;
    threadId: string;
    postNumber: number;
    content: string;
    sessionPubkey: Uint8Array;
    tripPubkey: Uint8Array | null;
    createdAt: number;
    receivedAt: number;
  }>;

  // トリップ鍵
  identity!: Dexie.Table<{
    key: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>;

  // Zone設定
  zoneConfig!: Dexie.Table<{
    key: string;
    subscribedZones: number[];
    sessionId: string;  // 交差攻撃防止: セッション紐付け
  }>;

  // SeenCache永続化（タブ復帰時に重複受信を防止）
  seenPackets!: Dexie.Table<{
    packetId: string;
    seenAt: number;
  }>;

  constructor() {
    super('aether-web-lite');

    this.version(1).stores({
      ringPosition: 'key',
      boards: 'boardId',
      posts: 'id, [boardId+threadId], createdAt',
      identity: 'key',
      zoneConfig: 'key',
      seenPackets: 'packetId, seenAt',
    });
  }
}
```

### 8.2 データ量の推定

```
1スレッド × 1000レス × 500B/レス = 500KB
100スレッド = 50MB
1000スレッド = 500MB

IndexedDBのブラウザ上限:
  Chrome: ディスクの80%まで（数百GB）
  Firefox: 2GBまで（超過時に許可ダイアログ）
  Safari: 1GBまで

→ 通常利用では全く問題ない
→ 古い投稿はリングバッファで自動削除（設定可能）
```

### 8.1 パケット構築パイプライン（送信側）

1.  **Serialization**: 本文とメタデータを MessagePack でバイナリ化。
1.1 **Compression**: (Optional) シリアライズ後のデータが一定サイズ（例: 512B）を超える場合、`Deflate` で圧縮。
    *   パケット内のフラグビット（flags.isCompressed）を立てる。
    *   巨大AAや長文レスのサイズを 1/3〜1/5 に削減可能。
2.  **Signing**: 署名対象（payload + metadata）に対して Ed25519 で署名（2種類）。
    *   `session_sig`: セッション鍵による署名（必須）
    *   `trip_sig`: トリップ鍵による署名（任意）
3.  **Encryption**: 署名済みデータを `ChaCha20-Poly1305` で暗号化。
    *   AAD (Additional Authenticated Data) に外側ヘッダーを含め、ヘッダー改竄を防止。
4.  **Packetizing**: 外側ヘッダー（zone_id, hop_count等）を付与。
5.  **PoW**: `Argon2id` で nonce を計算し、PoWヘッダーを確定。

### 8.2 パケット構造図（バイト配列）

```
┌──────────────────────────────────────────────────────────────────┐
│  Outer Header (Plain) : packet_id, zone_id, hop_count, pow_nonce │
├──────────────────────────────────────────────────────────────────┤
│  Encrypted Layer (ChaCha20-Poly1305)                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  "AETH" (Magic Byte Filter)                                │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Compressed Layer (Optional: Deflate)                      │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Signed Payload (MessagePack)                        │  │  │
│  │  │  { body, board_id, thread_id, res_no, timestamp, ... } │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  Signatures: [session_sig (64B), trip_sig (64B)]           │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  Authentication Tag (Poly1305: 16B)                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. 実装上の注意点

### 9.1 libsodium.js の初期化

```typescript
// main.ts

import sodium from 'libsodium-wrappers';

async function init() {
  await sodium.ready;  // ★ WASM読み込み完了を待つ（必須）
  // 以降、Identityの初期化や暗号処理が可能
}
```

### 9.2 Web Worker でのPoW計算

```
PoW計算はメインスレッドをブロックする（0.5〜30秒）。
必ず Web Worker 内で実行すること。

  メインスレッド                  Worker
      │                            │
      │── { type: 'pow-request',──→│
      │    payload, difficulty }    │
      │                            │ argon2.hash() ループ
      │                            │ (0.5〜30秒)
      │←── { type: 'pow-result',──│
      │     nonce }                │
```

### 9.3 nonce の一意性保証

```
ChaCha20-Poly1305 の nonce (12バイト) は同一鍵で再使用すると
暗号の安全性が完全に崩壊する（キーストリーム再利用攻撃）。

対策:
  - 毎回 sodium.randombytes_buf(12) で生成
  - 12バイト = 96ビット → 2^48回使っても衝突確率 < 2^-48
  - 同じthread_keyで2^48回（280兆回）投稿することはあり得ない

★ XChaCha20-Poly1305 (24バイトnonce) を使えばさらに安全だが、
   libsodiumの標準APIで十分なので IETF版 (12バイト) を採用
```

### 9.4 タイムスタンプの信頼性

```
投稿のcreated_atは送信者のローカル時刻。
悪意のある送信者は未来や過去のタイムスタンプを設定できる。

対策:
  - 外側のtimestampチェック: 現在時刻 ± 5分以内でなければドロップ
  - 署名層のcreated_at: 表示用。厳密な時刻順序は保証しない
  - レス番号(post_number): 板の全体でインクリメント
    → 時刻よりもレス番号で順序を決定する

2chの「レス番号」がなぜ重要か:
  → タイムスタンプは偽装可能だが、レス番号はネットワーク合意で決まる
  → 同じスレに同じpost_numberで2つの投稿があれば、先着を採用
```

---

## 10. ファイル構成（Step 4）

```
client/src/crypto/
├── CryptoEngine.ts        # ChaCha20-Poly1305 暗号化/復号
├── MagicFilter.ts         # マジックバイト4B部分復号フィルタ
├── KeyManager.ts          # boardkey → thread_key → topic_hash 派生
├── Identity.ts            # Ed25519 鍵ペア・セッションID・トリップ
├── PoWEngine.ts           # Argon2id WASM PoW計算
├── DifficultyEstimator.ts # 難易度の自律合意計算
└── PacketBuilder.ts       # 3層パケット構築
```
