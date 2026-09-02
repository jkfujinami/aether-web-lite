import sodium from '../crypto/sodium';
import { solvePow, toBytes, type PowCommittedHeader } from '../crypto/PowPolicy';

/**
 * PoW Web Worker
 *
 * PoW の *探索* だけをこのスレッドで行う。検証はメインスレッドで同期実行する
 * ({@link ../crypto/PoWEngine})。SHA-256 の検証は 1.3us 程度で、Worker への
 * postMessage 往復のほうが遥かに高くつくうえ、単一 Worker が受信処理の
 * 直列化点になって head-of-line blocking を招くため。
 *
 * 旧実装は argon2-browser を使っていたが、メインスレッド側 (PoWEngine) が
 * type:2 (Argon2id)、この Worker が type:0 (Argon2d) を既定にしており、
 * 送信側と検証側で別のハッシュを計算し得る不整合があった。実装を
 * PowPolicy 1 箇所に集約したことで構造的に起こらなくなっている。
 */

interface ComputeRequest {
  id: string;
  type: 'compute';
  header: {
    timestamp: number;
    zone_id: number;
    pow_difficulty: number;
    nonce: unknown;
    payload: unknown;
  };
}

self.onmessage = async (e: MessageEvent<ComputeRequest>) => {
  const { id, type, header } = e.data ?? ({} as ComputeRequest);

  try {
    await sodium.ready;

    if (type !== 'compute') {
      throw new Error(`unsupported request type: ${String(type)}`);
    }

    const committed: PowCommittedHeader = {
      timestamp: header.timestamp,
      zone_id: header.zone_id,
      pow_difficulty: header.pow_difficulty,
      nonce: toBytes(header.nonce),
      payload: toBytes(header.payload),
    };

    const nonce = solvePow(committed);
    if (nonce === null) throw new Error('PoW search exhausted');

    // BigInt は構造化複製で渡せる処理系とそうでない処理系があるため文字列で返す
    self.postMessage({ id, type: 'result', result: nonce.toString() });
  } catch (err: any) {
    self.postMessage({ id, type: 'error', error: err?.message ?? String(err) });
  }
};
