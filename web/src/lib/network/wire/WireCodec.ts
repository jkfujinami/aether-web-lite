import { encode, decode } from '@msgpack/msgpack';
import { WireType } from './WireTypes';

export interface DecodedWireMessage {
  type: WireType;
  payload: any;
}

export class WireCodec {
  /**
   * V2: 1-byte header (WireType) + MsgPack payload
   */
  static encode(type: WireType, payload: any): Uint8Array {
    const body = encode(payload);
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
    
    // First byte is one of our enums
    if (typeByte >= 0x10 && typeByte <= 0x52) {
      try {
        const payload = decode(data.subarray(1));
        return { type: typeByte as WireType, payload };
      } catch (e) {
        console.warn(`[WireCodec] MsgPack decode failed for 0x${typeByte.toString(16)}, falling back to JSON`, e);
      }
    }

    // Fallback: Plain JSON string?
    try {
      const text = new TextDecoder().decode(data);
      const msg = JSON.parse(text);
      
      // Map JSON 'type' to WireType
      const typeMap: Record<string, WireType> = {
        'join': WireType.JOIN,
        'ping': WireType.PING,
        'pong': WireType.PONG,
        'gossip': WireType.GOSSIP,
        'dht-put': WireType.DHT_PUT,
        'dht-get': WireType.DHT_GET,
        'dht-res': WireType.DHT_RES,
        'pex-request': WireType.PEX_REQUEST,
        'pex-response': WireType.PEX_RESPONSE,
        'sdp-relay': WireType.SDP_RELAY,
        'ice-relay': WireType.ICE_RELAY
      };

      return {
        type: typeMap[msg.type] || WireType.UNKNOWN,
        payload: msg
      };

    } catch (e) {
      return { type: WireType::UNKNOWN, payload: null };
    }
  }
}
