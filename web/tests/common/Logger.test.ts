import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LogLevel,
  createLogger,
  setLevel,
  levelFor,
  resetLevels,
  currentLevels,
  parseLevel,
  levelName,
  setSink,
  installConsoleHandle,
  type Sink,
} from '@/lib/common/Logger';

function capture() {
  const lines: Array<{ method: string; args: unknown[] }> = [];
  const sink: Sink = {
    error: (...a) => lines.push({ method: 'error', args: a }),
    warn: (...a) => lines.push({ method: 'warn', args: a }),
    info: (...a) => lines.push({ method: 'info', args: a }),
    log: (...a) => lines.push({ method: 'log', args: a }),
    debug: (...a) => lines.push({ method: 'debug', args: a }),
  };
  setSink(sink);
  return lines;
}

beforeEach(() => {
  resetLevels();
  delete (process.env as any).AETHER_LOG;
});

describe('レベル判定', () => {
  it('レベル以下のものだけ出力する', () => {
    const lines = capture();
    setLevel('*', 'WARN');
    const log = createLogger('x');

    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    log.trace('t');

    expect(lines.map((l) => l.method)).toEqual(['error', 'warn']);
  });

  it('SILENT は何も出さない', () => {
    const lines = capture();
    setLevel('*', 'SILENT');
    const log = createLogger('x');
    log.error('e');
    log.warn('w');
    expect(lines).toHaveLength(0);
  });

  it('TRACE は全部出す', () => {
    const lines = capture();
    setLevel('*', 'TRACE');
    const log = createLogger('x');
    log.error('e'); log.warn('w'); log.info('i'); log.debug('d'); log.trace('t');
    expect(lines).toHaveLength(5);
  });

  it('スコープ名が前置される', () => {
    const lines = capture();
    setLevel('*', 'INFO');
    createLogger('gossip').info('hello');
    expect(lines[0].args[0]).toBe('[gossip]');
    expect(lines[0].args[1]).toBe('hello');
  });
});

describe('スコープごとの上書き', () => {
  it('特定スコープだけ上げられる', () => {
    const lines = capture();
    setLevel('*', 'WARN');
    setLevel('gossip', 'TRACE');

    createLogger('gossip').trace('a');
    createLogger('mailbox').trace('b');

    expect(lines).toHaveLength(1);
    expect(lines[0].args[0]).toBe('[gossip]');
  });

  it('★ドット区切りは親スコープを継承する', () => {
    setLevel('*', 'WARN');
    setLevel('network', 'DEBUG');

    expect(levelFor('network.mailbox')).toBe(LogLevel.DEBUG);
    expect(levelFor('network.mailbox.dht')).toBe(LogLevel.DEBUG);
    expect(levelFor('logic')).toBe(LogLevel.WARN);
  });

  it('より具体的な指定が親より優先される', () => {
    setLevel('*', 'WARN');
    setLevel('network', 'DEBUG');
    setLevel('network.mailbox', 'TRACE');

    expect(levelFor('network.mailbox')).toBe(LogLevel.TRACE);
    expect(levelFor('network.gossip')).toBe(LogLevel.DEBUG);
  });

  it('child() が子スコープを作る', () => {
    const lines = capture();
    setLevel('*', 'SILENT');
    setLevel('net.mail', 'INFO');

    const child = createLogger('net').child('mail');
    expect(child.scope).toBe('net.mail');
    child.info('x');
    expect(lines[0].args[0]).toBe('[net.mail]');
  });
});

describe('★遅延評価 (ホットパスのコスト)', () => {
  it('出力されないときは引数の関数を呼ばない', () => {
    capture();
    setLevel('*', 'WARN');
    const build = vi.fn(() => 'expensive');

    createLogger('x').trace(build);

    expect(build).not.toHaveBeenCalled();
  });

  it('出力されるときは呼んで展開する', () => {
    const lines = capture();
    setLevel('*', 'TRACE');
    const build = vi.fn(() => 'expensive');

    createLogger('x').trace(build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(lines[0].args[1]).toBe('expensive');
  });

  it('enabled() で事前に判定できる', () => {
    setLevel('*', 'INFO');
    const log = createLogger('x');
    expect(log.enabled(LogLevel.INFO)).toBe(true);
    expect(log.enabled(LogLevel.DEBUG)).toBe(false);
  });
});

describe('レベル文字列の解釈', () => {
  it('大文字小文字を問わない', () => {
    expect(parseLevel('trace')).toBe(LogLevel.TRACE);
    expect(parseLevel('TRACE')).toBe(LogLevel.TRACE);
    expect(parseLevel(' Warn ')).toBe(LogLevel.WARN);
  });

  it('不正値は null', () => {
    expect(parseLevel('nope')).toBeNull();
    expect(parseLevel(99)).toBeNull();
    expect(parseLevel(undefined)).toBeNull();
    expect(parseLevel({})).toBeNull();
  });

  it('数値も受ける', () => {
    expect(parseLevel(0)).toBe(LogLevel.SILENT);
    expect(parseLevel(5)).toBe(LogLevel.TRACE);
  });

  it('levelName が往復する', () => {
    expect(levelName(LogLevel.DEBUG)).toBe('DEBUG');
    expect(levelName(LogLevel.SILENT)).toBe('SILENT');
  });

  it('不正なレベル指定は設定を変えない', () => {
    setLevel('*', 'WARN');
    expect(setLevel('*', 'bogus')).toBe(false);
    expect(levelFor('*')).toBe(LogLevel.WARN);
  });
});

describe('環境変数からの読み込み', () => {
  it('AETHER_LOG のスペックを解釈する', () => {
    resetLevels();
    (process.env as any).AETHER_LOG = '*=warn,gossip=trace,network.mailbox=debug';

    expect(levelFor('gossip')).toBe(LogLevel.TRACE);
    expect(levelFor('network.mailbox')).toBe(LogLevel.DEBUG);
    expect(levelFor('other')).toBe(LogLevel.WARN);
  });

  it('スコープ省略は全体指定として扱う', () => {
    resetLevels();
    (process.env as any).AETHER_LOG = 'debug';
    expect(levelFor('anything')).toBe(LogLevel.DEBUG);
  });

  it('壊れた指定を混ぜても他が生きる', () => {
    resetLevels();
    (process.env as any).AETHER_LOG = 'gossip=nope,mailbox=trace,=warn,x=';
    expect(levelFor('mailbox')).toBe(LogLevel.TRACE);
    expect(() => levelFor('gossip')).not.toThrow();
  });
});

describe('コンソールハンドル', () => {
  it('aetherLog.set / show / reset が動く', () => {
    installConsoleHandle();
    const handle = (globalThis as any).aetherLog;

    handle.set('gossip', 'trace');
    expect(levelFor('gossip')).toBe(LogLevel.TRACE);
    expect(handle.show().gossip).toBe('TRACE');

    handle.reset();
    expect(currentLevels().gossip).toBeUndefined();
  });

  it('不正なレベルを渡しても例外を投げない', () => {
    installConsoleHandle();
    const handle = (globalThis as any).aetherLog;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => handle.set('x', 'bogus')).not.toThrow();
    warn.mockRestore();
  });
});

describe('★ブラウザで実際に見えること', () => {
  it('★DEBUG は console.log へ出す (console.debug は DevTools 既定で隠れる)', () => {
    const lines = capture();
    setLevel('*', 'DEBUG');
    createLogger('x').debug('visible');

    // console.debug は Chrome の "Verbose" 扱いで既定では表示されない。
    // ここを debug のままにすると「レベルを上げたのに何も出ない」になる。
    expect(lines[0].method).toBe('log');
  });

  it('TRACE だけ console.debug (Verbose)', () => {
    const lines = capture();
    setLevel('*', 'TRACE');
    createLogger('x').trace('verbose only');
    expect(lines.at(-1)!.method).toBe('debug');
  });

  it('★開発の既定レベルは DEBUG (経路が既定で追える)', () => {
    resetLevels();
    delete (process.env as any).AETHER_LOG;
    // 既定が INFO だと、経路を追うための debug ログが全部落ちて
    // 「何も出ない」状態になる
    expect(levelFor('anything')).toBe(LogLevel.DEBUG);
  });
});
