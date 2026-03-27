import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // /ws への通信を Node.js の Signaling Server にプロキシする
      // これにより WebRTC の Signaling 接続が localhost:5173 だけで完結する (ngrok が 1つで済む)
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
