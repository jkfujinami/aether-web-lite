import React from 'react';
import { ANONYMITY_LEVELS, type AnonymityLevel } from '@aether/core';
import { useP2P } from '../providers/P2PProvider';

const LEVEL_ORDER: AnonymityLevel[] = ['standard', 'safer', 'safest'];

const LEVEL_THEMES: Record<AnonymityLevel, { badgeColor: string; borderColor: string; bg: string }> = {
  standard: {
    badgeColor: '#a855f7',
    borderColor: '#a855f7',
    bg: 'rgba(168, 85, 247, 0.08)',
  },
  safer: {
    badgeColor: '#3b82f6',
    borderColor: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.08)',
  },
  safest: {
    badgeColor: '#10b981',
    borderColor: '#10b981',
    bg: 'rgba(16, 185, 129, 0.08)',
  },
};

/**
 * Tor Browser に準拠したオニオン回路セキュリティレベル設定画面。
 * 既定は最低 (標準: standard)。利用者が手動で引き上げる。
 */
export function SecurityLevelSettings({ onClose }: { onClose?: () => void }) {
  const { anonymityLevel, setAnonymityLevel } = useP2P();

  return (
    <div style={{ fontSize: '12px', lineHeight: 1.6, color: 'var(--text-main)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <div style={{ fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>🛡️</span>
          <span>セキュリティレベル (オニオン回路)</span>
        </div>
        <span style={{ fontSize: '10px', color: 'var(--text-dim)', border: '1px solid var(--border)', padding: '1px 6px', borderRadius: '3px' }}>
          Tor 準拠
        </span>
      </div>

      <div style={{ color: 'var(--text-dim)', marginBottom: '12px', fontSize: '11px' }}>
        オニオン回路のトラフィック混合遅延とダミー送信間隔を調整します。
        基本は「標準 (最低)」です。より強力なタイミング相関耐性が必要な場合は手動で引き上げてください。
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
        {LEVEL_ORDER.map((lvl) => {
          const cfg = ANONYMITY_LEVELS[lvl];
          const isSelected = anonymityLevel === lvl;
          const theme = LEVEL_THEMES[lvl];

          return (
            <div
              key={lvl}
              onClick={() => void setAnonymityLevel(lvl)}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              style={{
                border: isSelected ? `1.5px solid ${theme.borderColor}` : '1px solid var(--border)',
                background: isSelected ? theme.bg : 'var(--bg-main)',
                borderRadius: '4px',
                padding: '10px 12px',
                cursor: 'pointer',
                transition: 'all 0.15s ease-in-out',
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="radio"
                    name="anonymity-level"
                    checked={isSelected}
                    onChange={() => void setAnonymityLevel(lvl)}
                    style={{ accentColor: theme.badgeColor, cursor: 'pointer' }}
                  />
                  <span style={{ fontWeight: 700, fontSize: '12px', color: isSelected ? '#fff' : 'var(--text-main)' }}>
                    {cfg.label}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '1px 6px',
                    borderRadius: '3px',
                    background: theme.bg,
                    color: theme.badgeColor,
                    border: `1px solid ${theme.borderColor}`,
                  }}
                >
                  {lvl === 'standard' ? '既定・最速' : lvl === 'safer' ? 'バランス' : '最高匿名性'}
                </span>
              </div>

              <div style={{ color: 'var(--text-dim)', fontSize: '11px', marginLeft: '22px', marginBottom: '6px' }}>
                {cfg.description}
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  marginLeft: '22px',
                  fontSize: '10px',
                  color: 'var(--text-dim)',
                  borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                  paddingTop: '4px',
                }}
              >
                <span>ダミー間隔: <strong style={{ color: 'var(--text-main)' }}>{cfg.coverIntervalMs}ms</strong></span>
                <span>出口遅延: <strong style={{ color: 'var(--text-main)' }}>{cfg.exitDelayMs}ms</strong></span>
                <span>エコー上限: <strong style={{ color: 'var(--text-main)' }}>{cfg.echoTimeoutMs / 1000}秒</strong></span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        {onClose && (
          <button className="btn" onClick={onClose} style={{ padding: '4px 14px', fontSize: '11px' }}>
            閉じる
          </button>
        )}
      </div>
    </div>
  );
}
