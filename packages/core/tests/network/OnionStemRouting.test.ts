import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { sodiumReady } from '../../src/crypto/sodium';
import { OnionRouter, SEALED_EXIT_LAYER_SIZE } from '../../src/crypto/OnionRouter';
import { WireType } from '../../src/network/wire/WireTypes';
import { WireCodec } from '../../src/network/wire/WireCodec';
import { buildHint } from '../../src/network/hint/HintCrypto';
import { hintId } from '../../src/network/hint/HintPacket';
import sodium from '../../src/crypto/sodium';
import {
  createSimNode, link, unlink, startAll, stopAll, sleep, makePacket, type SimNode,
} from '../helpers/onionNet';

/**
 * Onion 回路の結合テスト。
 *
 * トポロジー (Alice の隣人は Bob だけ):
 *
 *   Alice ── Bob ── Charlie ── Dave
 *             └──── Erin
 */
describe('Onion 回路 (cover traffic / 固定長出口層 / Fail-Closed)', () => {
  let nodes: SimNode[] = [];
  let alice: SimNode, bob: SimNode, charlie: SimNode, dave: SimNode, erin: SimNode;

  beforeAll(async () => {
    await sodiumReady;
  });

  async function chain() {
    alice = await createSimNode('alice');
    bob = await createSimNode('bob');
    charlie = await createSimNode('charlie');
    dave = await createSimNode('dave');
    erin = await createSimNode('erin');
    nodes = [alice, bob, charlie, dave, erin];
    link(alice, bob);
    link(bob, charlie);
    link(charlie, dave);
    link(bob, erin);
    startAll(nodes);
    // Guard (Bob) の隣人表が届くまで待つ
    await sleep(80);
  }

  afterEach(() => stopAll(nodes));

  /** Bob が Alice から受け取ったセルを Bob の鍵で 1 枚剥いたもの */
  function guardView() {
    const secret = bob.identity.exportSecret();
    return bob.inbox
      .filter(m => m.from === alice.identity.peerId && m.type === WireType.ONION_STEM)
      .map(m => ({ raw: m.payload.onionBytes as Uint8Array, layer: OnionRouter.unwrap(m.payload.onionBytes, secret.pubkey, secret.privkey) }));
  }

  it('投稿は Guard → 出口を経て Fluff され、遠くのノードに届く', async () => {
    await chain();
    const packet = makePacket([1, 2, 3]);

    const ok = await alice.gossip.broadcast(packet);
    expect(ok).toBe(true);
    await sleep(50);

    expect(dave.received.map(p => p.packet_id)).toContain(packet.packet_id);
    // Alice から Bob へ平文の GOSSIP は一切出ていない
    expect(bob.inbox.some(m => m.from === alice.identity.peerId && m.type === WireType.GOSSIP)).toBe(false);
  });

  it('Guard から見て、cover と本物のセルは区別できない (C2)', async () => {
    await chain();
    await sleep(100); // 投稿前の cover を溜める
    const packet = makePacket([7, 7, 7]);
    expect(await alice.gossip.broadcast(packet)).toBe(true);
    await sleep(100); // 投稿後の cover も溜める

    const view = guardView();
    expect(view.length).toBeGreaterThan(5);
    for (const { raw, layer } of view) {
      expect(raw.byteLength).toBe(OnionRouter.CELL_SIZE);
      // どのセルも Guard にとっては同じ長さの relay 層で、中身は読めない
      expect(layer?.type).toBe('relay');
      if (layer?.type !== 'relay') continue;
      expect(layer.innerOnion.byteLength).toBe(SEALED_EXIT_LAYER_SIZE);
      expect(Buffer.from(raw).toString('latin1')).not.toContain(packet.packet_id);
    }
  });

  it('出口は Guard の隣人のうち、自分の隣人ではないノードから選ばれる', async () => {
    await chain();
    // Charlie を Alice の隣人にもする。出口候補 {Charlie, Erin} のうち Erin だけが非隣接
    link(alice, charlie);
    alice.dandelion.getPinnedGuard([{ peerId: bob.identity.peerId, pubkey: bob.identity.pubkey }]);
    await sleep(40); // リンク追加前に送られて配送中のセルを流し切る
    const already = guardView().length; // リンク追加前のセルは数えない
    await sleep(150);

    const exits = new Set(
      guardView().slice(already).map(v => (v.layer?.type === 'relay' ? v.layer.nextHop : null)),
    );
    expect(exits).toEqual(new Set([erin.identity.peerId]));
  });

  it('出口がセルを捨てても平文に落ちず、Guard も交代せず、隣人も罰しない (Fail-Closed)', async () => {
    await chain();
    // Bob の背後の出口候補 (Charlie, Erin) がすべてセルを捨てる
    for (const n of [charlie, erin]) (n.dispatcher as any).handlers.set(WireType.ONION_STEM, new Set());
    const guardBefore = alice.dandelion.getPinnedGuardId();

    const ok = await alice.gossip.broadcast(makePacket([9, 9]));
    expect(ok).toBe(false);

    expect(bob.inbox.some(m => m.from === alice.identity.peerId && m.type === WireType.GOSSIP)).toBe(false);
    expect(alice.dandelion.getPinnedGuardId()).toBe(guardBefore);
    expect(alice.peerManager.misbehavior.getScore(bob.identity.peerId)).toBe(0);
  });

  it('回路が組めない (出口候補が無い) ときは何も送らずに false を返す', async () => {
    const lonelyA = await createSimNode('lonely-a');
    const lonelyB = await createSimNode('lonely-b');
    nodes = [lonelyA, lonelyB];
    link(lonelyA, lonelyB);
    startAll(nodes);
    await sleep(50);

    expect(await lonelyA.gossip.broadcast(makePacket([5]))).toBe(false);
    expect(lonelyB.inbox.some(m => m.type === WireType.GOSSIP)).toBe(false);
  });

  it('Guard は切断されたときだけ交代する', async () => {
    await chain();
    link(alice, erin);
    const first = alice.dandelion.getPinnedGuardId();
    await alice.gossip.broadcast(makePacket([1]));
    expect(alice.dandelion.getPinnedGuardId()).toBe(first);

    const firstNode = nodes.find(n => n.identity.peerId === first)!;
    unlink(alice, firstNode);
    await sleep(60);
    expect(alice.dandelion.getPinnedGuardId()).not.toBe(first);
  });

  it('Hint も回路で運ばれ、作者は HINT を直接送らない', async () => {
    await chain();
    const hint = buildHint(sodium.randombytes_buf(32), {
      nonce: sodium.randombytes_buf(32), message_id: 1, timestamp: Date.now(),
    });
    const ok = await alice.hints.originate(hint, hintId(hint));
    expect(ok).toBe(true);
    await sleep(30);

    expect(bob.inbox.some(m => m.from === alice.identity.peerId && m.type === WireType.HINT)).toBe(false);
    expect(dave.inbox.some(m => m.type === WireType.HINT)).toBe(true);
  });

  it('同じセルを再送しても中継は 1 回だけ (リプレイ耐性)', async () => {
    await chain();
    await sleep(40);
    const cell = guardView()[0].raw;

    for (let i = 0; i < 3; i++) {
      (bob.peerManager as any).handleData(alice.identity.peerId, WireCodec.encode(WireType.ONION_STEM, { onionBytes: cell }));
    }
    await sleep(30);
    expect(countForwardsOf(cell)).toBe(1);
  });

  /** Bob が中継した (= innerOnion を詰め直した) セルのうち、元セル由来のものを数える */
  function countForwardsOf(cell: Uint8Array): number {
    const secret = bob.identity.exportSecret();
    const layer = OnionRouter.unwrap(cell, secret.pubkey, secret.privkey);
    if (layer?.type !== 'relay') return -1;
    const target = nodes.find(n => n.identity.peerId === layer.nextHop)!;
    return target.inbox.filter(m => {
      if (m.type !== WireType.ONION_STEM || m.from !== bob.identity.peerId) return false;
      const inner = OnionRouter.unpadCell(m.payload.onionBytes);
      return inner !== null && Buffer.compare(Buffer.from(inner), Buffer.from(layer.innerOnion)) === 0;
    }).length;
  }
});
