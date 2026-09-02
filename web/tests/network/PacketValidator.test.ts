import { describe, it, expect, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type { GossipPacket } from '@/lib/types';
import { PacketValidator } from '@/lib/network/gossip/PacketValidator';
import { POW_POLICY, derivePacketId } from '@/lib/crypto/PowPolicy';
import { DifficultyEstimator } from '@/lib/crypto/DifficultyEstimator';
import { PacketBuilder } from '@/lib/crypto/PacketBuilder';
import {
  buildValidPacket,
  forgePacketWithoutPow,
  forgePacketWithPow,
  testBoardKey,
} from '../helpers/packets';

let valid: GossipPacket;

beforeAll(async () => {
  await sodium.ready;
  // console.warn を黙らせる (拒否理由は check() の戻り値で検証する)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  valid = await buildValidPacket(testBoardKey());
});

describe('正常系', () => {
  it('PacketBuilder が作ったパケットは検証を通る', () => {
    expect(PacketValidator.check(valid)).toEqual({ ok: true });
  });

  it('hop_count は中継で増えても通る (PoW のコミット対象外)', () => {
    for (const hop of [0, 1, 15, POW_POLICY.MAX_HOP_COUNT]) {
      expect(PacketValidator.check({ ...valid, hop_count: hop }), `hop=${hop}`).toEqual({ ok: true });
    }
  });
});

describe('★S級#1: PoW の申告値バイパス', () => {
  it('pow_difficulty=0 のパケットを拒否する', () => {
    // 旧実装ではこれが素通りしていた:
    //   PoWEngine.verify(payload, nonce, 0) → `if (difficulty === 0) return true`
    const packet = forgePacketWithoutPow({ pow_difficulty: 0 });
    expect(PacketValidator.check(packet)).toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('MIN_DIFFICULTY 未満は、その難易度を正しく解いていても拒否する', () => {
    for (let d = 1; d < POW_POLICY.MIN_DIFFICULTY; d++) {
      const packet = forgePacketWithPow(d);
      const result = PacketValidator.check(packet);
      expect(result, `difficulty=${d}`).toEqual({ ok: false, reason: 'insufficient-pow' });
    }
  });

  it('difficulty を高く申告しただけで PoW を解いていないパケットを拒否する', () => {
    const packet = forgePacketWithoutPow({ pow_difficulty: 20, pow_nonce: 12345 });
    expect(PacketValidator.check(packet)).toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('MAX_DIFFICULTY 超過の申告を拒否する', () => {
    const packet = forgePacketWithoutPow({ pow_difficulty: POW_POLICY.MAX_DIFFICULTY + 1 });
    expect(PacketValidator.check(packet)).toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('DifficultyEstimator の下限とネットワークの受理下限が一致している', () => {
    // ここがずれると「自分が作ったパケットを他人が全部弾く」か
    // 「弾くべきものを通す」のどちらかになる
    expect(DifficultyEstimator.MIN_DIFFICULTY).toBe(POW_POLICY.MIN_DIFFICULTY);
    expect(DifficultyEstimator.MAX_DIFFICULTY).toBeLessThanOrEqual(POW_POLICY.MAX_DIFFICULTY);
  });
});

describe('★S級#2: ヘッダ改竄によるリプレイ増幅', () => {
  it('timestamp を差し替えたパケットを拒否する', () => {
    // 攻撃: 傍受したパケットの timestamp を現在時刻に書き換えて再放流する。
    // SeenCache の TTL は 15 分なので、旧実装では 16 分ごとに永久に増幅できた。
    const replayed = { ...valid, timestamp: valid.timestamp + 20 * 60 * 1000 };
    const result = PacketValidator.check(replayed, { now: replayed.timestamp });
    expect(result).toEqual({ ok: false, reason: 'packet-id-mismatch' });
  });

  it('timestamp と packet_id を両方つじつま合わせしても PoW で落ちる', () => {
    // 攻撃者が packet_id も計算し直した場合。CHK は通るが PoW が合わない。
    const ts = valid.timestamp + 20 * 60 * 1000;
    const header = { ...PacketBuilder.committedHeaderOf(valid), timestamp: ts };
    const replayed = { ...valid, timestamp: ts, packet_id: derivePacketId(header) };
    expect(PacketValidator.check(replayed, { now: ts })).toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('zone_id を別ゾーンへ付け替えたパケットを拒否する', () => {
    const moved = { ...valid, zone_id: valid.zone_id + 1 };
    expect(PacketValidator.check(moved).ok).toBe(false);
  });

  it('payload を 1 バイト書き換えたパケットを拒否する', () => {
    const payload = Uint8Array.from(valid.payload);
    payload[0] ^= 0xff;
    expect(PacketValidator.check({ ...valid, payload }).ok).toBe(false);
  });

  it('nonce を書き換えたパケットを拒否する', () => {
    const nonce = Uint8Array.from(valid.nonce);
    nonce[0] ^= 0xff;
    expect(PacketValidator.check({ ...valid, nonce }).ok).toBe(false);
  });

  it('pow_nonce を書き換えたパケットを拒否する', () => {
    expect(PacketValidator.check({ ...valid, pow_nonce: valid.pow_nonce + 1 }))
      .toEqual({ ok: false, reason: 'insufficient-pow' });
  });

  it('packet_id だけ差し替えたパケットを拒否する (CHK)', () => {
    const packet = { ...valid, packet_id: 'a'.repeat(64) };
    expect(PacketValidator.check(packet)).toEqual({ ok: false, reason: 'packet-id-mismatch' });
  });
});

describe('形式・範囲の検証', () => {
  const cases: Array<[string, any, string]> = [
    ['null', null, 'malformed'],
    ['非オブジェクト', 'nope', 'malformed'],
    ['packet_id が文字列でない', { packet_id: 123 }, 'bad-packet-id-type'],
    ['packet_id の長さ違い', { packet_id: 'abc' }, 'bad-packet-id-type'],
  ];

  for (const [name, packet, reason] of cases) {
    it(`${name} を拒否する`, () => {
      expect(PacketValidator.check(packet as any)).toEqual({ ok: false, reason });
    });
  }

  it('timestamp が数値でないパケットを拒否する', () => {
    expect(PacketValidator.check({ ...valid, timestamp: 'now' as any }))
      .toEqual({ ok: false, reason: 'bad-timestamp' });
    expect(PacketValidator.check({ ...valid, timestamp: NaN }))
      .toEqual({ ok: false, reason: 'bad-timestamp' });
    expect(PacketValidator.check({ ...valid, timestamp: -1 }))
      .toEqual({ ok: false, reason: 'bad-timestamp' });
  });

  it('空ペイロードを拒否する', () => {
    expect(PacketValidator.check({ ...valid, payload: new Uint8Array(0) }))
      .toEqual({ ok: false, reason: 'bad-payload-size' });
  });

  it('MAX_PAYLOAD_SIZE 超過を拒否する', () => {
    const payload = new Uint8Array(POW_POLICY.MAX_PAYLOAD_SIZE + 1);
    expect(PacketValidator.check({ ...valid, payload }))
      .toEqual({ ok: false, reason: 'bad-payload-size' });
  });

  it('nonce 長が違うパケットを拒否する', () => {
    expect(PacketValidator.check({ ...valid, nonce: new Uint8Array(11) }))
      .toEqual({ ok: false, reason: 'bad-nonce-size' });
    expect(PacketValidator.check({ ...valid, nonce: new Uint8Array(13) }))
      .toEqual({ ok: false, reason: 'bad-nonce-size' });
  });

  it('hop_count の範囲外を拒否する', () => {
    expect(PacketValidator.check({ ...valid, hop_count: -1 }))
      .toEqual({ ok: false, reason: 'bad-hop-count' });
    expect(PacketValidator.check({ ...valid, hop_count: POW_POLICY.MAX_HOP_COUNT + 1 }))
      .toEqual({ ok: false, reason: 'bad-hop-count' });
    expect(PacketValidator.check({ ...valid, hop_count: 1.5 }))
      .toEqual({ ok: false, reason: 'bad-hop-count' });
  });

  it('pow_nonce が不正な型でも例外を投げずに拒否する', () => {
    // BigInt(1.5) は TypeError を投げる。ここで落とさないと
    // 受信ループごと巻き込まれる。
    for (const bad of [1.5, -1, NaN, Infinity, '0' as any, null as any]) {
      expect(() => PacketValidator.check({ ...valid, pow_nonce: bad }))
        .not.toThrow();
      expect(PacketValidator.check({ ...valid, pow_nonce: bad }))
        .toEqual({ ok: false, reason: 'bad-pow-nonce' });
    }
  });
});

describe('時刻ドリフト', () => {
  it('15分より古いライブパケットを拒否する', () => {
    const now = valid.timestamp + POW_POLICY.MAX_TIME_DRIFT + 1000;
    expect(PacketValidator.check(valid, { now })).toEqual({ ok: false, reason: 'time-drift' });
  });

  it('未来日付のパケットを拒否する', () => {
    const now = valid.timestamp - POW_POLICY.MAX_TIME_DRIFT - 1000;
    expect(PacketValidator.check(valid, { now })).toEqual({ ok: false, reason: 'time-drift' });
  });

  it('allowStale なら古いパケットを通す (DHT の過去ログ用)', () => {
    // DHT は過去ログの保管庫なので、何日も前のパケットが正当に入っている。
    // ライブと同じドリフト検査を掛けると過去ログ同期が丸ごと壊れる。
    const now = valid.timestamp + 30 * 24 * 60 * 60 * 1000;
    expect(PacketValidator.check(valid, { now, allowStale: true })).toEqual({ ok: true });
  });

  it('allowStale でも未来日付は拒否する', () => {
    const now = valid.timestamp - POW_POLICY.MAX_TIME_DRIFT - 1000;
    expect(PacketValidator.check(valid, { now, allowStale: true }))
      .toEqual({ ok: false, reason: 'time-drift' });
  });
});

describe('MsgPack 経由の表現揺れ', () => {
  it('payload / nonce が素の配列でも同じ結果になる', () => {
    const asArrays: any = {
      ...valid,
      payload: Array.from(valid.payload),
      nonce: Array.from(valid.nonce),
    };
    expect(PacketValidator.check(asArrays)).toEqual({ ok: true });
  });

  it('payload / nonce が JsonBinary 形式でも同じ結果になる', () => {
    const asJson: any = {
      ...valid,
      payload: { _type: 'Uint8Array', data: Array.from(valid.payload) },
      nonce: { _type: 'Uint8Array', data: Array.from(valid.nonce) },
    };
    expect(PacketValidator.check(asJson)).toEqual({ ok: true });
  });
});
