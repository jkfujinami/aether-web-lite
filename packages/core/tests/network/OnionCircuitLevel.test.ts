import { describe, it, expect, vi } from 'vitest';
import {
  OnionCircuit,
  ANONYMITY_LEVELS,
  DEFAULT_ANONYMITY_LEVEL,
  CIRCUIT_CONFIG,
  type AnonymityLevel,
} from '../../src/network/onion/OnionCircuit';

describe('OnionCircuit: 匿名性セキュリティレベル (Tor 準拠)', () => {
  const dummyPeerManager: any = { myPeerId: '0'.repeat(32), peers: new Map() };
  const dummyDispatcher: any = { register: vi.fn(), dispatch: vi.fn() };
  const dummyDandelion: any = { onGuardChange: vi.fn(), getPinnedGuard: vi.fn() };

  it('既定レベルは最低 (standard) であり、CIRCUIT_CONFIG と一致すること', () => {
    expect(DEFAULT_ANONYMITY_LEVEL).toBe('standard');
    expect(ANONYMITY_LEVELS.standard.coverIntervalMs).toBe(300);
    expect(ANONYMITY_LEVELS.standard.exitDelayMs).toBe(500);
    expect(CIRCUIT_CONFIG.COVER_INTERVAL_MS).toBe(ANONYMITY_LEVELS.standard.coverIntervalMs);
    expect(CIRCUIT_CONFIG.EXIT_DELAY_MS).toBe(ANONYMITY_LEVELS.standard.exitDelayMs);
  });

  it('3段階のレベル (standard, safer, safest) が適切な遅延パラメータで定義されていること', () => {
    // standard (最低・最速)
    expect(ANONYMITY_LEVELS.standard.coverIntervalMs).toBe(300);
    expect(ANONYMITY_LEVELS.standard.exitDelayMs).toBe(500);
    expect(ANONYMITY_LEVELS.standard.echoTimeoutMs).toBe(5000);

    // safer (中・バランス)
    expect(ANONYMITY_LEVELS.safer.coverIntervalMs).toBe(1000);
    expect(ANONYMITY_LEVELS.safer.exitDelayMs).toBe(1500);
    expect(ANONYMITY_LEVELS.safer.echoTimeoutMs).toBe(15000);

    // safest (最高・匿名性最優先)
    expect(ANONYMITY_LEVELS.safest.coverIntervalMs).toBe(2000);
    expect(ANONYMITY_LEVELS.safest.exitDelayMs).toBe(2500);
    expect(ANONYMITY_LEVELS.safest.echoTimeoutMs).toBe(30000);
  });

  it('インスタンス生成時にレベルを指定しない場合は standard となること', () => {
    const circuit = new OnionCircuit(dummyPeerManager, dummyDispatcher, dummyDandelion);
    expect(circuit.getLevel()).toBe('standard');
    expect(circuit.getLevelConfig().level).toBe('standard');
    expect(circuit.echoTimeoutMs).toBe(5000);
  });

  it('インスタンス生成時に safer や safest を指定できること', () => {
    const circuitSafer = new OnionCircuit(dummyPeerManager, dummyDispatcher, dummyDandelion, { level: 'safer' });
    expect(circuitSafer.getLevel()).toBe('safer');
    expect(circuitSafer.echoTimeoutMs).toBe(15000);

    const circuitSafest = new OnionCircuit(dummyPeerManager, dummyDispatcher, dummyDandelion, { level: 'safest' });
    expect(circuitSafest.getLevel()).toBe('safest');
    expect(circuitSafest.echoTimeoutMs).toBe(30000);
  });

  it('setLevel で動的にレベルを変更でき、リスナーに通知されること', () => {
    const circuit = new OnionCircuit(dummyPeerManager, dummyDispatcher, dummyDandelion);
    const listener = vi.fn();
    const unsub = circuit.onLevelChange(listener);

    // safer へ引き上げ
    circuit.setLevel('safer');
    expect(circuit.getLevel()).toBe('safer');
    expect(circuit.echoTimeoutMs).toBe(15000);
    expect(listener).toHaveBeenCalledWith('safer');

    // safest へ引き上げ
    circuit.setLevel('safest');
    expect(circuit.getLevel()).toBe('safest');
    expect(circuit.echoTimeoutMs).toBe(30000);
    expect(listener).toHaveBeenCalledWith('safest');

    // standard へ戻す
    circuit.setLevel('standard');
    expect(circuit.getLevel()).toBe('standard');
    expect(circuit.echoTimeoutMs).toBe(5000);

    unsub();
    circuit.setLevel('safer');
    expect(listener).toHaveBeenCalledTimes(3); // unsub 後は呼ばれない
  });
});
