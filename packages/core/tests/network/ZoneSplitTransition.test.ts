import { describe, it, expect, beforeAll } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { ZoneManager } from '../../src/network/ZoneManager';
import { KeyManager } from '../../src/crypto/KeyManager';
import { RING_MESH_ZONE } from '../../src/constants';
import { FakeNetworkPeerManager, pid } from '../helpers/fakeNetworkPeerManager';
import { MessageDispatcher } from '../../src/network/MessageDispatcher';
import { ZoneGossipRouter } from '../../src/network/gossip/ZoneGossipRouter';
import { DandelionRouter } from '../../src/network/gossip/DandelionRouter';
import { OnionCircuit } from '../../src/network/onion/OnionCircuit';
import { derivePacketId, solvePow } from '../../src/crypto/PowPolicy';
import type { GossipPacket } from '../../src/types';

describe('Zone 分割移行時: ノード間 depth 推定の揺れとパケットロス確率測定', () => {
  beforeAll(async () => {
    await sodiumReady;
  });

  /**
   * 指定した depth を強制的に持つ ZoneManager を生成するヘルパー
   */
  function createZoneManagerWithDepth(depth: number): {
    zm: ZoneManager;
    pm: FakeNetworkPeerManager;
  } {
    const pm = new FakeNetworkPeerManager(pid(0x1));
    const zm = new ZoneManager(pm);
    // 内部 depth と購読ゾーンを更新
    (zm as any)._depth = depth;
    (zm as any).initSubscribedZones();
    return { zm, pm };
  }

  function createMockGossipPacket(zoneId: number): GossipPacket {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const nonce = sodium.randombytes_buf(12);
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const committed = {
      timestamp: now,
      zone_id: zoneId,
      pow_difficulty: 8,
      nonce,
      payload,
    };
    const powNonce = solvePow(committed);
    return {
      packet_id: derivePacketId(committed),
      hop_count: 0,
      pow_nonce: Number(powNonce ?? 0),
      pow_difficulty: committed.pow_difficulty,
      timestamp: committed.timestamp,
      zone_id: zoneId,
      nonce,
      payload,
    };
  }

  describe('1. 閲覧中トピック (Watched Topic) のパケットロス率測定', () => {
    const TEST_PAIRS = [
      { senderDepth: 4, receiverDepth: 5, desc: '境界上昇時 (送信側 depth 4 vs 受信側 depth 5)' },
      { senderDepth: 5, receiverDepth: 4, desc: '境界未反映時 (送信側 depth 5 vs 受信側 depth 4)' },
      { senderDepth: 4, receiverDepth: 6, desc: '2段階乖離 (送信側 depth 4 vs 受信側 depth 6)' },
      { senderDepth: 6, receiverDepth: 4, desc: '2段階乖離 (送信側 depth 6 vs 受信側 depth 4)' },
      { senderDepth: 3, receiverDepth: 5, desc: '大幅乖離 (送信側 depth 3 vs 受信側 depth 5)' },
      { senderDepth: 5, receiverDepth: 7, desc: '深部乖離 (送信側 depth 5 vs 受信側 depth 7: 最大深さ)' },
    ];

    for (const { senderDepth, receiverDepth, desc } of TEST_PAIRS) {
      it(`${desc}: 閲覧中トピックのパケット受容ロス率が 0.00% であること`, () => {
        const TRIALS = 1000;
        const { zm: receiverZm } = createZoneManagerWithDepth(receiverDepth);

        let lostCount = 0;
        let deliveredCount = 0;

        for (let i = 0; i < TRIALS; i++) {
          // ランダムなトピック (板/スレッド)
          const topic = sodium.randombytes_buf(32);

          // 受信側がこのトピックを閲覧中 (watchTopic)
          const unwatch = receiverZm.watchTopic(topic);

          // 送信側が自ノードの depth (senderDepth) で zone_id を計算してパケット作成
          const packetZoneId = KeyManager.computeZoneId(topic, senderDepth);

          // 受信側の ZoneManager で購読判定 (deliverLocal が呼ぶメソッド)
          const accepted = receiverZm.isSubscribed(packetZoneId);

          if (accepted) {
            deliveredCount++;
          } else {
            lostCount++;
          }

          unwatch();
        }

        const lossRate = (lostCount / TRIALS) * 100;
        console.log(`[Watched Topic 測定] ${desc}: 試行数=${TRIALS}, 到達=${deliveredCount}, ロス=${lostCount}, ロス率=${lossRate.toFixed(2)}%`);

        // ★ 判定仕様: 0 <= d <= MAX_DEPTH の全 depth を走査するため、ロス率は厳密に 0%
        expect(lostCount).toBe(0);
        expect(lossRate).toBe(0.0);
        expect(deliveredCount).toBe(TRIALS);
      });
    }
  });

  describe('2. 中継フラッディング (Relay Flooding) におけるドロップ率測定', () => {
    it('中継ノードの推定 depth が不一致でも、Broadcast Veil により中継ドロップ率が 0.00% (全網中継) であること', () => {
      // 送信側 (depth 4) -> 中継ノードA (depth 5) -> 中継ノードB (depth 6) -> 受信ノード (depth 4)
      const pmA = new FakeNetworkPeerManager(pid(0xa));
      const pmB = new FakeNetworkPeerManager(pid(0xb));
      const dispA = new MessageDispatcher();
      const dispB = new MessageDispatcher();

      const { zm: zmA } = createZoneManagerWithDepth(5);
      const { zm: zmB } = createZoneManagerWithDepth(6);

      const dandeA = new DandelionRouter(pmA);
      const dandeB = new DandelionRouter(pmB);
      const circuitA: any = { onExit: () => {} };
      const circuitB: any = { onExit: () => {} };

      const routerA = new ZoneGossipRouter(pmA, dispA, zmA, dandeA, circuitA);
      const routerB = new ZoneGossipRouter(pmB, dispB, zmB, dandeB, circuitB);

      // A の隣人に B を登録、B の隣人に C (終端) を登録
      pmA.addPeer(pid(0xb));
      pmB.addPeer(pid(0xc));

      const TRIALS = 500;
      let floodedThroughCount = 0;

      for (let i = 0; i < TRIALS; i++) {
        const topic = sodium.randombytes_buf(32);
        // 送信側 depth 4 で付与
        const zoneId = KeyManager.computeZoneId(topic, 4);
        const packet = createMockGossipPacket(zoneId);

        // A にパケットが届く
        (routerA as any).handleGossip(pid(0x9), { packet });

        // A が B へ flood したか確認
        const sentByA = pmA.sent.find(s => (s.payload as any)?.packet?.packet_id === packet.packet_id);
        expect(sentByA).toBeDefined();

        // B に届く
        (routerB as any).handleGossip(pid(0xa), { packet });

        // B が C へ flood したか確認
        const sentByB = pmB.sent.find(s => (s.payload as any)?.packet?.packet_id === packet.packet_id);
        expect(sentByB).toBeDefined();

        floodedThroughCount++;
      }

      const relayDropRate = ((TRIALS - floodedThroughCount) / TRIALS) * 100;
      console.log(`[Relay Flood 測定] 異種 depth 混成中継: 試行数=${TRIALS}, 中継完遂=${floodedThroughCount}, 中継ドロップ率=${relayDropRate.toFixed(2)}%`);
      expect(relayDropRate).toBe(0.0);
    });
  });

  describe('3. 非閲覧トピック (バックグラウンド保持・未閲覧) の受容確率測定', () => {
    it('非閲覧パケットの受容確率: depth 4 では 100%、depth 5 では ~50%、depth 6 では ~25% と理論値に収束すること', () => {
      const TRIALS = 2000;

      // 受信側 depth 4 (ゾーン数 16 <= 16: 全ゾーン購読)
      const { zm: zmDepth4 } = createZoneManagerWithDepth(4);
      // 受信側 depth 5 (ゾーン数 32: 16 ゾーン購読)
      const { zm: zmDepth5 } = createZoneManagerWithDepth(5);
      // 受信側 depth 6 (ゾーン数 64: 16 ゾーン購読)
      const { zm: zmDepth6 } = createZoneManagerWithDepth(6);

      let acceptedD4 = 0;
      let acceptedD5 = 0;
      let acceptedD6 = 0;
      let acceptedMismatchD4toD5 = 0;

      for (let i = 0; i < TRIALS; i++) {
        const topic = sodium.randombytes_buf(32);

        // (a) 同一 depth での受容判定
        const zoneId4 = KeyManager.computeZoneId(topic, 4);
        const zoneId5 = KeyManager.computeZoneId(topic, 5);
        const zoneId6 = KeyManager.computeZoneId(topic, 6);

        if (zmDepth4.isSubscribed(zoneId4)) acceptedD4++;
        if (zmDepth5.isSubscribed(zoneId5)) acceptedD5++;
        if (zmDepth6.isSubscribed(zoneId6)) acceptedD6++;

        // (b) 境界移行時の食い違い: 送信側が depth 4 (zoneId4 ∈ [0..15]) で送り、受信側が depth 5 の場合
        if (zmDepth5.isSubscribed(zoneId4)) acceptedMismatchD4toD5++;
      }

      const rateD4 = (acceptedD4 / TRIALS) * 100;
      const rateD5 = (acceptedD5 / TRIALS) * 100;
      const rateD6 = (acceptedD6 / TRIALS) * 100;
      const rateMismatch = (acceptedMismatchD4toD5 / TRIALS) * 100;

      console.log(`[非閲覧パケット受容確率 測定] (試行数=${TRIALS}):`);
      console.log(`  - depth 4 (ゾーン数 16): 受容率 = ${rateD4.toFixed(1)}% (理論値: 100.0%)`);
      console.log(`  - depth 5 (ゾーン数 32): 受容率 = ${rateD5.toFixed(1)}% (理論値: 50.0%)`);
      console.log(`  - depth 6 (ゾーン数 64): 受容率 = ${rateD6.toFixed(1)}% (理論値: 25.0%)`);
      console.log(`  - 送信 depth 4 vs 受信 depth 5 (移行過渡期): 受容率 = ${rateMismatch.toFixed(1)}% (理論値: ~50.0%)`);

      // 検証:
      // depth 4 は全受容 (100%)
      expect(rateD4).toBe(100.0);

      // depth 5 は 16/32 = 50% (許容誤差 ±5%)
      expect(rateD5).toBeGreaterThan(45);
      expect(rateD5).toBeLessThan(55);

      // depth 6 は 16/64 = 25% (許容誤差 ±5%)
      expect(rateD6).toBeGreaterThan(20);
      expect(rateD6).toBeLessThan(30);

      // 移行期 (送信 depth 4 vs 受信 depth 5) も ~50% で受容される
      expect(rateMismatch).toBeGreaterThan(40);
      expect(rateMismatch).toBeLessThan(60);
    });
  });
});
