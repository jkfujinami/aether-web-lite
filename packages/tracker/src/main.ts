/**
 * トラッカーを単体で動かす。
 *
 *   PORT=8080 TRACKER_ALLOWED_HOSTS=tracker.example.org npx tsx packages/tracker/src/main.ts
 *
 * TLS (wss://) はリバースプロキシで終端すること。ノードは wss:// のトラッカーにしか
 * 接続しない (localhost を除く)。プロキシが Host ヘッダを書き換える構成では、
 * 公開しているホスト名を TRACKER_ALLOWED_HOSTS (カンマ区切り) に設定する。
 *
 * ★ 運用者には接続してきたノードの IP アドレスが見える。アクセスログを残さない設定にし、
 *   その旨を利用者に公開すること。このプログラム自体は peerId も IP も記録しない。
 */
import { createServer } from 'node:http';
import { TrackerServer } from './TrackerServer';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const hostname = process.env.HOST ?? '127.0.0.1';
const allowedHosts = (process.env.TRACKER_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h.length > 0);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  res.writeHead(404).end();
});

const tracker = new TrackerServer(server, {
  allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
  exclusiveUpgrade: true,
});

server.listen(port, hostname, () => {
  console.log(`[tracker] listening on ${hostname}:${port} (WebSocket path /ws)`);
});

const shutdown = () => {
  tracker.shutdown();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
