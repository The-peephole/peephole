import type {
  FullStackControlStore,
  RetainedFullStackControl,
} from "./fullStackRetention"

export const PREPARE_SIDE_PANEL_NAVIGATION =
  "peephole:side-panel:prepare-navigation"

/** The panel may hide only after the admitted job's controls are acknowledged. */
export function createNavigationBarrier(store: FullStackControlStore | null) {
  let initialized = false
  let creating = false
  let awaitingControl = false
  let writes = 0
  let failed = false
  const waiters = new Set<{
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const notify = () => {
    if (!failed && (!initialized || creating || awaitingControl || writes))
      return
    for (const waiter of waiters) {
      if (failed)
        waiter.reject(new Error("Preview controls are not safe to hide."))
      else waiter.resolve()
    }
    waiters.clear()
  }
  return {
    ready() {
      initialized = true
      notify()
    },
    fail() {
      failed = true
      notify()
    },
    setCreating(pending: boolean) {
      creating = pending
      if (pending) awaitingControl = true
      // A failed/lost Create response has no job ID. Keep the existing retry
      // controls visible; only a subsequently acknowledged job releases it.
      notify()
    },
    async save(control: RetainedFullStackControl | null) {
      writes++
      try {
        if (!store) throw new Error("Preview control storage unavailable.")
        await store.save(control)
        if (control) awaitingControl = false
        failed = false
      } catch (error) {
        failed = true
        throw error
      } finally {
        writes--
        notify()
      }
    },
    wait(): Promise<void> {
      if (failed)
        return Promise.reject(
          new Error("Preview controls are not safe to hide."),
        )
      if (initialized && !creating && !awaitingControl && writes === 0)
        return Promise.resolve()
      return new Promise((resolve, reject) => waiters.add({ resolve, reject }))
    },
  }
}
