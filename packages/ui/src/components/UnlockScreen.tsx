import { useState, type FormEvent } from 'react';
import { useP2P, MIN_PASSPHRASE_LENGTH } from '../providers/P2PProvider';
import { SecurityInfo } from './SecurityInfo';

/**
 * パスワード画面。
 *
 * 端末の全データはこのパスワードで暗号化される。忘れた場合の復元手段は無く、
 * 全データを消して作り直すしかない (復元手段を作ると、その分だけ押収に弱くなる)。
 */
export function UnlockScreen() {
  const { lockState, unlock, unlockError, resetAll } = useP2P();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const isSetup = lockState === 'setup';
  const busy = lockState === 'starting' || lockState === 'checking';

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (isSetup) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        setLocalError(`パスワードは ${MIN_PASSPHRASE_LENGTH} 文字以上にしてください`);
        return;
      }
      if (passphrase !== confirm) {
        setLocalError('確認用のパスワードが一致しません');
        return;
      }
    }
    if (passphrase.length === 0) return;
    const value = passphrase;
    setPassphrase('');
    setConfirm('');
    await unlock(value);
  };

  const onReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    await resetAll();
  };

  return (
    <div className="column-content" style={{ maxWidth: '420px', margin: '60px auto' }}>
      <div className="card">
        <h2 style={{ fontSize: '18px', marginBottom: '10px' }}>
          {isSetup ? 'パスワードを設定' : 'ロックを解除'}
        </h2>
        <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '15px' }}>
          {isSetup
            ? 'この端末に保存されるすべてのデータ (投稿履歴・板の鍵など) をこのパスワードで暗号化します。忘れると復元できません。'
            : 'この端末のデータは暗号化されています。パスワードを入力してください。'}
        </p>

        <form onSubmit={onSubmit} className="input-group">
          <input
            type="password"
            aria-label="パスワード"
            placeholder="パスワード"
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
          />
          {isSetup && (
            <input
              type="password"
              aria-label="パスワード (確認)"
              placeholder="パスワード (確認)"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              style={{ marginTop: '8px' }}
            />
          )}
          <button className="btn" type="submit" disabled={busy || passphrase.length === 0} style={{ marginTop: '12px' }}>
            {busy ? '起動中...' : isSetup ? '設定して開始' : '解除'}
          </button>
        </form>

        {(localError || unlockError) && (
          <div role="alert" style={{ color: '#ef4444', fontSize: '12px', marginTop: '10px' }}>
            {localError || unlockError}
          </div>
        )}

        {isSetup && (
          <details style={{ marginTop: '16px' }} open>
            <summary style={{ fontSize: '12px', cursor: 'pointer' }}>AETHER で守れること・守れないこと</summary>
            <div style={{ marginTop: '8px' }}>
              <SecurityInfo compact />
            </div>
          </details>
        )}

        {!isSetup && (
          <div style={{ marginTop: '20px', fontSize: '11px', color: 'var(--text-dim)' }}>
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-dim)', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit' }}
            >
              {confirmReset
                ? 'もう一度押すと、この端末の全データを消去して作り直します (元に戻せません)'
                : 'パスワードを忘れた場合'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
