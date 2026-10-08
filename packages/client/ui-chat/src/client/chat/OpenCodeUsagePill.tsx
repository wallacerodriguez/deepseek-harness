// OpenCode Go subscription-usage pill: the third stats pill beside the time
// and token-usage pills. Shown only while the session's current billed route
// is the subscription provider (the Host reports which id that is); the poll
// pauses whenever the pill's document is not visible.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OpenCodeUsageSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenCodeUsageWindow } from '@deepseek-ai/dsh-api-opencode-usage-controller/types'
import type { ClockTranslate } from './message-chrome.ts'
import { formatMessageClock } from './message-chrome.ts'
import { OPENCODE_USAGE_POLL_MS } from './opencode-usage.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './OpenCodeUsagePill.module.css'
import dialogCss from './stat-dialog.module.css'

/** Registration-side read face: one usage answer per call, or null when the wire call itself failed. */
export interface OpencodeUsageInjected {
  /** Read the Host's cached subscription usage; an assembly or transport failure answers null. */
  fetchOpencodeUsage: () => Promise<OpenCodeUsageSnapshot | null>
}

/** Full pill props. */
export type OpenCodeUsagePillProps =
  & PropsLocale<'chat'>
  & InjectFace<OpencodeUsageInjected>
  & {
    /** The session's latest billed provider; the pill hides while this is not the subscription provider. */
    currentRoute: string
    /** The pills row's exclusive dialog slot: opening this pill closes the sibling dialogs. */
    dialog: { readonly open: boolean; readonly setOpen: (open: boolean) => void }
  }

/** Pill translate seat: the full Chat dictionary union plus the shared clock templates. */
export type PillTranslate = PropsLocale<'chat'>['t'] & ClockTranslate

/** Window label key a dialog row renders its heading with. */
export type OpenCodeWindowLabel = 'stats.opencode.rolling' | 'stats.opencode.weekly' | 'stats.opencode.monthly'

/** One window row's cells: consumed percent and the formatted reset instant. */
interface WindowCells {
  readonly percent: string
  readonly reset: string | null
}

/**
 * Read one window row's dialog cells: consumed percent plus the reset instant,
 * or an em-dash percent with no reset while absent.
 * @param window - Host-reported window; null when absent.
 * @param t - pill translate seat.
 * @returns the cells for that row.
 */
export function windowCells(window: OpenCodeUsageWindow | null, t: PillTranslate): WindowCells {
  const reset = window === null
    ? null
    : t('stats.opencode.resetsAt', { clock: formatMessageClock(Date.parse(window.resetsAt), t) })
  return { percent: window === null ? '—' : `${window.percent}%`, reset }
}

/** The three windows the dialog lists, in Host-read order. */
const WINDOWS: readonly { readonly key: 'rolling' | 'weekly' | 'monthly'; readonly label: OpenCodeWindowLabel }[] = [
  { key: 'rolling', label: 'stats.opencode.rolling' },
  { key: 'weekly', label: 'stats.opencode.weekly' },
  { key: 'monthly', label: 'stats.opencode.monthly' },
]

/**
 * OpenCode Go subscription-usage pill.
 * @param props - inject face plus the owning dock's locale seat.
 * @returns the pill; it reads on mount and revalidates on the shared poll cadence,
 *   skipping hidden-document intervals, and renders nothing until one answer is held.
 */
export function OpenCodeUsagePill({ currentRoute, fetchOpencodeUsage, t, dialog }: OpenCodeUsagePillProps) {
  // The last Host answer, success or reported-unavailable; it survives dialog
  // open/close and is replaced wholesale by the next read.
  const [snapshot, setSnapshot] = useState<OpenCodeUsageSnapshot | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const read = async (): Promise<void> => {
      // A hidden document keeps the endpoint quiet: revalidation waits for the
      // next visible interval tick, and the Host cache answers that one.
      if (document.visibilityState === 'hidden') return
      const answer = await fetchOpencodeUsage()
      if (disposed || answer === null) return
      setSnapshot(answer)
    }
    const schedule = (): void => {
      timer = window.setTimeout(() => { void read() }, OPENCODE_USAGE_POLL_MS)
    }
    void read()
    schedule()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [fetchOpencodeUsage])
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(dialog)

  // Hide once the Host named its provider: a session whose latest billed turn
  // is another provider keeps the pill out entirely.
  if (snapshot !== null && snapshot.providerId !== currentRoute) return null
  if (snapshot === null) return null
  const percent = snapshot.available && snapshot.rolling !== null
    ? snapshot.rolling.percent
    : null
  const label = percent !== null
    ? t('stats.opencode.pill', { percent })
    : t('stats.opencode.unavailable')
  if (currentRoute !== (snapshot?.providerId ?? currentRoute)) return null
  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => { setOpen(!open) }}
      >
        <IconDataOutline16 />
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('stats.opencode.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDataOutline16 />
              {t('stats.opencode.title')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-opencode-usage-details>
            {!snapshot.available && (
              <dd>{t('stats.opencode.unavailableReason', { reason: snapshot.unavailableReason ?? '' })}</dd>
            )}
            {snapshot.available && WINDOWS.map(({ key, label: windowLabel }) => {
              const cells = windowCells(snapshot[key], t)
              return (
                <div className={css.window} key={key}>
                  <dt>{t(windowLabel)}</dt>
                  <dd>{cells.percent}</dd>
                  {cells.reset !== null && <dd>{cells.reset}</dd>}
                </div>
              )
            })}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
}
