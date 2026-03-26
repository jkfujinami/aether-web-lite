// @ts-ignore
import argon2 from 'argon2-browser/dist/argon2-bundled.min.js';

/**
 * PoW Web Worker
 * 重い Argon2id 計算を UI スレッドから切り離して実行する。
 */
// Argon2 type enum: Argon2d=0, Argon2i=1, Argon2id=2
const DEFAULT_PARAMS = {
  type: 2,          // Argon2id by default
  mem: 1024,
  time: 1,
  parallelism: 1,
  hashLen: 32,
};

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, difficulty, nonce, id, params } = e.data;

  // メインスレッドから渡された params を優先し、欠落分をデフォルトで補完
  const hashParams = { ...DEFAULT_PARAMS, ...params };

  try {
    if (type === 'compute') {
      const result = await computePoW(payload, difficulty, hashParams);
      self.postMessage({ type: 'result', id, nonce: result });
    } else if (type === 'verify') {
      const result = await verifyPoW(payload, nonce, difficulty, hashParams);
      self.postMessage({ type: 'result', id, isValid: result });
    }
  } catch (err: any) {
    console.error(`[PoWWorker] Error during ${type}:`, err);
    self.postMessage({ type: 'error', id, error: err.message });
  }
};

async function computePoW(payload: Uint8Array, difficulty: number, params: any): Promise<bigint> {
  if (difficulty === 0) return 0n;
  let nonce = 0n;

  while (true) {
    const input = concatBytes(payload, bigintToBytes(nonce));
    const result = await argon2.hash({
      ...params,
      pass: input,
      salt: getSalt(input),
    });

    if (checkDifficulty(result.hash, difficulty)) {
      return nonce;
    }
    nonce++;
  }
}

async function verifyPoW(payload: Uint8Array, nonce: bigint, difficulty: number, params: any): Promise<boolean> {
  if (difficulty === 0) return true;
  const input = concatBytes(payload, bigintToBytes(nonce));
  
  const result = await argon2.hash({
    ...params,
    pass: input,
    salt: getSalt(input),
  });

  return checkDifficulty(result.hash, difficulty);
}

// --- Helper Functions (Duplicated for Worker context) ---

function checkDifficulty(hash: Uint8Array, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8);
  const remainBits = difficulty % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  if (remainBits > 0) {
    const mask = 0xFF << (8 - remainBits);
    if ((hash[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

function getSalt(input: Uint8Array): Uint8Array {
  if (input.length >= 16) return input.slice(0, 16);
  const pad = new Uint8Array(16);
  pad.set(input);
  return pad;
}

function bigintToBytes(val: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, val, false); 
  return buf;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const res = new Uint8Array(a.length + b.length);
  res.set(a, 0);
  res.set(b, a.length);
  return res;
}
