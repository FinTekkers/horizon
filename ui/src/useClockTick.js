import { useEffect, useState } from 'react'

// HZ-228: re-renders its caller every intervalMs while `enabled`, so a view
// that reads the clock while rendering stays current. One caller per view
// (the Board), so every card shares one interval; cleared on unmount and
// whenever `enabled` goes false.
export function useClockTick(intervalMs, enabled = true) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => setTick((n) => n + 1), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
}
