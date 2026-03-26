import { Component } from './Component';
import { KeyManager } from '../crypto/KeyManager';
import { PacketBuilder } from '../crypto/PacketBuilder';
import { Identity } from '../crypto/Identity';
import { ThreadDAGManager } from '../logic/ThreadDAGManager';
import type { DAGPost } from '../logic/ThreadDAGManager';

export class ThreadView extends Component {
  private seenPacketIds = new Set<string>(); // 重複排除用(ハッシュ管理)
  private threadKey: Uint8Array;
  private threadTopicHash: Uint8Array;
  
  private boardId: string;
  private threadId: string;
  private boardKey: Uint8Array;
  private pm: any;
  private mailbox: any;
  private cryptoEng: any;
  private identity: Identity;
  private powEng: any;
  private keyMgr: any;
  private db: any;
  private syncProtocol: any;
  private router: any;
  private zm: any;
  private dag: ThreadDAGManager;

  constructor(
    boardId: string, threadId: string, boardKey: Uint8Array,
    pm: any, mailbox: any, cryptoEng: any, identity: Identity,
    powEng: any, keyMgr: any, db: any, syncProtocol: any, router: any, zm: any
  ) {
    super('div', 'thread-view view-container');
    this.boardId = boardId;
    this.threadId = threadId;
    this.boardKey = boardKey;
    this.pm = pm;
    this.mailbox = mailbox;
    this.cryptoEng = cryptoEng;
    this.identity = identity;
    this.powEng = powEng;
    this.keyMgr = keyMgr;
    this.db = db;
    this.syncProtocol = syncProtocol;
    this.router = router;
    this.zm = zm;
    this.dag = new ThreadDAGManager(this.threadId);

    this.threadKey = KeyManager.deriveThreadKey(this.boardKey, this.threadId);
    this.threadTopicHash = KeyManager.deriveTopicHash(this.threadKey);

    this.init();
  }

  private async init() {
    this.render(`
      <div style="margin-bottom: 20px;">
        <a href="#board=${this.boardId}&key=${KeyManager.toBase64(this.boardKey)}" style="color: var(--text-dim); text-decoration:none;">← 板に戻る</a>
        <h1 id="thread-title" style="margin-top:10px; font-size: 24px;">スレッド: ${this.threadId.substring(0,8)}</h1>
      </div>
      <div id="posts-container">
        <div id="loading-status" style="color: var(--text-dim); padding: 20px;">初期化を開始しています...</div>
      </div>
      <div class="compose-box">
        <textarea id="reply-input" placeholder=">>レスを入力... (Ctrl+Enterで送信)" rows="3"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div id="post-status" style="font-size:12px; color:var(--text-dim);"></div>
          <button class="btn" id="btn-send-reply">書き込む</button>
        </div>
        <div class="progress-container" id="pow-progress" style="display:none;"><div class="progress-bar" id="pow-bar"></div></div>
      </div>
    `);

    this.element.querySelector('#btn-send-reply')?.addEventListener('click', () => this.submitReply());
    const inputEle = this.element.querySelector('#reply-input') as HTMLTextAreaElement;
    inputEle?.addEventListener('keydown', (e: any) => {
      if (e.ctrlKey && e.key === 'Enter') this.submitReply();
    });

    // 🌟 最速で監視を開始 (Gossip)
    this.router.onMessage(async (packet: any) => {
      await this.handleIncomingPacket(packet, false);
    });

    // 1. DBから既存のレスを読み込み (タイムアウト付きで安全に)
    try {
      this.updateStatus('過去ログを読み込み中...');
      await Promise.race([
        this.loadFromDB(),
        new Promise((_, reject) => setTimeout(() => reject('DB_TIMEOUT'), 2000))
      ]);
    } catch (e) {
      console.warn('[ThreadView] Cache load timed out or failed:', e);
    }
    this.renderPosts(); // DBが空でも一旦現状のリスト(空の状態)を反映してローディング文字を消す

    // 2. ネットワークの安定を待つ (隣人1人以上)
    const isOnline = await this.waitForPeers(10000); 

    if (isOnline) {
      this.updateStatus('ピアと同期中 (DHT同期)...');
      // 3. 過去ログ同期依頼
      const recoveredCount = await this.syncProtocol.syncThread(this.boardId, this.threadId, this.boardKey).catch(() => 0);
      
      if (recoveredCount > 0) {
        // 同期でレスが増えたので、もう一度DBから読み取って描画を確定させる
        await this.loadFromDB().catch(() => {});
      }
      this.renderPosts(); // 最終的な描画を反映（ローディング消去）

      if (this.dag.getCount() === 0) {
        this.updateStatus('レスが1件もありませんでした。あなたが最初の投稿者になりませんか？');
      }
    } else {
      this.updateStatus('ネット接続待機中... 他の人がレスをすれば自動で反映されます。');
      this.renderPosts();
    }
  }

  private updateStatus(text: string) {
    const statusEl = this.element.querySelector('#loading-status');
    if (statusEl) statusEl.textContent = text;
  }

  /**
   * 隣人が繋がるのを待機
   */
  private async waitForPeers(timeout: number): Promise<boolean> {
    if (this.pm.degree > 0) return true;
    
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, timeout);

      this.pm.on('peer:connect', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  private async handleIncomingPacket(packet: any, isFromDB: boolean) {
    if (this.seenPacketIds.has(packet.packet_id)) return;
    this.seenPacketIds.add(packet.packet_id);

    try {
      const post = await PacketBuilder.verifyAndDecrypt(packet, this.threadKey, this.cryptoEng);
      if (post && post.thread_id === this.threadId && post.post_type === 0) {
        
        const dagPost: DAGPost = {
          ...post,
          packet_id: packet.packet_id,
          parents: post.parents || [],
          cumulative_pow: post.cumulative_pow || 0,
          thread_root: post.thread_root || this.threadId
        };

        const isNew = this.dag.addPost(dagPost);
        if (isNew) {
          this.renderPosts();
          
          if (!isFromDB) {
              const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
                 if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
                 return v;
              }));
              await this.db.save({ 
                boardId: this.boardId, 
                threadId: this.threadId, 
                payload: rawPacketData,
                dag: {
                  parents: dagPost.parents,
                  cumulative_pow: dagPost.cumulative_pow,
                  thread_root: dagPost.thread_root
                }
              }).catch(() => {});
          }
        }
      }
    } catch (e) {}
  }

  private async loadFromDB() {
    const rawEntries = await this.db.getPosts(this.boardId, this.threadId).catch(() => []);
    for (const entry of rawEntries) {
      try {
        const packet = JSON.parse(new TextDecoder().decode(entry.payload), (_k, v) => {
          if (v && v._type === 'Uint8Array') return new Uint8Array(v.data);
          return v;
        });
        // DBからの読み込み時は、パケットの検証と同時にDAGへの登録を行う
        await this.handleIncomingPacket(packet, true);
      } catch (e) {}
    }
  }

  private renderPosts() {
    const container = this.element.querySelector('#posts-container')!;
    
    const statusEl = this.element.querySelector('#loading-status');
    if (this.dag.getCount() > 0 && statusEl) {
        statusEl.remove();
    }

    const sortedPosts = this.dag.getSortedPosts();

    if (sortedPosts.length === 0) {
      if (!statusEl) {
        container.innerHTML = `<div id="loading-status" style="padding: 40px; text-align:center; color: var(--text-dim);">まだレスがありません。</div>`;
      }
      return;
    }

    container.innerHTML = sortedPosts
      .map((p, index) => {
        const trip = p.trip_pubkey ? '◆' + KeyManager.toBase64(KeyManager.cryptoHash(p.trip_pubkey).slice(0, 5)) : '';
        const id = p.session_pubkey ? KeyManager.toBase64(KeyManager.cryptoHash(p.session_pubkey).slice(0, 4)) : '???';
        return `
        <div class="post">
          <div class="post-header">
            <span class="res-no">${index + 1}</span>
            <span class="author-name">名無しさん ${trip}</span>
            <span class="author-id">ID:${id}</span>
            <span class="post-time">${new Date(p.created_at).toLocaleString()}</span>
          </div>
          <div class="post-body">${this.formatContent(p.content || '')}</div>
        </div>
      `}).join('');
    
    window.scrollTo(0, document.body.scrollHeight);
  }

  private formatContent(content: string): string {
    return content
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/>&gt;(\d+)/g, '<span style="color:var(--accent-primary); cursor:pointer;">&gt;&gt;$1</span>');
  }

  private async submitReply() {
    const inputEle = this.element.querySelector('#reply-input') as HTMLTextAreaElement;
    const text = inputEle.value.trim();
    if (!text) return;

    const btn = this.element.querySelector('#btn-send-reply') as HTMLButtonElement;
    const bar = this.element.querySelector('#pow-bar') as HTMLElement;
    const progress = this.element.querySelector('#pow-progress') as HTMLElement;
    const status = this.element.querySelector('#post-status') as HTMLElement;

    btn.disabled = true;
    inputEle.disabled = true;
    progress.style.display = 'block';
    bar.style.width = '20%';
    status.textContent = 'PoW計算中...';

    try {
      const currentZoneId = KeyManager.computeZoneId(this.threadTopicHash, this.zm.depth);
      
      const tips = this.dag.getTips();
      const currentWeight = this.dag.getMaxCumulativePow();
      const nextWeight = currentWeight + 8; // 基底難易度を加算

      const packet = await PacketBuilder.build(
        text, this.threadKey, this.identity, this.cryptoEng,
        this.powEng, this.keyMgr, this.boardId, this.threadId,
        this.dag.getCount(), null, 8, currentZoneId, 0,
        tips, this.threadId, nextWeight
      );

      bar.style.width = '100%';
      status.textContent = '送信完了 (配信待機中...)';

      this.router.broadcast(packet).catch((err: any) => {
        alert('ゴシップ送信に失敗しました: ' + err);
      });
      
      const globalTopic = KeyManager.toHex(this.threadTopicHash);
      const rawPacketData = new TextEncoder().encode(JSON.stringify(packet, (_k, v) => {
          if (v instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(v) };
          return v;
      }));
      
      this.mailbox.publish(globalTopic, rawPacketData).catch((err: any) => {
        console.warn('[ThreadView] Mailbox publish failed in background:', err);
      });

      inputEle.value = '';
      inputEle.disabled = false;
      btn.disabled = false;
      progress.style.display = 'none';
      status.textContent = '計算完了！送信中...';
      setTimeout(() => { if (status.textContent === '計算完了！送信中...') status.textContent = ''; }, 3000);

    } catch (err) {
      console.error('Failed to prepare packet:', err);
      status.textContent = '🔴 失敗: ' + err;
      btn.disabled = false;
      inputEle.disabled = false;
      progress.style.display = 'none';
    }
  }
}
