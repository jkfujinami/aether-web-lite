"use client";

import { useEffect, useState } from "react";
import { AetherApp } from "@aether/ui";
import { sodiumReady } from "@aether/core";

/**
 * Web 版。画面もプロトコルも Desktop と同じもの (@aether/ui + @aether/core) を使う。
 *
 * トラッカーの既定値は、このページを配信したサーバ自身の /ws とする。
 * ページを取得した時点でそのサーバには IP アドレスが見えているので、新たに晒すものは無い。
 * 利用者が設定画面で変えた値があれば、そちらが優先される。
 * 平文の ws:// は localhost 以外では検証で弾かれる (https で配信すること)。
 */
function sameOriginTracker(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}

export default function Page() {
  const [tracker, setTracker] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    // IndexedDB と libsodium はブラウザでしか使えないので、描画はクライアントで始める
    let cancelled = false;
    sodiumReady.then(() => {
      if (!cancelled) setTracker(sameOriginTracker());
    });
    return () => { cancelled = true; };
  }, []);

  if (tracker === undefined) return null;
  return <AetherApp badge="Web" defaultTrackerUrl={tracker} />;
}
