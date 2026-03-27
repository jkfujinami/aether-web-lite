import { Component } from './Component';
import { KeyManager } from '../crypto/KeyManager';
import { PacketBuilder } from '../crypto/PacketBuilder';
import { Identity } from '../crypto/Identity';
import { ThreadRanker } from '../logic/ThreadRanker';

export class BoardView extends Component {
  private threads: any[] = [];
  private seenPacketIds = new Set<string>();
  
  private boardId: string;
  private boardKey: Uint8Array;
  private pm: any;
  private mailbox: any;
  private cryptoEng: any;
  private identity: Identity;
  private powEng: any;
  private keyMgr: any;
  private zm: any;
  private db: any;
  private router: any;

  private refreshTimer: any = null;
  private lastRefreshTime = 0;

  constructor(
    boardId: string, boardKey: Uint8Array, pm: any, mailbox: any,
    cryptoEng: any, identity: Identity, powEng: any, keyMgr: any, zm: any, db: any, router: any
  ) {
    super('div', 'board-view view-container');
    this.boardId = boardId;
    this.boardKey = boardKey;
    this.pm = pm;
    this.mailbox = mailbox;
    this.cryptoEng = cryptoEng;
    this.identity = identity;
    this.powEng = powEng;
    this.keyMgr = keyMgr;
    this.zm = zm;
    this.db = db;
    this.router = router;

    this.init();
  }

  private async init() {
    this.render(`
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size: 20px;">板: ${this.boardId}</h1>
        <button class="btn" id="btn-create-thread" style="font-size: 12px;">新スレを立てる</button>
      </div>
      <div id="thread-list">
        <div id="loading-status" style="color: var(--text-dim);">読み込み中...</div>
      </div>
    `);

    this.element.querySelector('#btn-create-thread')?.addEventListener('click', () => this.showCreateForm());

    // 1. ローカルキャッシュを即座に復元
    await this.loadFromDB().catch(() => {});

    // 2. 最初の問い合わせ (隣人がいなくても一旦叩く)
    this.refresh();

    // 3. リアクティブ・リフレッシュ: 隣人が増えるたびに再探索を予約する
    this.pm.on('peer:connect', () => this.debouncedRefresh());

    // 4. リアルタイム・ゴシップの購読 (他の人がスレを立てた時の即時反映用)
    this.router.onMessage(async (packet: any) => {
      await this.handlePacketObject(packet, false);
    });
  }

  /**
   * ネットワークへの負荷を抑えるためのデバウンス付きリフレッシュ
   */
  private debouncedRefresh() {
    const REFRESH_INTERVAL = 3000; // 前回の実行から3秒以上空ける
    
    if (this.refreshTimer) return; // 既に予約済みなら何もしない

    const now = Date.now();
    const timeSinceLast = now - this.lastRefreshTime;

    const delay = Math.max(500, REFRESH_INTERVAL - timeSinceLast);
    
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      this.lastRefreshTime = Date.now();
      console.log('[BoardView] Peer increased. Re-fetching due to reactive trigger.');
      await this.refresh();
    }, delay);
  }

  private updateStatus(text: string) {
    const statusEl = this.element.querySelector('#loading-status');
    if (statusEl) statusEl.textContent = text;
  }

  private async loadFromDB() {
    const rawEntries = await this.db.getPosts(this.boardId, '__board_meta__').catch(() => []);
    if (rawEntries.length === 0) return;
    
    for (const entry of rawEntries) {
      try {
        await this.handleRawPacket(entry.payload, true);
      } catch (e) {}
    }
  }

  public async refresh() {
    try {
      if (this.pm.degree === 0) {
        this.updateStatus('隣人を探しています (接続中)...');
        return;
      }

      this.updateStatus(`${this.pm.degree}人の隣人から最新のスレッドを取得中...`);
      const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(this.boardKey));
      const entries = await this.mailbox.fetch(boardTopicHash);
      
      for (const entry of entries) {
        try {
          await this.handleRawPacket(entry.payload || entry, false);
        } catch (e) { }
      }

      if (this.threads.length === 0) {
        this.updateStatus('スレッドが見つかりませんでした。一番乗りで立ててみませんか？');
      }
    } catch (err) {
      console.error('[BoardView] Remote fetch error:', err);
    }
  }

  private async handleRawPacket(rawPacket: Uint8Array, isFromDB: boolean) {
    try {
      const packet = JSON.parse(new TextDecoder().decode(rawPacket), (_k, v) => {
        if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
        return v;
      });
      await this.handlePacketObject(packet, isFromDB, rawPacket);
    } catch (e) {}
  }

  private async handlePacketObject(packet: any, isFromDB: boolean, rawData?: Uint8Array) {
    try {
      if (this.seenPacketIds.has(packet.packet_id)) return;
      this.seenPacketIds.add(packet.packet_id);

      const meta = await PacketBuilder.verifyAndDecrypt(packet, this.boardKey, this.cryptoEng);
      if (meta && meta.post_type === 1) {
        const statusEl = this.element.querySelector('#loading-status');
        if (statusEl) statusEl.remove();

        const exists = this.threads.find(t => t.thread_id === meta.thread_id);
        if (!exists) {
          // DBから最新の統計(max_pow等)を取得してマージ
          const stats = await this.db.getThreads(this.boardId).then((list: any[]) => list.find(s => s.threadId === meta.thread_id));
          this.threads.push({ 
            ...meta, 
            packet_id: packet.packet_id,
            max_pow: stats ? stats.max_pow : 0,
            created_at: stats ? stats.created_at : meta.created_at
          });
          this.renderThreadList();
        }

        if (!isFromDB) {
           const dataToSave = rawData || new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
               if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
               return v;
           }));
           await this.db.save({ 
             boardId: this.boardId, 
             threadId: '__board_meta__', 
             payload: dataToSave 
           }).catch(() => {});
        }
      }
    } catch (e) {}
  }

  private renderThreadList() {
    const listEl = this.element.querySelector('#thread-list')!;
    const boardKeyB64 = KeyManager.toBase64(this.boardKey);
    
    // スコア計算とソート
    const sortedThreads = [...this.threads].sort((a, b) => {
        const scoreA = ThreadRanker.calculateScore(a.max_pow || 0, a.created_at);
        const scoreB = ThreadRanker.calculateScore(b.max_pow || 0, b.created_at);
        return scoreB - scoreA;
    });

    listEl.innerHTML = sortedThreads
      .map(t => {
        const url = `#board=${this.boardId}&thread=${t.thread_id}&key=${boardKeyB64}`;
        const score = ThreadRanker.calculateScore(t.max_pow || 0, t.created_at);
        const heat = Math.floor(t.max_pow || 0);

        return `
          <div class="card" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="location.hash='${url}'">
            <div>
                <div style="font-weight:700; font-size: 14px;">${t.content}</div>
                <div style="font-size: 11px; color: var(--text-dim);">
                ${new Date(t.created_at).toLocaleString()} | ID:${t.thread_id.substring(0,8)} | Heat: ${heat}
                </div>
            </div>
            <div style="font-size: 18px; font-weight: 900; color: var(--accent); opacity: 0.7;">
                ${score > 0.1 ? score.toFixed(1) : '0.1'}
            </div>
          </div>
        `;
      }).join('');
  }

  private showCreateForm() {
    this.render(`
      <div class="card">
        <h3>新規スレッド作成</h3>
        <div class="input-group" style="margin-top:15px;">
          <textarea id="input-title" placeholder="スレッドタイトル..." rows="2"></textarea>
          <div style="display:flex; justify-content: flex-end; gap: 10px;">
            <button class="btn" id="btn-cancel">中止</button>
            <button class="btn" id="btn-submit-thread">作成</button>
          </div>
          <div id="pow-progress-container" style="display:none; margin-top:10px;">
            <div style="font-size:11px; color:var(--accent);">PoW計算中...</div>
            <div style="background:#333; height:4px; width:100%;"><div id="pow-bar" style="background:var(--accent); height:100%; width:0%;"></div></div>
          </div>
        </div>
      </div>
    `);

    this.element.querySelector('#btn-cancel')?.addEventListener('click', () => this.init());
    this.element.querySelector('#btn-submit-thread')?.addEventListener('click', () => this.submitThread());
  }

  private async submitThread() {
    const titleEle = this.element.querySelector('#input-title') as HTMLTextAreaElement;
    const title = titleEle.value.trim();
    if (!title) return;

    const btn = this.element.querySelector('#btn-submit-thread') as HTMLButtonElement;
    const progress = this.element.querySelector('#pow-progress-container') as HTMLElement;
    const bar = this.element.querySelector('#pow-bar') as HTMLElement;
    
    btn.disabled = true;
    progress.style.display = 'block';
    bar.style.width = '30%';

    try {
      const threadId = Math.random().toString(36).substring(2, 12);
      const threadKey = KeyManager.deriveThreadKey(this.boardKey, threadId);
      const threadTopicHash = KeyManager.deriveTopicHash(threadKey);
      const currentZoneId = KeyManager.computeZoneId(threadTopicHash, this.zm.depth);
      
      const packet = await PacketBuilder.build(
        title, this.boardKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, this.boardId, threadId,
        0, null, 10, currentZoneId, 1  
      );

      bar.style.width = '100%';

      await this.router.broadcast(packet);

      const boardTopicHash = KeyManager.toHex(KeyManager.cryptoHash(this.boardKey));
      const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
          if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
          return v;
      }));
      
      this.mailbox.publish(boardTopicHash, rawPacketData).catch((e: any) => console.error(e));
      
      await this.db.save({ 
        boardId: this.boardId, 
        threadId: '__board_meta__', 
        payload: rawPacketData 
      }).catch(() => {});
      
      location.hash = `#board=${this.boardId}&thread=${threadId}&key=${KeyManager.toBase64(this.boardKey)}`;
    } catch (err) {
      alert('失敗: ' + err);
      btn.disabled = false;
      progress.style.display = 'none';
    }
  }
}
