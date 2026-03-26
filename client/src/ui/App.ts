import { Component } from './Component';
import { Identity } from '../crypto/Identity';
import { BoardView } from './BoardView';
import { ThreadView } from './ThreadView';
import { KeyManager } from '../crypto/KeyManager';

export class App extends Component {
  private currentView: Component | null = null;
  private header: HTMLElement;
  private main: HTMLElement;

  private pm: any;
  private db: any;
  private identity: Identity;
  private mailbox: any;
  private cryptoEng: any;
  private powEng: any;
  private syncProtocol: any;
  private router: any;
  private zm: any;

  constructor(
    pm: any, db: any, identity: Identity, mailbox: any,
    cryptoEng: any, powEng: any, syncProtocol: any, router: any, zm: any
  ) {
    super('div', 'app-root');
    this.pm = pm;
    this.db = db;
    this.identity = identity;
    this.mailbox = mailbox;
    this.cryptoEng = cryptoEng;
    this.powEng = powEng;
    this.syncProtocol = syncProtocol;
    this.router = router;
    this.zm = zm;

    this.element.id = 'app';
    this.header = document.createElement('header');
    this.main = document.createElement('main');

    this.element.appendChild(this.header);
    this.element.appendChild(this.main);

    this.initHeader();
    this.handleRouting();

    window.addEventListener('hashchange', () => this.handleRouting());
  }

  private initHeader() {
    this.header.innerHTML = `
      <div style="display:flex; align-items:center; gap:20px;">
        <div class="nav-logo" style="cursor:pointer;" onclick="location.hash='#board=vip'">AETHER LITE</div>
        <button class="btn" id="btn-create-private-board" style="padding: 2px 10px; font-size: 11px;">秘密の板を作る</button>
      </div>
      <div class="nav-stats">
        <div class="stat-item" id="nav-peer-count"><span id="stat-count" style="color:var(--success);">Peers: 0</span></div>
        <div class="stat-item" style="color:var(--warning); font-family:monospace;">${this.identity.tripDisplay || '名無し'}</div>
      </div>
    `;

    this.header.querySelector('#btn-create-private-board')?.addEventListener('click', () => {
      const newKey = KeyManager.generateBoardKey();
      const newBoardId = Math.random().toString(36).substring(2, 10);
      location.hash = `#board=${newBoardId}&key=${KeyManager.toBase64(newKey)}`;
    });

    setInterval(() => {
      const countEl = document.getElementById('stat-count');
      if (countEl) countEl.textContent = `Peers: ${this.pm.degree}`;
    }, 2000);
  }

  private handleRouting() {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const boardId = params.get('board') || 'vip';
    const threadId = params.get('thread');

    if (this.currentView) {
      this.currentView.unmount();
    }

    const keyB64 = params.get('key');
    let boardKey: Uint8Array;

    if (keyB64) {
      boardKey = KeyManager.fromBase64(keyB64);
    } else if (boardId === 'vip') {
      // ユーザーの意向を汲み、ハッシュ版をデフォルトに設定
      boardKey = KeyManager.cryptoHash(new TextEncoder().encode('AETHER_LITE_VIP_DEFAULT_SEED')).slice(0, 32);
    } else {
      this.main.innerHTML = `
        <div class="view-container" style="padding: 100px 0; text-align:center;">
          <h2 style="color:red;">板の鍵が見つかりません</h2>
          <p style="margin-top:20px;">この板を閲覧するには、正しい鍵（URL）が必要です。</p>
          <button class="btn" style="margin-top:30px;" onclick="location.hash='#board=vip'">ロビーに戻る</button>
        </div>
      `;
      return;
    }

    if (threadId && boardId) {
      this.currentView = new ThreadView(
        boardId, threadId, boardKey,
        this.pm, this.mailbox, this.cryptoEng, this.identity,
        this.powEng, KeyManager, this.db, this.syncProtocol, this.router, this.zm
      );
    } else {
      // 板画面への遷移: DBを含む11個の引数を渡す
      this.currentView = new BoardView(
        boardId, boardKey, this.pm, this.mailbox, this.cryptoEng, this.identity,
        this.powEng, KeyManager, this.zm, this.db, this.router
      );
    }

    this.currentView.mount(this.main);
  }

  public onMounted() {
    document.body.appendChild(this.element);
  }
}
