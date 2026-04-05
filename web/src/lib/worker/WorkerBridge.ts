/**
 * WorkerBridge
 * Web Worker とメインスレッドを Promise で繋ぐ架け橋。
 */
export class WorkerBridge {
  private static worker: Worker | null = null;
  private static pendingRequests: Map<string, { resolve: (val: any) => void, reject: (err: any) => void }> = new Map();

  static getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.handleMessage(e);
      this.worker.onerror = (err) => console.error('[WorkerBridge] Worker error:', err);
    }
    return this.worker;
  }

  static async request(type: string, data: any): Promise<any> {
    const worker = this.getWorker();
    const id = Math.random().toString(36).substring(2);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...data });
    });
  }

  private static handleMessage(e: MessageEvent) {
    const { id, type, nonce, isValid, error } = e.data;
    const pending = this.pendingRequests.get(id);

    if (pending) {
      if (type === 'result') {
          pending.resolve(nonce !== undefined ? nonce : isValid);
      } else if (type === 'error') {
          pending.reject(new Error(error));
      }
      this.pendingRequests.delete(id);
    }
  }
}
