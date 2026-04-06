/**
 * Uint8Array および BigInt を効率的（とは言えないが現状の仕様）にJSONで扱うためのシリアライザ
 */
export class JsonBinary {
  /**
   * オブジェクトをJSON文字列に変換。Uint8Array および BigInt を自動的にラップする。
   */
  static stringify(obj: any): string {
    return JSON.stringify(obj, JsonBinary.replacer);
  }

  /**
   * JSON文字列をオブジェクトに復元。ラップされた Uint8Array および BigInt を自動的に復元する。
   */
  static parse<T = any>(json: string): T {
    return JSON.parse(json, JsonBinary.reviver);
  }

  /**
   * 既存の JSON.parse(reviver) 形式として使える関数のみを提供
   */
  static reviver(_key: string, value: any): any {
    if (value && value._type === 'BigInt') return BigInt(value.value);
    if (value && value._type === 'Uint8Array') return new Uint8Array(value.data);
    return value;
  }

  /**
   * 既存 of JSON.stringify(replacer) 形式として使える関数のみを提供
   */
  static replacer(_key: string, value: any): any {
    if (typeof value === 'bigint') return { _type: 'BigInt', value: value.toString() };
    if (value instanceof Uint8Array) return { _type: 'Uint8Array', data: Array.from(value) };
    return value;
  }
}

