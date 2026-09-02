const CHUNK_SIZE = 4096;
const HEADER_SIZE = 12;
const MAX_BUFFERED = 64 * 1024;

export class ChunkedSender {
  private msgCounter = 0;

  async send(dc: RTCDataChannel, data: Uint8Array): Promise<void> {
    if (data.byteLength <= CHUNK_SIZE) {
      dc.send(data as any);
      return;
    }

    const msgId = (this.msgCounter++) & 0xFFFFFFFF;
    const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE);

    for (let seq = 0; seq < totalChunks; seq++) {
      while (dc.bufferedAmount > MAX_BUFFERED) {
        await new Promise(r => setTimeout(r, 10));
      }

      const offset = seq * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, data.byteLength);
      const payload = data.subarray(offset, end);

      const chunk = new Uint8Array(HEADER_SIZE + payload.byteLength);
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      view.setUint8(0, 0x00);
      view.setUint32(1, msgId);
      view.setUint16(5, seq);
      view.setUint16(7, totalChunks);
      view.setUint16(9, payload.byteLength);
      view.setUint8(11, seq === totalChunks - 1 ? 0x01 : 0x00);
      chunk.set(payload, HEADER_SIZE);

      dc.send(chunk as any);
    }
  }
}
