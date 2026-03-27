import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { SessionManager } from './SessionManager';

export class TrackerServer {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;
  private wsToPeerId: Map<WebSocket, string> = new Map();

  constructor() {
    this.sessionManager = new SessionManager();
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (message: any) => this.handleMessage(ws, message));
      ws.on('close', () => {
        this.wsToPeerId.delete(ws);
      });
    });

    console.log(`[TrackerServer] Initialized (Waiting for upgrades on /ws)`);
  }

  public handleUpgrade(req: any, socket: any, head: any): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private handleMessage(ws: WebSocket, raw: any): void {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === 'join') {
        const { peerId, position, zones, isSeed, isCache } = data;
        this.wsToPeerId.set(ws, peerId);
        this.sessionManager.registerSession(ws, peerId, position, zones || [], !!isSeed, !!isCache);

        const peers = this.sessionManager.getRandomPeers(peerId, 8);
        ws.send(JSON.stringify({ type: 'peers', peers }));

      } else if (data.type === 'relay') {
        const { targetPeerId, payload } = data;
        const senderPeerId = this.wsToPeerId.get(ws);
        if (!senderPeerId) return;

        const targetSession = this.sessionManager.getSession(targetPeerId);
        if (targetSession) {
          const forwarded = { 
            ...payload, 
            senderId: senderPeerId,
            from: senderPeerId 
          };
          targetSession.ws.send(JSON.stringify(forwarded));
        }
      }
    } catch (e) {
      console.warn(`[TrackerServer] Failed to handle message`, e);
    }
  }

  public shutdown(): void {
    this.sessionManager.destroy();
    this.wss.close();
  }
}
