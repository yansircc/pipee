import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { copyText } from "@/lib/clipboard"
import { useI18n } from "@/lib/i18n"
import {
  createNotice,
  getNextAutoDismissNotice,
  noticeReducer,
  NOTICE_AUTO_DISMISS_MS,
  type NoticeItem,
  type NoticeSource,
  type NoticeType,
} from "@/lib/notices"
import { after } from "@/browser/timing"
import { useBrowserEffectScope } from "@/browser/use-browser-effect-scope"

export interface ToastInput {
  readonly id?: string
  readonly message: string
  readonly source?: NoticeSource
  readonly type: NoticeType
}

interface ToastApi {
  readonly dismiss: (id: string) => void
  readonly push: (input: ToastInput) => string
}

const ToastContext = createContext<ToastApi>(null as never)

const TOAST_VISUALS: Record<NoticeType, { readonly color: string; readonly label: string; readonly mark: string }> = {
  info: { color: "var(--accent)", label: "Notice", mark: "i" },
  success: { color: "#16a34a", label: "Success", mark: "✓" },
  warning: { color: "#d97706", label: "Warning", mark: "!" },
  error: { color: "#dc2626", label: "Error", mark: "×" },
}

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [state, dispatch] = useReducer(noticeReducer, { visible: [], pending: [] })
  const sequence = useRef(0)
  const runScoped = useBrowserEffectScope("toast-provider")
  const autoDismissNotice = getNextAutoDismissNotice(state)

  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), [])
  const push = useCallback((input: ToastInput) => {
    sequence.current += input.id === undefined ? 1 : 0
    const id = input.id ?? `app-toast-${sequence.current}`
    dispatch({
      type: "add",
      notice: createNotice({
        id,
        message: input.message,
        source: input.source ?? "app",
        type: input.type,
      }),
    })
    return id
  }, [])

  useEffect(() => {
    if (autoDismissNotice === undefined) return
    return runScoped(
      after(`${NOTICE_AUTO_DISMISS_MS} millis`, () => dismiss(autoDismissNotice.id)),
      {
        onSuccess: () => undefined,
      },
    )
  }, [autoDismissNotice, dismiss, runScoped])

  const api = useMemo(() => ({ dismiss, push }), [dismiss, push])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport
        notices={state.visible}
        autoDismissNoticeId={autoDismissNotice?.id ?? null}
        onDismiss={dismiss}
        onExited={(id) => dispatch({ type: "remove", id })}
        runScoped={runScoped}
      />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

function ToastViewport({
  notices,
  autoDismissNoticeId,
  onDismiss,
  onExited,
  runScoped,
}: {
  readonly notices: ReadonlyArray<NoticeItem>
  readonly autoDismissNoticeId: string | null
  readonly onDismiss: (id: string) => void
  readonly onExited: (id: string) => void
  readonly runScoped: ReturnType<typeof useBrowserEffectScope>
}) {
  const { t } = useI18n()
  const [copiedNoticeId, setCopiedNoticeId] = useState<string | null>(null)
  const copyNotice = useCallback(
    (notice: NoticeItem) => {
      runScoped(
        copyText(notice.message).pipe(
          Effect.tap(() => Effect.sync(() => setCopiedNoticeId(notice.id))),
          Effect.andThen(Effect.sleep("1400 millis")),
          Effect.tap(() => Effect.sync(() => setCopiedNoticeId((current) => (current === notice.id ? null : current)))),
        ),
        { onSuccess: () => undefined },
      )
    },
    [runScoped],
  )

  if (notices.length === 0) return null
  return (
    <div aria-live="polite" aria-label={t("Notifications")} {...stylex.props(styles.viewport)}>
      {notices.map((notice) => {
        const visual = TOAST_VISUALS[notice.type]
        const copied = copiedNoticeId === notice.id
        return (
          <section
            key={notice.id}
            className={`${stylex.props(styles.toast).className} notice-shelf-item`}
            role={notice.type === "error" || notice.type === "warning" ? "alert" : "status"}
            onAnimationEnd={() => {
              if (notice.exiting) onExited(notice.id)
            }}
            style={{
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              background: `color-mix(in srgb, var(--bg-raised) 96%, ${visual.color})`,
              border: `1px solid color-mix(in srgb, ${visual.color} 22%, var(--border))`,
            }}
          >
            <span
              aria-hidden="true"
              {...stylex.props(styles.mark)}
              style={{ background: `color-mix(in srgb, ${visual.color} 13%, transparent)`, color: visual.color }}
            >
              {visual.mark}
            </span>
            <div {...stylex.props(styles.copy)}>
              <div {...stylex.props(styles.heading)}>
                <span {...stylex.props(styles.title)}>{t(visual.label)}</span>
                {notice.source === "extension" && <span {...stylex.props(styles.source)}>{t("Extension")}</span>}
              </div>
              <div {...stylex.props(styles.message)}>{notice.message}</div>
            </div>
            <div {...stylex.props(styles.actions)}>
              <button
                type="button"
                className={`${stylex.props(styles.action).className} notice-shelf-action`}
                onClick={() => copyNotice(notice)}
                aria-label={t(copied ? "Copied" : "Copy")}
                title={t(copied ? "Copied" : "Copy")}
                style={{ color: copied ? visual.color : "var(--text-dim)" }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
              <button
                type="button"
                className={`${stylex.props(styles.action).className} notice-shelf-action`}
                onClick={() => onDismiss(notice.id)}
                aria-label={t("Dismiss")}
                title={t("Dismiss")}
              >
                <CloseIcon />
              </button>
            </div>
            {notice.id === autoDismissNoticeId && (
              <span
                className="notice-shelf-timer"
                aria-hidden="true"
                style={{ background: visual.color, animationDuration: `${NOTICE_AUTO_DISMISS_MS}ms` }}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

const styles = stylex.create({
  viewport: {
    alignItems: "flex-end",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxWidth: "calc(100vw - 24px)",
    pointerEvents: "none",
    position: "fixed",
    right: { default: 18, "@media (max-width: 760px)": 12 },
    top: {
      default: "calc(var(--topbar-height) + 14px)",
      "@media (max-width: 760px)": "calc(var(--topbar-height) + 10px)",
    },
    width: 440,
    zIndex: "var(--layer-toast)",
  },
  toast: {
    alignItems: "start",
    borderRadius: 13,
    boxShadow: "0 16px 44px -22px rgba(15,23,42,0.38), 0 3px 10px rgba(15,23,42,0.08)",
    color: "var(--text)",
    display: "grid",
    fontSize: 13,
    gap: 11,
    gridTemplateColumns: "28px minmax(0, 1fr) auto",
    lineHeight: 1.55,
    overflow: "hidden",
    padding: "12px 11px 11px",
    pointerEvents: "auto",
    position: "relative",
    transformOrigin: "top center",
    width: "100%",
  },
  mark: {
    borderRadius: "50%",
    display: "grid",
    fontSize: 15,
    fontWeight: 750,
    height: 28,
    lineHeight: 1,
    placeItems: "center",
    width: 28,
  },
  copy: { minWidth: 0 },
  heading: { alignItems: "center", display: "flex", gap: 7, marginBottom: 3, minHeight: 22 },
  title: { fontSize: 12, fontWeight: 700, letterSpacing: "0.01em" },
  source: {
    background: "var(--bg-panel)",
    borderRadius: 999,
    color: "var(--text-dim)",
    fontSize: 10,
    fontWeight: 650,
    letterSpacing: "0.02em",
    padding: "1px 6px",
  },
  message: {
    color: "var(--text-muted)",
    maxHeight: 260,
    overflowWrap: "anywhere",
    overflowY: "auto",
    paddingRight: 4,
    userSelect: "text",
    whiteSpace: "pre-wrap",
  },
  actions: { alignItems: "center", display: "flex", gap: 2 },
  action: {
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-dim)",
    cursor: "pointer",
    display: "grid",
    height: 28,
    padding: 0,
    placeItems: "center",
    width: 28,
  },
})
