import { useEffect, useRef } from 'react'
import { useData } from './data'
import { vault } from '@/vault/store'

const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
const POSTPONE_MS = 2 * 60_000

/**
 * Locks the vault after inactivity and after the app has been hidden for a while.
 *
 * No data is lost by locking: `vault.lock()` waits for in-flight writes to finish first, and every saved record is
 * already persisted (encrypted). Text typed into a form that was NEVER submitted is discarded when the screen locks,
 * so if a dialog is open the idle lock is postponed once by two minutes to give the user a chance to finish.
 */
export function AutoLock() {
  const { settings } = useData()
  const idleMs = (settings.autoLockMinutes ?? 5) * 60_000 // 0 = never
  const hideMs = (settings.lockOnHideSeconds ?? 60) * 1000 // <0 = never
  const last = useRef(Date.now())
  const hiddenAt = useRef<number | null>(null)

  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let postponed = false

    const lockNow = () => void vault.lock()
    const armIdle = (ms: number) => {
      clearTimeout(idleTimer)
      if (idleMs <= 0) return
      idleTimer = setTimeout(() => {
        if (!postponed && document.querySelector('dialog[open]')) {
          postponed = true
          armIdle(POSTPONE_MS)
        } else lockNow()
      }, ms)
    }
    const onActivity = () => {
      last.current = Date.now()
      postponed = false
      armIdle(idleMs)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now()
        if (hideMs === 0) return lockNow()
        if (hideMs > 0) hideTimer = setTimeout(lockNow, hideMs)
      } else {
        clearTimeout(hideTimer)
        // timers can be suspended while hidden (mobile), so also check elapsed wall-clock time
        const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0
        hiddenAt.current = null
        if ((hideMs >= 0 && away >= hideMs && away > 0) || (idleMs > 0 && Date.now() - last.current >= idleMs && !document.querySelector('dialog[open]'))) lockNow()
        else onActivity()
      }
    }

    armIdle(idleMs)
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(idleTimer)
      clearTimeout(hideTimer)
      for (const e of ACTIVITY) window.removeEventListener(e, onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [idleMs, hideMs])

  return null
}
