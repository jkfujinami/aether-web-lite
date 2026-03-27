export class RingPosition {
  private _value: number;

  constructor(value?: number) {
    if (value !== undefined) {
      if (value < 0.0 || value >= 1.0) {
        throw new Error("RingPosition must be between [0.0, 1.0)");
      }
      this._value = value;
    } else {
      // 乱数から [0.0, 1.0) の位置を生成
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      this._value = arr[0] / 0xFFFFFFFF; // MAX Uint32
      // 0xFFFFFFFF で割ると厳密には 1.0 になる可能性があるが
      // 実際にはほぼ [0.0, 1.0) に収まる。厳密には / (0xFFFFFFFF + 1)
      this._value = arr[0] / 4294967296.0; 
    }
  }

  get value(): number {
    return this._value;
  }

  /**
   * リング上の2点間の最短距離を計算する
   * @param a 位置 a [0, 1)
   * @param b 位置 b [0, 1)
   * @returns 距離 [0, 0.5]
   */
  static distance(a: number, b: number): number {
    const d = Math.abs(a - b);
    return Math.min(d, 1.0 - d);
  }

  /**
   * localStorage から過去の位置を復元、なければ新規生成して保存する。
   * これによりリロードしても同じ座標（隣人）を維持できる。
   */
  static async loadOrCreate(): Promise<RingPosition> {
    const saved = localStorage.getItem('aether_position');
    if (saved) {
      try {
        const val = parseFloat(saved);
        console.log(`[RingPosition] Resumed from position: ${val.toFixed(6)}`);
        return new RingPosition(val);
      } catch (e) {}
    }

    const pos = new RingPosition();
    localStorage.setItem('aether_position', pos.value.toString());
    console.log(`[RingPosition] New position generated: ${pos.value.toFixed(6)}`);
    return pos;
  }
}
