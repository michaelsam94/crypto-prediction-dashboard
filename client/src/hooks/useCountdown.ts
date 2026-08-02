import { useEffect, useState } from "react";

/**
 * Ticking countdown to an absolute epoch-ms deadline.
 * Recomputes from wall-clock time each tick so it stays correct if the tab is
 * throttled or the machine sleeps.
 */
export function useCountdown(deadline: number | null | undefined): number {
  const [remaining, setRemaining] = useState(() =>
    deadline ? Math.max(deadline - Date.now(), 0) : 0,
  );

  useEffect(() => {
    if (!deadline) {
      setRemaining(0);
      return;
    }
    setRemaining(Math.max(deadline - Date.now(), 0));
    const id = setInterval(() => {
      setRemaining(Math.max(deadline - Date.now(), 0));
    }, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  return remaining;
}
