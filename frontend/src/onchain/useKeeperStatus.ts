import { useEffect, useState } from 'react';

export interface KeeperStatus {
  configured: boolean;
  healthy: boolean;
  graceSeconds: number;
  relayerHealthy: boolean;
  relayGraceSeconds: number;
  keeperUrl: string | null;
}

function readKeeperUrl(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const raw = env?.VITE_KEEPER_URL?.trim();
    if (!raw) return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function useKeeperStatus(overrideUrl?: string | null): KeeperStatus {
  const keeperUrl = overrideUrl !== undefined ? overrideUrl : readKeeperUrl();
  const [status, setStatus] = useState<KeeperStatus>({
    configured: Boolean(keeperUrl),
    healthy: false,
    graceSeconds: 5,
    relayerHealthy: false,
    relayGraceSeconds: 5,
    keeperUrl,
  });

  useEffect(() => {
    if (!keeperUrl) {
      setStatus({
        configured: false,
        healthy: false,
        graceSeconds: 5,
        relayerHealthy: false,
        relayGraceSeconds: 5,
        keeperUrl: null,
      });
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const ctrl = new AbortController();
        const timeoutId = window.setTimeout(() => ctrl.abort(), 3_000);
        const res = await fetch(`${keeperUrl}/health`, { signal: ctrl.signal });
        window.clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          status?: string;
          lowBalance?: boolean;
          dryRun?: boolean;
          graceSeconds?: number;
          relayerEnabled?: boolean;
          relayGraceSeconds?: number;
        };
        if (cancelled) return;
        const healthy = data.status === 'ok' && !data.lowBalance && !data.dryRun;
        setStatus({
          configured: true,
          healthy,
          graceSeconds:
            typeof data.graceSeconds === 'number' && data.graceSeconds >= 0
              ? data.graceSeconds
              : 5,
          relayerHealthy: healthy && Boolean(data.relayerEnabled),
          relayGraceSeconds:
            typeof data.relayGraceSeconds === 'number' && data.relayGraceSeconds >= 0
              ? data.relayGraceSeconds
              : 5,
          keeperUrl,
        });
      } catch {
        if (cancelled) return;
        setStatus({
          configured: true,
          healthy: false,
          graceSeconds: 5,
          relayerHealthy: false,
          relayGraceSeconds: 5,
          keeperUrl,
        });
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [keeperUrl]);

  return status;
}
