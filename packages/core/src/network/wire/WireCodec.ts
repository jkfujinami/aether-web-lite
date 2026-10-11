import { encode, decode } from '@msgpack/msgpack';
import { WireType } from './WireTypes';

export interface DecodedWireMessage {
  type: WireType;
  payload: any;
}
/** 実在する WireType の集合。decode の判定に使う。 */
const KNOWN_WIRE_TYPES: ReadonlySet<number> = new Set(
  Object.values(WireType).filter((v): v is number => typeof v === 'number' && v !== WireType.UNKNOWN),
);

export class WireCodec {
  private static readonly REVERSE_TYPE_MAP: Record<number, string> = {
    [WireType.HELLO]: 'hello',
    [WireType.JOIN]: 'join',
    [WireType.RING_INFO]: 'ring-info',
    [WireType.PING]: 'ping',
    [WireType.PONG]: 'pong',
    [WireType.PEX_REQUEST]: 'pex-request',
    [WireType.PEX_RESPONSE]: 'pex-response',
    [WireType.SDP_RELAY]: 'sdp-relay',
    [WireType.ICE_RELAY]: 'ice-relay',
    [WireType.GOSSIP]: 'gossip',
    [WireType.STEM]: 'stem',
    [WireType.ONION_STEM]: 'onion-stem',
    [WireType.HINT]: 'hint',
    [WireType.HINT_STEM]: 'hint-stem',
    [WireType.DHT_PUT]: 'dht-put',
    [WireType.DHT_PUT_STEM]: 'dht-put-stem',
    [WireType.DHT_GET]: 'dht-get',
    [WireType.DHT_RES]: 'dht-res',
  };

  /**
   * V2: 1-byte header (WireType) + MsgPack payload
   */
  static encode(type: WireType, payload: any): Uint8Array {
    const tag = this.REVERSE_TYPE_MAP[type];
    
    // Rust側 (Internally Tagged Enum) が期待する {"type": "..."} を注入
    const taggedPayload = (tag && typeof payload === 'object' && payload !== null)
      ? { type: tag, ...payload }
      : payload;

    const body = encode(taggedPayload);
    const frame = new Uint8Array(1 + body.byteLength);
    frame[0] = type;
    frame.set(body, 1);
    return frame;
  }

  /**
   * Decode binary frame with fallback to JSON
   */
  static decode(data: Uint8Array): DecodedWireMessage {
    const typeByte = data[0];
    
    // ★ 範囲のハードコードはしない。
    //   以前は `0x10 <= t <= 0x52` と書いていたため、範囲外に WireType を
    //   足した瞬間に無言で JSON フォールバックへ落ち、
    //   「送っているのに相手が一切受け取らない」という形で壊れた。
    //   既知の WireType 集合そのもので判定する。
    if (KNOWN_WIRE_TYPES.has(typeByte)) {
      try {
        const payload = decode(data.subarray(1));
        return { type: typeByte as WireType, payload };
      } catch {
        // MsgPack として読めなければ下の JSON フォールバックへ
      }
    }

    // Fallback: Plain JSON string?
    try {
      const text = new TextDecoder().decode(data);
      const msg = JSON.parse(text);
      
      // Map JSON 'type' to WireType
      const typeMap: Record<string, WireType> = {
        'hello': WireType.HELLO,
        'join': WireType.JOIN,
        'ping': WireType.PING,
        'pong': WireType.PONG,
        'gossip': WireType.GOSSIP,
        'stem': WireType.STEM,
        'onion-stem': WireType.ONION_STEM,
        'dht-put': WireType.DHT_PUT,
        'dht-get': WireType.DHT_GET,
        'dht-res': WireType.DHT_RES,
        'pex-request': WireType.PEX_REQUEST,
        'pex-response': WireType.PEX_RESPONSE,
        'sdp-relay': WireType.SDP_RELAY,
        'ice-relay': WireType.ICE_RELAY
      };

      return {
        // 自前のキーだけを見る ("constructor" や "__proto__" で Object.prototype の
        // メンバーを型として返さない)
        type: typeof msg?.type === 'string' && Object.prototype.hasOwnProperty.call(typeMap, msg.type)
          ? typeMap[msg.type]
          : WireType.UNKNOWN,
        payload: msg
      };

    } catch (e) {
      return { type: WireType.UNKNOWN, payload: null };
    }
  }
}
