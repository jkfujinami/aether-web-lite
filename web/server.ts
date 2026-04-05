/**
 * AETHER Web-Lite v2 — Custom Server
 * 
 * Next.js の HTTP サーバーに WebSocket シグナリングサーバー（TrackerServer）を同居させる。
 * これにより 1 つのポート（3000）で HTTP + WS 両方を提供する。
 */
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { TrackerServer } from './src/server/TrackerServer';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  // WebSocket シグナリングサーバーを HTTP サーバーに相乗りさせる
  const tracker = new TrackerServer(server);

  server.listen(port, () => {
    console.log(`\n  ✅ AETHER Web-Lite v2`);
    console.log(`  → http://${hostname}:${port}`);
    console.log(`  → WebSocket signaling on /ws`);
    console.log(`  → Mode: ${dev ? 'development' : 'production'}\n`);
  });
});
