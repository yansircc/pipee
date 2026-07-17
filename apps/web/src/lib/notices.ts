export type NoticeType = "info" | "success" | "warning" | "error"
export type NoticeSource = "app" | "extension"

export type NoticeItem = {
  id: string
  message: string
  type: NoticeType
  source: NoticeSource
  exiting?: boolean
}

export type NoticeState = {
  visible: NoticeItem[]
  pending: NoticeItem[]
}

export type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "dismiss"; id: string }
  | { type: "remove"; id: string }

export const MAX_VISIBLE_NOTICES = 4
export const NOTICE_AUTO_DISMISS_MS = 6000

export function createNotice(input: {
  id: string
  message: string
  type: NoticeType
  source: NoticeSource
}): NoticeItem {
  return input
}

function markExiting(notices: NoticeItem[], id: string): NoticeItem[] {
  return notices.map((notice) => (notice.id === id && !notice.exiting ? { ...notice, exiting: true } : notice))
}

function oldestNotice(notices: NoticeItem[]): NoticeItem | undefined {
  return notices.find((notice) => !notice.exiting)
}

function fillVisibleNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  const openSlots = Math.max(0, MAX_VISIBLE_NOTICES - visible.length)
  if (openSlots === 0 || pending.length === 0) return { visible, pending }
  return {
    visible: [...visible, ...pending.slice(0, openSlots)],
    pending: pending.slice(openSlots),
  }
}

export function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (
        state.visible.some((notice) => notice.id === action.notice.id) ||
        state.pending.some((notice) => notice.id === action.notice.id)
      ) {
        return state
      }
      const { visible, pending } = state
      if (visible.some((notice) => notice.exiting)) {
        return { visible, pending: [...pending, action.notice] }
      }
      if (visible.length < MAX_VISIBLE_NOTICES) {
        return { visible: [...visible, action.notice], pending }
      }

      const evictable = visible[0]!
      return {
        visible: markExiting(visible, evictable.id),
        pending: [...pending, action.notice],
      }
    }
    case "dismiss":
      return { ...state, visible: markExiting(state.visible, action.id) }
    case "remove":
      return fillVisibleNotices(
        state.visible.filter((notice) => notice.id !== action.id),
        state.pending,
      )
    default:
      return state
  }
}

export function getNextAutoDismissNotice(state: NoticeState): NoticeItem | undefined {
  return oldestNotice(state.visible)
}
