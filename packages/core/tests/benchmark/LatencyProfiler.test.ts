import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import sodium, { sodiumReady } from '../../src/crypto/sodium';
import { CIRCUIT_CONFIG } from '../../src/network/onion/OnionCircuit';
import { WireType } from '../../src/network/wire/WireTypes';
import { KeyManager } from '../../src/crypto/KeyManager';
import { CryptoEngine } from '../../src/crypto/CryptoEngine';
import { PoWEngine } from '../../src/crypto/PoWEngine';
import { Identity } from '../../src/crypto/Identity';
import { PacketBuilder } from '../../src/crypto/PacketBuilder';
import { POW_POLICY } from '../../src/crypto/PowPolicy';
import { SchrodingerMailbox } from '../../src/network/hint/SchrodingerMailbox';
import { DHTMailbox } from '../../src/network/mailbox/DHTMailbox';
import { IndexedDBStore } from '../../src/storage/IndexedDBStore';
import {
  createSimNode,
  link,
  startAll,
  stopAll,
  sleep,
  type SimNode,
} from '../helpers/onionNet';

interface BenchAppNode extends SimNode {
  db: IndexedDBStore;
  mailbox: DHTMailbox;
  schrodinger: SchrodingerMailbox;
}

describe('10-Node E2E Latency Profiler', () => {
  it('profiles exact delay of each stage in 10-node network', async () => {
    await sodiumReady;

    console.log('\n================================================================================');
    console.log('⏱️  AETHER 10ノード仮想ネットワーク E2E レイテンシ プロファイリング開始');
    console.log('================================================================================');

    const NODE_COUNT = 10;
    const baseNodes: SimNode[] = [];
    const appNodes: BenchAppNode[] = [];

    // 本番実運用の既定オニオンパラメータ
    const prodCircuitOptions = {
      coverIntervalMs: CIRCUIT_CONFIG.COVER_INTERVAL_MS, // 2000ms
      relayDelayMs: CIRCUIT_CONFIG.RELAY_DELAY_MS,       // 40ms
      exitDelayMs: CIRCUIT_CONFIG.EXIT_DELAY_MS,         // 2500ms
      echoTimeoutMs: CIRCUIT_CONFIG.ECHO_TIMEOUT_MS,     // 45000ms
    };

    // 1. ノード 10 台を生成 (本番の遅延パラメータを注入)
    for (let i = 0; i < NODE_COUNT; i++) {
      const base = await createSimNode(`node_${i}`, prodCircuitOptions);
      baseNodes.push(base);

      const db = new IndexedDBStore(`bench_app_db_${i}`);
      await db.init();
      await db.unlock('bench_password_123');

      const mailbox = new DHTMailbox(base.peerManager, base.dispatcher, db, base.circuit);
      const schrodinger = new SchrodingerMailbox(mailbox, base.hints, base.peerManager, 'adaptive');

      appNodes.push({
        ...base,
        db,
        mailbox,
        schrodinger,
      });
    }

    // 2. 10ノードをメッシュ結合 (リング + クロスリンク)
    for (let i = 0; i < NODE_COUNT; i++) {
      link(baseNodes[i], baseNodes[(i + 1) % NODE_COUNT]);
      link(baseNodes[i], baseNodes[(i + 3) % NODE_COUNT]);
      link(baseNodes[i], baseNodes[(i + 5) % NODE_COUNT]);
    }

    // 全ノード起動
    startAll(baseNodes);

    // Guard の隣人表 (PEX) が届くまで待機
    console.log('⏳ P2P トポロジー構築 & Guard PEX 伝播待機中 (500ms)...');
    await sleep(500);

    // 3. 計測プローブ
    const timestamps: Record<string, number> = {};
    const record = (stage: string) => {
      const now = performance.now();
      if (!timestamps[stage]) {
        timestamps[stage] = now;
      }
    };

    const sender = appNodes[0];
    const receiver = appNodes[9];

    const boardKey = sodium.randombytes_buf(32);
    const boardId = 'vip';
    const threadId = 'test_thread_01';
    const threadKey = KeyManager.deriveThreadKey(boardKey, threadId);

    // 受信ノード（複数）にスレッド鍵を登録し、誰がどの契機で受信したかを記録
    let earlyStoredNode: string | null = null;
    let normalHintNode: string | null = null;

    const normalPeer = appNodes[8]; // 一般ノード
    normalPeer.schrodinger.addKey(`thread:${threadId}`, threadKey);

    // 全ノードの Hint 受信・Body 解決を監視
    const normalPromise = new Promise<{ peerId: string; source: string }>((resolve) => {
      normalPeer.schrodinger.onBody((body, hint) => {
        record('T8_NormalPeerReceived');
        resolve({ peerId: normalPeer.nodeId, source: 'hint_or_storage' });
      });
    });

    // 4. メッセージ投稿シーケンス
    record('T0_Start');

    const cryptoEng = new CryptoEngine();
    const powEng: any = { compute: (h: any) => PoWEngine.compute(h) };
    const keyMgr: any = {
      deriveThreadKey: KeyManager.deriveThreadKey,
      deriveTopicHash: KeyManager.deriveTopicHash,
      computeZoneId: KeyManager.computeZoneId,
    };
    const identityObj = new Identity();

    console.log('🔨 ステップ 1: パケット構築 & PoW 計算開始');
    const packet = await PacketBuilder.build(
      '速度測定テストメッセージ',
      threadKey,
      identityObj,
      cryptoEng,
      powEng,
      keyMgr,
      boardId,
      threadId,
      0,
      null,
      POW_POLICY.NETWORK_DIFFICULTY,
      0,
      0,
      [],
      threadId,
      10
    );
    record('T1_PacketBuilt');

    const rawData = new TextEncoder().encode(JSON.stringify(packet));

    // 受信側ノードの GOSSIP 直接受信を監視 (Layer 1 会話プレーン)
    const gossipReceivedPromise = new Promise<void>((resolve) => {
      normalPeer.gossip.onMessage((receivedPacket) => {
        if (receivedPacket.packet_id === packet.packet_id) {
          record('T_GossipDirectReceived');
          resolve();
        }
      });
    });

    console.log('📦 ステップ 2: スロット準備 (Schrödinger Mailbox)');
    const msgId = Math.floor(Math.random() * 1_000_000);
    const slot = sender.schrodinger.prepareSlot(threadKey, msgId);
    record('T2_SlotPrepared');

    // 送信ノードが Guard にセルを送った瞬間
    const origSend = (sender.peerManager as any).sendMessage.bind(sender.peerManager);
    (sender.peerManager as any).sendMessage = (target: string, type: number, payload: any) => {
      if (type === WireType.ONION_STEM) {
        record('T3_CoverSlotAcquired_SentToGuard');
      }
      return origSend(target, type, payload);
    };

    // Exit ノードで最内層が解かれ Fluff (GOSSIP) が始まった瞬間
    for (const n of appNodes) {
      const origDispatch = n.dispatcher.dispatch.bind(n.dispatcher);
      n.dispatcher.dispatch = (peerId: string, type: number, payload: any) => {
        if (type === WireType.GOSSIP && !timestamps['T4_ExitFloodStarted']) {
          record('T4_ExitFloodStarted');
        }
        return origDispatch(peerId, type, payload);
      };
    }

    console.log('🧅 ステップ 3: Layer 1 単一オニオン回路によるブロードキャスト開始 (Cover待機 + 出口混合)');
    const delivered = await sender.gossip.broadcast(packet, { slot: slot.exitSlot });
    record('T5_EchoConfirmed_BroadcastReturned');

    expect(delivered).toBe(true);
    console.log('📡 ステップ 4: エコー確認完了。受信側での即時 Gossip 到着待機...');

    await gossipReceivedPromise;
    record('T_Layer1Complete');

    console.log('⏳ ステップ 5: 非同期 Hint 放流 (Layer 2 保持者レプリケーション)');
    record('T6_HintReleaseStarted');
    const releaseRes = await sender.schrodinger.releaseHint(slot.hint, rawData.length);
    record('T7_HintReleasedToNetwork');

    await normalPromise;
    record('T9_AllDone');

    // 5. 結果集計
    const t0 = timestamps['T0_Start'];
    const layer1TotalMs = timestamps['T_Layer1Complete'] - t0;
    const fullTotalMs = timestamps['T9_AllDone'] - t0;

    const diff = (from: string, to: string) => {
      if (!timestamps[from] || !timestamps[to]) return 0;
      return Math.max(0, timestamps[to] - timestamps[from]);
    };

    console.log('\n================================================================================');
    console.log('📊 【測定結果】AETHER 2層ハイブリッドアーキテクチャ E2E レイテンシ');
    console.log('================================================================================');

    const p1 = diff('T0_Start', 'T1_PacketBuilt');
    const p2 = diff('T1_PacketBuilt', 'T2_SlotPrepared');
    const p3 = diff('T2_SlotPrepared', 'T3_CoverSlotAcquired_SentToGuard');
    const p4 = diff('T3_CoverSlotAcquired_SentToGuard', 'T4_ExitFloodStarted');
    const p5 = diff('T4_ExitFloodStarted', 'T5_EchoConfirmed_BroadcastReturned');
    const pDirect = diff('T5_EchoConfirmed_BroadcastReturned', 'T_GossipDirectReceived');

    const rows = [
      { phase: '1. PoW & 暗号化パケット生成', timeMs: p1 },
      { phase: '2. メタデータ準備', timeMs: p2 },
      { phase: '3. Cover Traffic 空きスロット待ち', timeMs: p3 },
      { phase: '4. Guard中継 + Exit混合遅延 (Mixing Delay)', timeMs: p4 },
      { phase: '5. Exit本体フラッド & 送信者エコー確認', timeMs: p5 },
      { phase: '6. 受信者ピアへの Gossip 直送・即時反映', timeMs: pDirect },
    ];

    console.table(
      rows.map(r => ({
        'フェーズ': r.phase,
        '所要時間 (ms)': Math.round(r.timeMs),
        '割合 (%)': `${((r.timeMs / layer1TotalMs) * 100).toFixed(1)}%`,
      }))
    );

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`⚡ 【Layer 1: 会話プレーン E2E 反映時間】: ${(layer1TotalMs / 1000).toFixed(2)} 秒 (${Math.round(layer1TotalMs)} ms)`);
    console.log(`📦 (参考: バックグラウンド Hint 放流完了までの全時間: ${(fullTotalMs / 1000).toFixed(2)} 秒)`);
    console.log('================================================================================\n');

    stopAll(baseNodes);
    for (const n of appNodes) {
      n.schrodinger.destroy();
    }
  }, 120_000);
});
