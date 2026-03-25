# aether-cache

A standalone Rust-based stable node for the AETHER Web-Lite mesh network.
This node functions identically to a browser node (handling Gossip, Stem/Fluff routing, and DHT Mailbox) but uses native WebRTC (via `webrtc-rs`) and SQLite for persistence.

## Features
- **P2P Compatibility:** Fully compatible with browser-based `aether-web-lite` clients using WebRTC Data Channels.
- **Persistent DHT Storage:** Backed by SQLite (`mailbox.db`) to ensure active data survives even when no browser nodes are online.
- **Gossip Relaying:** Continuously forwards packets, keeping the mesh network alive.
- **Ring Routing:** Properly participates in the 1D circular topology coordinate system (`RingPosition`).

## Running
Ensure you have the AETHER tracker (Node.js) running first (`cd server && npm run dev`).

```bash
cargo run
```
