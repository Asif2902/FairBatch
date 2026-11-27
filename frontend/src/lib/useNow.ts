import { useEffect, useState } from 'react';

/**
 * Wall-clock seconds ticker used for batch countdowns.
 *
 * Samples at <= 250ms when ticking every second and bails out unless the whole
 * second actually changed, eliminating skipped seconds and uneven 2-second
 * stalls caused by `setInterval(1000)` drifting across second boundaries.
 * Also syncs immediately when the browser tab regains visibility.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState<number>(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    const sync = () => {
      const next = Math.floor(Date.now() / 1_000);
      setNow((prev) => (prev === next ? prev : next));
    };

    const sampleMs = intervalMs >= 1_000 ? 250 : Math.max(50, intervalMs);
    const id = window.setInterval(sync, sampleMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', sync);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', sync);
    };
  }, [intervalMs]);

  return now;
}
