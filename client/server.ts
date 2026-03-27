import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { TrackerServer } from './src/lib/server/TrackerServer';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;

// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const tracker = new TrackerServer();
  
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url!, true);
    if (pathname === '/ws') {
      tracker.handleUpgrade(req, socket, head);
    } else {
      // Pass all other upgrade requests (like HMR) to Next.js
      app.getUpgradeHandler()(req, socket, head);
    }
  });

  server.once('error', (err) => {
    console.error(err);
    process.exit(1);
  }).listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> Aether Tracker integrated on http://${hostname}:${port}/ws`);
  });
});
