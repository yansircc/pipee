import * as stylex from "@stylexjs/stylex"
import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react"
import { Effect } from "effect"
import type {
  BuiltinSlashCommandResult,
  CompactResultInfo,
  QueuedMessages,
  SlashCommandInfo,
} from "@/hooks/useAgentSession"
import { clearDraft, getDraft, setDraft, type ChatDraftAttachment, type ChatDraftImage } from "@/lib/draft-store"
import {
  buildAtMentionText,
  buildAtInsertText,
  extractAtQuery,
  filterFileEntries,
  type AtQueryMatch,
  type FileIndexEntry,
} from "@/lib/file-fuzzy"
import { FolderIcon, getFileIcon } from "./FileIcons"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import { parseBashCommand } from "@/lib/bash-command"
import { DEFAULT_TOOL_PRESET, type ToolPreset } from "@/lib/tool-presets"
import { withApi, runApi, runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { prepareDrop, prepareImages } from "@/features/chat/attachment-controller"
import type { SessionStats } from "@/api/contract"
import { Tooltip } from "@/ui/interaction/Tooltip"
const onNextAnimationFrame = (action: () => void) =>
  runBrowser(
    BrowserPlatform.pipe(
      Effect.flatMap((browser) => browser.nextAnimationFrame),
      Effect.andThen(Effect.sync(action)),
    ),
    {
      onSuccess: () => undefined,
    },
  )
export interface AttachedImage {
  data: string // base64, no prefix
  mimeType: string
  previewUrl: string // object URL for display
}
export type AttachedFile = ChatDraftAttachment
interface ModelOption {
  provider: string
  modelId: string
  name: string
}
interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void
  onBashCommand?: (message: string) => boolean
  onAbort: () => void
  onSteer?: (message: string, images?: AttachedImage[]) => void
  onFollowUp?: (message: string, images?: AttachedImage[]) => void
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void
  isStreaming: boolean
  sessionLoading?: boolean
  isBashRunning?: boolean
  model?: {
    provider: string
    modelId: string
  } | null
  isAutoModelSelection?: boolean
  modelNames?: Record<string, string>
  modelList?: {
    id: string
    name: string
    provider: string
  }[]
  onModelChange?: (provider: string, modelId: string) => void
  onOpenModels?: () => void
  onOpenSkills?: () => void
  skillsCount?: number
  sessionStats?: SessionStats | null
  contextUsage?: {
    percent: number | null
    contextWindow: number
    tokens: number | null
  } | null
  onCompact?: () => void
  onAbortCompaction?: () => void
  isCompacting?: boolean
  compactError?: string | null
  compactResult?: CompactResultInfo | null
  toolPreset?: ToolPreset
  onToolPresetChange?: (preset: ToolPreset) => void
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void
  availableThinkingLevels?: string[] | null
  thinkingLevelMap?: Record<string, string | null> | null
  retryInfo?: {
    attempt: number
    maxAttempts: number
    errorMessage?: string
  } | null
  queuedMessages?: QueuedMessages | null
  onRecallQueue?: () => void
  slashCommands?: SlashCommandInfo[]
  slashCommandsLoading?: boolean
  onLoadSlashCommands?: () => SlashCommandInfo[]
  onBuiltinCommand?: (message: string) => BuiltinSlashCommandResult
  soundEnabled?: boolean
  onSoundToggle?: () => void
  onAudioUnlock?: () => void
  draftKey?: string
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null
}
export interface ChatInputHandle {
  focus: () => void
  insertText: (text: string) => void
  insertIfEmpty: (text: string) => void
  prependText: (text: string) => void
  addImages: (files: File[]) => void
  addFiles: (files: File[], paths?: string[]) => void
}
const TOOL_PRESET_OPTIONS = [
  {
    preset: "none",
    label: "off",
    description: "Read-only; no built-in tools",
  },
  {
    preset: "core",
    label: "core",
    description: "read, bash, edit, write",
  },
  {
    preset: "full",
    label: "default",
    description: "Core plus grep, find, ls",
  },
] as const satisfies ReadonlyArray<{
  preset: ToolPreset
  label: string
  description: string
}>
const COMPOSITION_END_ENTER_GRACE_MS = 100
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})
function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return (
    MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId) ||
    MODEL_OPTION_COLLATOR.compare(a.provider, b.provider) ||
    MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId)
  )
}
const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
const THINKING_LEVEL_DESC: Record<(typeof THINKING_LEVELS)[number], string> = {
  auto: "Use pi default",
  off: "Reasoning off",
  minimal: "Minimal reasoning",
  low: "Low reasoning",
  medium: "Medium reasoning",
  high: "High reasoning",
  xhigh: "Extra-high reasoning",
  max: "Max reasoning",
}
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return tokens.toLocaleString()
}
function formatFileSize(bytes: number): string {
  if (bytes <= 0) return ""
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
type SlashCommandPaletteItem =
  | SlashCommandInfo
  | {
      name: string
      description: string
      source: "builtin"
    }
type SlashCommandSource = SlashCommandPaletteItem["source"]
const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  {
    name: "compact",
    description: "Compress context, optionally with instructions",
    source: "builtin",
  },
  {
    name: "reload",
    description: "Reload extensions, skills, prompts, and tools",
    source: "builtin",
  },
  {
    name: "name",
    description: "Set the session display name",
    source: "builtin",
  },
  {
    name: "session",
    description: "Show session message, token, and cost stats",
    source: "builtin",
  },
  {
    name: "copy",
    description: "Copy the last assistant message",
    source: "builtin",
  },
]
const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"]
const SLASH_SOURCE_GROUP_LABEL: Record<SlashCommandSource, string> = {
  builtin: "Built-in",
  extension: "Extensions",
  prompt: "Prompts",
  skill: "Skills",
}
const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
}
function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase()
  const description = command.description?.toLowerCase() ?? ""
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if (description.includes(query)) return 3
  return 4
}
function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return {
    data: image.data,
    mimeType: image.mimeType,
  }
}
function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  }
}
function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.revokeObjectUrl(image.previewUrl))), {
      onSuccess: () => undefined,
    })
  }
}
function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div title={text} {...stylex.props(inlineStyles.inline1)}>
      <span
        {...stylex.props(inlineStyles.inline2)}
        style={{
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span {...stylex.props(inlineStyles.inline3)}>{text}</span>
    </div>
  )
}
export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSend,
    onBashCommand,
    onAbort,
    onSteer,
    onFollowUp,
    isStreaming,
    sessionLoading = false,
    isBashRunning,
    model,
    isAutoModelSelection,
    modelNames,
    modelList,
    onModelChange,
    onOpenModels,
    onOpenSkills,
    skillsCount = 0,
    sessionStats,
    contextUsage,
    compactResult,
    toolPreset,
    onToolPresetChange,
    thinkingLevel,
    onThinkingLevelChange,
    availableThinkingLevels,
    thinkingLevelMap,
    retryInfo,
    queuedMessages,
    onRecallQueue,
    slashCommands,
    slashCommandsLoading,
    onLoadSlashCommands,
    onBuiltinCommand,
    onAudioUnlock,
    onPromptWithStreamingBehavior,
    draftKey,
    cwd,
  }: Props,
  ref,
) {
  const { locale, t } = useI18n()
  const isMobile = useIsMobile()
  const [value, setValue] = useState(() => (draftKey ? (getDraft(draftKey)?.value ?? "") : ""))
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set())
  const [modelDropdownRect, setModelDropdownRect] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false)
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false)
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false)
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() =>
    draftKey ? (getDraft(draftKey)?.images.map(draftImageToAttachedImage) ?? []) : [],
  )
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>(() =>
    draftKey ? [...(getDraft(draftKey)?.attachments ?? [])] : [],
  )
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [uploadingAttachments, setUploadingAttachments] = useState(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null)
  const [atMenuOpen, setAtMenuOpen] = useState(false)
  const [atActiveIndex, setAtActiveIndex] = useState(0)
  const [fileIndex, setFileIndex] = useState<{
    cwd: string
    entries: FileIndexEntry[]
    truncated: boolean
  } | null>(null)
  const [fileIndexLoading, setFileIndexLoading] = useState(false)
  const [atServerResult, setAtServerResult] = useState<{
    cwd: string
    query: string
    matches: FileIndexEntry[]
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null)
  const toolDropdownRef = useRef<HTMLDivElement>(null)
  const thinkingDropdownRef = useRef<HTMLDivElement>(null)
  const controlsMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const lastCompositionEndAtRef = useRef(0)
  const slashCommandsRequestedRef = useRef(false)
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const fileIndexMetaRef = useRef<{
    cwd: string
  } | null>(null)
  const fileIndexFetchingRef = useRef<string | null>(null)
  const draftKeyRef = useRef(draftKey)
  const valueRef = useRef(value)
  const attachedImagesRef = useRef(attachedImages)
  const attachedFilesRef = useRef(attachedFiles)
  valueRef.current = value
  attachedImagesRef.current = attachedImages
  attachedFilesRef.current = attachedFiles
  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus()
    },
    insertIfEmpty(text: string) {
      const ta = textareaRef.current
      const current = ta ? ta.value : value
      if (current.trim()) return
      setValue(text)
      setAtQuery(null)
      onNextAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
      })
    },
    prependText(text: string) {
      if (!text.trim()) return
      const ta = textareaRef.current
      const current = ta ? ta.value : value
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n")
      setValue(combined)
      setAtQuery(null)
      onNextAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(combined.length, combined.length)
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
      })
    },
    insertText(text: string) {
      const ta = textareaRef.current
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text)
        return
      }
      const start = ta.selectionStart ?? ta.value.length
      const end = ta.selectionEnd ?? ta.value.length
      const before = ta.value.slice(0, start)
      const after = ta.value.slice(end)
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : ""
      const newVal = before + sep + text + after
      setValue(newVal)
      setAtQuery(null)
      onNextAnimationFrame(() => {
        if (!ta) return
        const pos = start + sep.length + text.length
        ta.setSelectionRange(pos, pos)
        ta.focus()
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
      })
    },
    addImages(files: File[]) {
      processImageFiles(files)
    },
    addFiles(files: File[], paths: string[] = []) {
      processDroppedFiles(files, paths)
    },
  }))
  const processImageFiles = useCallback(
    (files: File[]) => {
      if (isStreaming) return
      const imageFiles = files.filter((f) => f.type.startsWith("image/"))
      if (!imageFiles.length) return
      runBrowser(prepareImages(imageFiles), {
        onSuccess: (newImages) => setAttachedImages((previous) => [...previous, ...newImages]),
        onFailure: (error) => setAttachmentError(error instanceof Error ? error.message : String(error)),
      })
    },
    [isStreaming],
  )
  const processDroppedFiles = useCallback(
    (files: File[], paths: string[]) => {
      if (isStreaming) return
      setAttachmentError(null)
      const uploadFiles = paths.length > 0 ? [] : files.filter((file) => !file.type.startsWith("image/"))
      if (uploadFiles.length > 0 && !cwd) {
        processImageFiles(files)
        setAttachmentError("Select a working directory before uploading files")
        return
      }
      setUploadingAttachments((count) => count + uploadFiles.length)
      runBrowser(prepareDrop(files, paths, cwd ?? ""), {
        onSuccess: (result) => {
          setUploadingAttachments((count) => Math.max(0, count - uploadFiles.length))
          setAttachedImages((previous) => [...previous, ...result.images])
          setAttachedFiles((previous) => {
            const known = new Set(previous.map((attachment) => attachment.path))
            return [...previous, ...result.attachments.filter((attachment) => !known.has(attachment.path))]
          })
        },
        onFailure: (error) => {
          setUploadingAttachments((count) => Math.max(0, count - uploadFiles.length))
          setAttachmentError(error instanceof Error ? error.message : String(error))
        },
      })
    },
    [cwd, isStreaming, processImageFiles],
  )
  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev]
      const [removed] = next.splice(index, 1)
      if (removed) revokeImagePreview(removed)
      return next
    })
  }, [])
  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview)
      return []
    })
  }, [])
  const removeFile = useCallback((path: string) => {
    setAttachedFiles((previous) => previous.filter((attachment) => attachment.path !== path))
  }, [])
  const clearFiles = useCallback(() => {
    setAttachedFiles([])
    setAttachmentError(null)
  }, [])
  const clearInput = useCallback(() => {
    setValue("")
    setAtQuery(null)
    if (draftKey)
      runBrowser(clearDraft(draftKey), {
        onSuccess: () => undefined,
      })
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) {
      runBrowser(clearDraft(draftKeyRef.current), {
        onSuccess: () => undefined,
      })
    }
    clearImages()
    clearFiles()
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [clearFiles, clearImages, draftKey])
  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return
    return runBrowser(
      Effect.sleep("150 millis").pipe(
        Effect.andThen(
          setDraft(draftKey, {
            value,
            images: attachedImages.map(imageToDraftImage),
            attachments: attachedFiles,
          }),
        ),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [attachedFiles, attachedImages, draftKey, value])
  useEffect(() => {
    const previousDraftKey = draftKeyRef.current
    if (previousDraftKey === draftKey) return
    if (previousDraftKey) {
      runBrowser(
        setDraft(previousDraftKey, {
          value: valueRef.current,
          images: attachedImagesRef.current.map(imageToDraftImage),
          attachments: attachedFilesRef.current,
        }),
        {
          onSuccess: () => undefined,
        },
      )
    }
    const draft = draftKey ? getDraft(draftKey) : null
    draftKeyRef.current = draftKey
    setValue(draft?.value ?? "")
    setAtQuery(null)
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview)
      return draft?.images.map(draftImageToAttachedImage) ?? []
    })
    setAttachedFiles([...(draft?.attachments ?? [])])
    setAttachmentError(null)
  }, [draftKey])
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = "auto"
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [value])
  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview)
    }
  }, [])
  const handleSend = useCallback(() => {
    const references = attachedFiles.map((attachment) => buildAtMentionText(attachment.path, false).trim())
    const msg = [value.trim(), ...references].filter(Boolean).join(" ")
    if (!msg && !attachedImages.length) return
    if (isStreaming) return
    if (uploadingAttachments > 0) return
    onAudioUnlock?.()
    if (!attachedImages.length && !attachedFiles.length && parseBashCommand(msg) && onBashCommand) {
      const handled = onBashCommand(msg)
      if (handled) clearInput()
      return
    }
    if (!attachedImages.length && !attachedFiles.length && msg.startsWith("/") && onBuiltinCommand) {
      const result = onBuiltinCommand(msg)
      if (result.handled) {
        if (!result.error) clearInput()
        return
      }
    }
    onSend(msg, attachedImages.length ? attachedImages : undefined)
    clearInput()
  }, [
    value,
    attachedFiles,
    attachedImages,
    uploadingAttachments,
    isStreaming,
    onBashCommand,
    onBuiltinCommand,
    onSend,
    clearInput,
    onAudioUnlock,
  ])
  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1)) ? value.slice(1).toLowerCase() : null
  const filteredSlashCommands = (() => {
    if (slashQuery === null) return []
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])]
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase()
        const description = command.description?.toLowerCase() ?? ""
        return name.includes(slashQuery) || description.includes(slashQuery)
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery)
        if (rankDelta !== 0) return rankDelta
        return (
          SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source] || MODEL_OPTION_COLLATOR.compare(a.name, b.name)
        )
      })
  })()
  const groupedSlashCommands = (() => {
    const groups = new Map<
      SlashCommandSource,
      {
        source: SlashCommandSource
        items: {
          command: SlashCommandPaletteItem
          index: number
        }[]
      }
    >()
    for (const source of SLASH_SOURCES) {
      groups.set(source, {
        source,
        items: [],
      })
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({
        command,
        index,
      })
    })
    return SLASH_SOURCES.map((source) => groups.get(source)!).filter((group) => group.items.length > 0)
  })()
  const slashCommandCountLabel =
    filteredSlashCommands.length === 1
      ? slashQuery
        ? "1 match"
        : "1 command"
      : `${filteredSlashCommands.length} ${slashQuery ? "matches" : "commands"}`
  const hasInputText = Boolean(value.trim())
  const hasAttachments = attachedImages.length > 0 || attachedFiles.length > 0
  const canQueueStreamingMessage = hasInputText && attachedImages.length === 0 && attachedFiles.length === 0

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback(
    (text: string, cursor: number | null) => {
      if (!cwd) {
        setAtQuery(null)
        return
      }
      const pos = cursor ?? text.length
      setAtQuery(extractAtQuery(text.slice(0, pos)))
    },
    [cwd],
  )
  const atQueryText = atQuery?.query ?? null
  const atLocalMatches: FileIndexEntry[] = React.useMemo(
    () =>
      atQueryText !== null && fileIndex && fileIndex.cwd === cwd
        ? filterFileEntries(fileIndex.entries, atQueryText)
        : [],
    [atQueryText, fileIndex, cwd],
  )

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd)
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return
    const fetchCwd = cwd
    const query = atQueryText
    return runApi(
      Effect.sleep("150 millis").pipe(
        Effect.andThen(
          withApi((api) =>
            api.workspace.fileIndex({
              query: {
                root: fetchCwd,
                query,
                deep: "1",
              },
            }),
          ),
        ),
      ),
      {
        onSuccess: ({ entries }) =>
          setAtServerResult({
            cwd: fetchCwd,
            query,
            matches: entries.map((entry) => ({
              path: entry.path,
              isDir: entry.kind === "directory",
            })),
          }),
      },
    )
  }, [needsServerSearch, atQueryText, cwd])
  const serverResultInUse =
    needsServerSearch && atServerResult !== null && atServerResult.cwd === cwd && atServerResult.query === atQueryText
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false)
      setAtActiveIndex(0)
      return
    }
    setAtMenuOpen(true)
    setAtActiveIndex(0)
  }, [atTokenKey])

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null
  useEffect(() => {
    if (!atTokenActive || !cwd) return
    const meta = fileIndexMetaRef.current
    if (meta?.cwd === cwd) return
    if (fileIndexFetchingRef.current === cwd) return
    fileIndexFetchingRef.current = cwd
    const fetchCwd = cwd
    setFileIndexLoading(true)
    const cancel = runApi(
      withApi((api) =>
        api.workspace.fileIndex({
          query: {
            root: fetchCwd,
            deep: "1",
          },
        }),
      ),
      {
        onSuccess: ({ entries, truncated }) => {
          setFileIndex({
            cwd: fetchCwd,
            entries: entries
              .map((entry) => ({
                path: entry.path,
                isDir: entry.kind === "directory",
              }))
              .sort((left, right) => left.path.localeCompare(right.path)),
            truncated,
          })
          fileIndexMetaRef.current = {
            cwd: fetchCwd,
          }
          fileIndexFetchingRef.current = null
          setFileIndexLoading(false)
        },
        onFailure: () => {
          fileIndexMetaRef.current = null
          fileIndexFetchingRef.current = null
          setFileIndexLoading(false)
        },
      },
    )
    return () => {
      cancel()
      if (fileIndexFetchingRef.current === fetchCwd) fileIndexFetchingRef.current = null
    }
  }, [atTokenActive, cwd])
  const applyAtCompletion = useCallback(
    (entry: FileIndexEntry) => {
      if (!atQuery) return
      const ta = textareaRef.current
      const cursor = ta?.selectionStart ?? value.length
      const before = value.slice(0, atQuery.start)
      let after = value.slice(cursor)
      // Completing inside a quoted token (@"my dir/… with the caret before the
      // closing quote): the replacement carries its own closing quote, so drop
      // the old one right after the caret (mirrors the TUI's applyCompletion).
      if (atQuery.quoted && after.startsWith('"')) {
        after = after.slice(1)
      }
      const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted)
      const newValue = before + insert.text + after
      const newPos = before.length + insert.cursorOffset
      setValue(newValue)
      // setValue alone does not fire onChange — re-derive the token here. Files
      // end with a space (token closes, menu hides); directories end with "/"
      // before the caret (token stays open for drill-down into the directory).
      setAtQuery(extractAtQuery(newValue.slice(0, newPos)))
      onNextAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(newPos, newPos)
        el.style.height = "auto"
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      })
    },
    [atQuery, value],
  )
  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1))
    }
  }, [atMatches.length, atActiveIndex])
  useEffect(() => {
    atItemRefs.current.length = atMatches.length
  }, [atMatches.length])
  useEffect(() => {
    if (!atMenuOpen) return
    atItemRefs.current[atActiveIndex]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [atActiveIndex, atMenuOpen])
  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `
    setValue(nextValue)
    setSlashMenuOpen(false)
    setSlashActiveIndex(0)
    onNextAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(nextValue.length, nextValue.length)
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    })
  }, [])
  const sendQueued = useCallback(
    (mode: "steer" | "followup") => {
      const msg = value.trim()
      if (!msg && !attachedImages.length && !attachedFiles.length) return
      if (attachedImages.length || attachedFiles.length) return
      onAudioUnlock?.()
      if (parseBashCommand(msg) && onBashCommand) {
        const handled = onBashCommand(msg)
        if (handled) clearInput()
        return
      }
      const streamingBehavior = mode === "steer" ? "steer" : "followUp"
      if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
        onPromptWithStreamingBehavior(msg, streamingBehavior, attachedImages.length ? attachedImages : undefined)
        clearInput()
        return
      }
      if (mode === "steer" && onSteer) {
        onSteer(msg, attachedImages.length ? attachedImages : undefined)
      } else if (mode === "followup" && onFollowUp) {
        onFollowUp(msg, attachedImages.length ? attachedImages : undefined)
      }
      clearInput()
    },
    [
      value,
      attachedFiles,
      attachedImages,
      onBashCommand,
      onPromptWithStreamingBehavior,
      onSteer,
      onFollowUp,
      clearInput,
      onAudioUnlock,
    ],
  )
  const getNextSlashIndex = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const lastIndex = filteredSlashCommands.length - 1
      if (lastIndex < 0) return 0
      if (direction === "left") return Math.max(0, slashActiveIndex - 1)
      if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1)
      const currentNode = slashItemRefs.current[slashActiveIndex]
      if (!currentNode) {
        return direction === "down" ? Math.min(lastIndex, slashActiveIndex + 1) : Math.max(0, slashActiveIndex - 1)
      }
      const currentRect = currentNode.getBoundingClientRect()
      const currentX = currentRect.left + currentRect.width / 2
      const currentY = currentRect.top + currentRect.height / 2
      let bestIndex = -1
      let bestScore = Number.POSITIVE_INFINITY
      for (let index = 0; index <= lastIndex; index += 1) {
        if (index === slashActiveIndex) continue
        const node = slashItemRefs.current[index]
        if (!node) continue
        const rect = node.getBoundingClientRect()
        const candidateY = rect.top + rect.height / 2
        const verticalDelta = candidateY - currentY
        if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue
        const candidateX = rect.left + rect.width / 2
        const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX)
        if (score < bestScore) {
          bestIndex = index
          bestScore = score
        }
      }
      if (bestIndex >= 0) return bestIndex
      return direction === "down" ? Math.min(lastIndex, slashActiveIndex + 1) : Math.max(0, slashActiveIndex - 1)
    },
    [filteredSlashCommands.length, slashActiveIndex],
  )
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent
      const recentlyComposed = e.timeStamp - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS
      const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229
      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault()
        return
      }
      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setSlashActiveIndex(getNextSlashIndex("down"))
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setSlashActiveIndex(getNextSlashIndex("up"))
          return
        }
        if (e.key === "ArrowRight") {
          e.preventDefault()
          setSlashActiveIndex(getNextSlashIndex("right"))
          return
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault()
          setSlashActiveIndex(getNextSlashIndex("left"))
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          setSlashMenuOpen(false)
          return
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault()
          applySlashCommand(filteredSlashCommands[slashActiveIndex])
          return
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1))
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setAtActiveIndex((i) => Math.max(0, i - 1))
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          setAtMenuOpen(false)
          return
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault()
          applyAtCompletion(atMatches[atActiveIndex])
          return
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup")
        } else {
          handleSend()
        }
      }
    },
    [
      isStreaming,
      onSteer,
      onFollowUp,
      slashMenuOpen,
      slashQuery,
      filteredSlashCommands,
      slashActiveIndex,
      applySlashCommand,
      sendQueued,
      handleSend,
      getNextSlashIndex,
      atMenuOpen,
      atQuery,
      atMatches,
      atActiveIndex,
      applyAtCompletion,
    ],
  )
  const handleInput = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [])
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItems = items.filter((item) => item.type.startsWith("image/"))
      if (!imageItems.length) return
      e.preventDefault()
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null)
      processImageFiles(files)
    },
    [processImageFiles],
  )
  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false)
      setSlashActiveIndex(0)
      slashCommandsRequestedRef.current = false
      return
    }
    setSlashMenuOpen(true)
    setSlashActiveIndex(0)
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true
      onLoadSlashCommands()
    }
  }, [slashQuery, onLoadSlashCommands])
  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1))
    }
  }, [filteredSlashCommands.length, slashActiveIndex])
  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length
  }, [filteredSlashCommands.length])
  useEffect(() => {
    if (!slashMenuOpen) return
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [slashActiveIndex, slashMenuOpen])

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList
        .map((m) => ({
          provider: m.provider,
          modelId: m.id,
          name: m.name,
        }))
        .sort(compareModelOptions)
    }
    return Object.entries(modelNames ?? {})
      .map(([modelId, name]) => ({
        provider: model?.provider ?? "unknown",
        modelId,
        name,
      }))
      .sort(compareModelOptions)
  })()

  // Group options by provider, preserving insertion order
  const modelsByProvider: {
    provider: string
    options: ModelOption[]
  }[] = []
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider)
    if (group) group.options.push(opt)
    else
      modelsByProvider.push({
        provider: opt.provider,
        options: [opt],
      })
  }
  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null
  const currentName = displayModelName
  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0
  const compactVerb =
    compactResult?.reason && compactResult.reason !== "manual"
      ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} compacted`
      : "Compacted"
  const compactResultText = compactResult
    ? `${compactVerb} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${formatTokenCount(compactSavedTokens)} saved)`
    : null
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto"
    if (lvl === "auto" || !thinkingLevelMap) return lvl
    return thinkingLevelMap[lvl] ?? lvl
  })()
  const toolPresetOption = TOOL_PRESET_OPTIONS.find(({ preset }) => preset === (toolPreset ?? DEFAULT_TOOL_PRESET))!
  const queuedMessageCount = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current &&
        !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false)
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false)
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false)
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false)
      }
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.onDocumentMouseDown(handler))), {
      onSuccess: () => undefined,
    })
  }, [])
  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false)
  }, [isMobile])
  const insertPromptToken = useCallback(
    (token: "/" | "@") => {
      const current = valueRef.current
      const next = `${current}${current && !current.endsWith(" ") ? " " : ""}${token}`
      valueRef.current = next
      setValue(next)
      onNextAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(next.length, next.length)
        updateAtQuery(next, next.length)
      })
    },
    [updateAtQuery],
  )
  return (
    <div
      {...stylex.props(inlineStyles.inline4)}
      style={{
        paddingRight: isMobile ? 10 : 16,
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        disabled={isStreaming}
        {...stylex.props(inlineStyles.inline5)}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          processDroppedFiles(files, [])
          e.target.value = ""
        }}
      />
      <div className={`${stylex.props(inlineStyles.inline6).className} chat-input-shell`}>
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {queuedMessageCount > 0 && (
          <div {...stylex.props(inlineStyles.inline7)}>
            <div {...stylex.props(inlineStyles.inline8)}>
              <span {...stylex.props(inlineStyles.inline9)}>
                {t("Queued")} · {queuedMessageCount}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  title={t("Remove all queued messages and put them back into the input box for editing")}
                  {...stylex.props(inlineStyles.inline10)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)"
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent"
                    e.currentTarget.style.borderColor = "var(--border)"
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                  Recall to input
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div {...stylex.props(inlineStyles.inline11)}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(inlineStyles.inline12)}
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})…
            {retryInfo.errorMessage && <span {...stylex.props(inlineStyles.inline13)}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div {...stylex.props(inlineStyles.inline14)}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(inlineStyles.inline15)}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {(attachedFiles.length > 0 || uploadingAttachments > 0 || attachmentError) && (
          <div {...stylex.props(inlineStyles.inline16)}>
            {attachedFiles.map((attachment) => (
              <div key={attachment.path} title={attachment.path} {...stylex.props(inlineStyles.inline17)}>
                <span {...stylex.props(inlineStyles.inline18)}>{getFileIcon(attachment.name, 15)}</span>
                <span {...stylex.props(inlineStyles.inline19)}>{attachment.name}</span>
                {attachment.size > 0 && (
                  <span {...stylex.props(inlineStyles.inline20)}>{formatFileSize(attachment.size)}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(attachment.path)}
                  title={t("Remove")}
                  {...stylex.props(inlineStyles.inline21)}
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <line x1="1" y1="1" x2="7" y2="7" />
                    <line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
            {uploadingAttachments > 0 && (
              <span {...stylex.props(inlineStyles.inline22)}>{t("Uploading attachments…")}</span>
            )}
            {attachmentError && <span {...stylex.props(inlineStyles.inline23)}>{attachmentError}</span>}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div {...stylex.props(inlineStyles.inline24)}>
            {attachedImages.map((img, i) => (
              <div key={i} {...stylex.props(inlineStyles.inline25)}>
                {" "}
                <img src={img.previewUrl} alt="" {...stylex.props(inlineStyles.inline26)} />
                <button onClick={() => removeImage(i)} {...stylex.props(inlineStyles.inline27)}>
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <line x1="1" y1="1" x2="7" y2="7" />
                    <line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div
          {...stylex.props(inlineStyles.inline28)}
          style={{ borderRadius: queuedMessageCount > 0 ? 0 : "12px 12px 0 0" }}
        >
          {slashMenuOpen && slashQuery !== null && (
            <div {...stylex.props(inlineStyles.inline29)}>
              <div {...stylex.props(inlineStyles.inline30)}>
                <span>
                  {slashCommandsLoading
                    ? t("Loading commands...")
                    : `${t("Slash commands")} · ${slashCommandCountLabel}`}
                </span>
                <span {...stylex.props(inlineStyles.inline31)}>Tab / Enter</span>
              </div>
              <div {...stylex.props(inlineStyles.inline32)}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div {...stylex.props(inlineStyles.inline33)}>No extension, prompt, or skill commands found</div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} {...stylex.props(inlineStyles.inline34)}>
                      <div {...stylex.props(inlineStyles.inline35)}>
                        <span>{t(SLASH_SOURCE_GROUP_LABEL[group.source])}</span>
                        <span {...stylex.props(inlineStyles.inline36)}>{group.items.length}</span>
                      </div>
                      <div {...stylex.props(inlineStyles.inline37)}>
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                applySlashCommand(command)
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              {...stylex.props(inlineStyles.inline38)}
                              style={{
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                boxShadow: active
                                  ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)"
                                  : "none",
                              }}
                            >
                              <span {...stylex.props(inlineStyles.inline39)}>/{command.name}</span>
                              {command.description && (
                                <span {...stylex.props(inlineStyles.inline40)}>{t(command.description)}</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen &&
            atQuery !== null &&
            (() => {
              const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd)
              const matchCountLabel = atMatches.length === 1 ? "1 match" : `${atMatches.length} matches`
              // With a truncated index, local results are provisional — the
              // debounced server search over the full listing replaces them.
              const truncatedHint =
                fileIndex?.truncated && !serverResultInUse
                  ? atQuery.query
                    ? " · searching all files…"
                    : " · index truncated"
                  : ""
              return (
                <div {...stylex.props(inlineStyles.inline41)}>
                  <div {...stylex.props(inlineStyles.inline42)}>
                    <span>
                      {indexLoading ? t("Loading files...") : `${t("Files")} · ${matchCountLabel}${truncatedHint}`}
                    </span>
                    <span {...stylex.props(inlineStyles.inline43)}>Tab / Enter</span>
                  </div>
                  <div {...stylex.props(inlineStyles.inline44)}>
                    {!indexLoading && atMatches.length === 0 ? (
                      <div {...stylex.props(inlineStyles.inline45)}>
                        {needsServerSearch && !serverResultInUse ? t("Searching…") : t("No matching files")}
                      </div>
                    ) : (
                      atMatches.map((entry, index) => {
                        const active = index === atActiveIndex
                        const name = entry.path.split("/").pop() ?? entry.path
                        const dirPrefix = entry.path.slice(0, entry.path.length - name.length)
                        return (
                          <button
                            key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                            ref={(node) => {
                              atItemRefs.current[index] = node
                            }}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              applyAtCompletion(entry)
                            }}
                            onMouseEnter={() => setAtActiveIndex(index)}
                            {...stylex.props(inlineStyles.inline46)}
                            style={{
                              background: active ? "var(--bg-selected)" : "none",
                            }}
                          >
                            <span {...stylex.props(inlineStyles.inline47)}>
                              {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                            </span>
                            <span {...stylex.props(inlineStyles.inline48)}>
                              {dirPrefix && <span {...stylex.props(inlineStyles.inline49)}>{dirPrefix}</span>}
                              {name}
                              {entry.isDir && <span {...stylex.props(inlineStyles.inline50)}>/</span>}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )
            })()}
          <div
            style={
              {
                display: "flex",
                gap: 8,
                alignItems: "flex-end",
                background: "transparent",
                border: "none",
                padding: "7px 7px 0",
              } as React.CSSProperties
            }
          >
            <textarea
              ref={textareaRef}
              value={value}
              disabled={sessionLoading}
              onChange={(e) => {
                setValue(e.target.value)
                updateAtQuery(e.target.value, e.target.selectionStart)
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                updateAtQuery(el.value, el.selectionStart)
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false
                lastCompositionEndAtRef.current = e.timeStamp
                const el = e.currentTarget
                updateAtQuery(el.value, el.selectionStart)
              }}
              onInput={handleInput}
              onPaste={handlePaste}
              placeholder={
                isBashRunning
                  ? t("Shell command is running…")
                  : isStreaming && (onSteer || onFollowUp)
                    ? t("Steer now / queue follow-up...")
                    : isStreaming
                      ? t("Agent is running…")
                      : t("Message… Type / for commands, @ for files")
              }
              rows={1}
              {...stylex.props(inlineStyles.inline51)}
            />

            {isStreaming ? (
              <div {...stylex.props(inlineStyles.inline52)}>
                {onSteer && (
                  <button
                    onClick={() => sendQueued("steer")}
                    disabled={!canQueueStreamingMessage}
                    title={
                      hasAttachments
                        ? t("Attachments cannot be queued while the agent is running")
                        : t("Interrupt the current run and inject this message now")
                    }
                    {...stylex.props(inlineStyles.inline53)}
                    style={{
                      background: canQueueStreamingMessage ? "rgba(234,179,8,0.12)" : "none",
                      color: canQueueStreamingMessage ? "rgba(180,130,0,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 1 L9 5 L5 9" />
                      <line x1="1" y1="5" x2="9" y2="5" />
                    </svg>
                    {t("Steer")}
                  </button>
                )}
                {onFollowUp && (
                  <button
                    onClick={() => sendQueued("followup")}
                    disabled={!canQueueStreamingMessage}
                    title={
                      hasAttachments
                        ? t("Attachments cannot be queued while the agent is running")
                        : t("Queue this message after the agent finishes")
                    }
                    {...stylex.props(inlineStyles.inline54)}
                    style={{
                      background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                      color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="5" y1="1" x2="5" y2="6" />
                      <polyline points="2.5 3.5 5 1 7.5 3.5" />
                      <line x1="2" y1="9" x2="8" y2="9" />
                    </svg>
                    {t("Follow-up")}
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={sessionLoading || (!value.trim() && !hasAttachments) || uploadingAttachments > 0}
                aria-label={sessionLoading ? t("Loading...") : t("Send")}
                {...stylex.props(inlineStyles.inline55)}
                style={{
                  background: "var(--text)",
                  color: "var(--bg-panel)",
                  cursor:
                    !sessionLoading && (value.trim() || hasAttachments) && uploadingAttachments === 0
                      ? "pointer"
                      : "not-allowed",
                  opacity: !sessionLoading && (value.trim() || hasAttachments) && uploadingAttachments === 0 ? 1 : 0.25,
                }}
              >
                <svg
                  width="13"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {sessionLoading ? (
                    <circle cx="12" cy="12" r="7" strokeDasharray="28 16">
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from="0 12 12"
                        to="360 12 12"
                        dur="0.8s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  ) : (
                    <>
                      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
                      <path d="M7 12h14" />
                    </>
                  )}
                </svg>
              </button>
            )}
          </div>
        </div>
        {/* Bottom bar: left | center (context) | right */}
        <div
          {...stylex.props(inlineStyles.inline56)}
          style={{
            display: isMobile ? "grid" : "flex",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
          }}
        >
          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div
            {...stylex.props(inlineStyles.inline57)}
            style={{
              flex: isMobile ? "1 1 auto" : "0 0 auto",
            }}
          >
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              title={t("Attach file")}
              aria-label={t("Attach file")}
              {...stylex.props(inlineStyles.inline58)}
              style={{
                color: hasAttachments ? "var(--accent)" : "var(--text-muted)",
                cursor: isStreaming ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (isStreaming) return
                e.currentTarget.style.background = "var(--bg-hover)"
                e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none"
                e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text-muted)"
              }}
            >
              <svg
                width="14"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8" />
              </svg>
            </button>
            <button type="button" onClick={() => insertPromptToken("/")} {...stylex.props(inlineStyles.promptToken)}>
              / {locale === "zh-CN" ? "命令" : "Commands"}
            </button>
            <button type="button" onClick={() => insertPromptToken("@")} {...stylex.props(inlineStyles.promptToken)}>
              @ {t("Files")}
            </button>
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentName && onModelChange && (
              <div
                ref={dropdownRef}
                {...stylex.props(inlineStyles.inline59)}
                style={{
                  flex: isMobile ? "1 1 auto" : undefined,
                }}
              >
                <button
                  onClick={(event) => {
                    const element = event.currentTarget
                    runBrowser(
                      BrowserPlatform.pipe(
                        Effect.flatMap((browser) =>
                          Effect.all({
                            rect: browser.measure(element),
                            viewportHeight: browser.viewportHeight,
                          }),
                        ),
                      ),
                      {
                        onSuccess: (measurement) => {
                          setModelDropdownRect(measurement.rect)
                          setViewportHeight(measurement.viewportHeight)
                          setModelDropdownOpen((value) => !value)
                        },
                      },
                    )
                  }}
                  disabled={isStreaming}
                  aria-label={t("Models")}
                  {...stylex.props(inlineStyles.inline60)}
                  style={{
                    justifyContent: isMobile ? "flex-start" : undefined,
                    padding: isMobile ? "8px 10px" : "0 7px",
                    width: isMobile ? "100%" : undefined,
                    maxWidth: isMobile ? "100%" : 220,
                    background: modelDropdownOpen ? "var(--bg-selected)" : "transparent",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    opacity: isStreaming ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return
                    e.currentTarget.style.background = "var(--bg-hover)"
                    e.currentTarget.style.color = "var(--text)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-selected)" : "transparent"
                    e.currentTarget.style.color = "var(--text-muted)"
                  }}
                >
                  <span {...stylex.props(inlineStyles.modelStatusDot)} />
                  <span {...stylex.props(inlineStyles.inline61)}>{currentName}</span>
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    style={{ transform: "rotate(90deg)" }}
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
                {modelDropdownOpen &&
                  modelDropdownRect &&
                  viewportHeight > 0 &&
                  (() => {
                    const bottom = viewportHeight - modelDropdownRect.top + 6
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6))
                    // On mobile, pin to a small left margin and cap width to the
                    // viewport so long model names never push the panel off-screen.
                    const panelPos: React.CSSProperties = isMobile
                      ? {
                          left: 8,
                          right: 8,
                          maxWidth: "calc(100vw - 16px)",
                        }
                      : {
                          left: modelDropdownRect.left,
                          width: "max-content",
                          minWidth: modelDropdownRect.width,
                        }
                    return (
                      <div
                        ref={modelDropdownPanelRef}
                        style={{
                          position: "fixed",
                          bottom,
                          ...panelPos,
                          zIndex: 500,
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                          overflow: "hidden",
                          maxHeight: maxH,
                          overflowY: "auto",
                        }}
                      >
                        {modelsByProvider.map((group, gi) => (
                          <div key={group.provider}>
                            {modelsByProvider.length > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setCollapsedProviders((current) => {
                                    const next = new Set(current)
                                    if (next.has(group.provider)) next.delete(group.provider)
                                    else next.add(group.provider)
                                    return next
                                  })
                                }
                                {...stylex.props(inlineStyles.inline62)}
                                style={{
                                  borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                                }}
                              >
                                <span>{collapsedProviders.has(group.provider) ? "›" : "⌄"}</span>
                                {group.provider}
                                <span style={{ marginLeft: "auto" }}>{group.options.length}</span>
                              </button>
                            )}
                            {!collapsedProviders.has(group.provider) &&
                              group.options.map((opt) => {
                                const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider
                                return (
                                  <button
                                    key={`${opt.provider}:${opt.modelId}`}
                                    onClick={() => {
                                      setModelDropdownOpen(false)
                                      if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId)
                                    }}
                                    {...stylex.props(inlineStyles.inline63)}
                                    style={{
                                      background: isActive ? "var(--bg-selected)" : "none",
                                      color: isActive ? "var(--text)" : "var(--text-muted)",
                                      fontWeight: isActive ? 600 : 400,
                                    }}
                                    onMouseEnter={(e) => {
                                      if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"
                                    }}
                                    onMouseLeave={(e) => {
                                      if (!isActive) e.currentTarget.style.background = "none"
                                    }}
                                  >
                                    {isActive ? (
                                      <svg
                                        width="10"
                                        height="10"
                                        viewBox="0 0 10 10"
                                        fill="none"
                                        stroke="var(--accent)"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        {...stylex.props(inlineStyles.inline64)}
                                      >
                                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                                      </svg>
                                    ) : (
                                      <span {...stylex.props(inlineStyles.inline65)} />
                                    )}
                                    {opt.name}
                                  </button>
                                )
                              })}
                          </div>
                        ))}
                        {onOpenModels && (
                          <button
                            type="button"
                            onClick={() => {
                              setModelDropdownOpen(false)
                              onOpenModels()
                            }}
                            {...stylex.props(inlineStyles.manageModels)}
                          >
                            <span>＋</span>
                            {t("Manage models")}
                          </button>
                        )}
                      </div>
                    )
                  })()}
              </div>
            )}
            {(modelOptions.length === 0 || !currentName || !onModelChange) && onOpenModels && (
              <button
                type="button"
                onClick={onOpenModels}
                aria-label={t("Models")}
                {...stylex.props(inlineStyles.emptyModelButton)}
              >
                ＋ {t("Add model")}
              </button>
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div {...stylex.props(inlineStyles.inline66)} />}

          {/* RIGHT: thinking + tools preset + compact + sound (idle) | Stop + sound (streaming) */}
          <div
            ref={controlsMenuRef}
            {...stylex.props(inlineStyles.inline67)}
            style={{
              marginLeft: isMobile ? 0 : "auto",
            }}
          >
            {isMobile && (
              <button
                type="button"
                title={controlsMenuOpen ? undefined : t("More controls")}
                aria-label={t("More controls")}
                aria-expanded={controlsMenuOpen}
                aria-hidden={controlsMenuOpen || undefined}
                tabIndex={controlsMenuOpen ? -1 : undefined}
                onClick={() => {
                  setModelDropdownOpen(false)
                  setControlsMenuOpen(true)
                }}
                {...stylex.props(inlineStyles.inline68)}
                style={{
                  cursor: controlsMenuOpen ? "default" : "pointer",
                  visibility: controlsMenuOpen ? "hidden" : "visible",
                  pointerEvents: controlsMenuOpen ? "none" : "auto",
                }}
                onMouseEnter={(e) => {
                  if (controlsMenuOpen) return
                  e.currentTarget.style.background = "var(--bg-hover)"
                  e.currentTarget.style.color = "var(--text)"
                }}
                onMouseLeave={(e) => {
                  if (controlsMenuOpen) return
                  e.currentTarget.style.background = "none"
                  e.currentTarget.style.color = "var(--text-muted)"
                }}
              >
                {t("More")}
              </button>
            )}
            <div
              style={{
                display: isMobile ? (controlsMenuOpen ? "flex" : "none") : "flex",
                alignItems: "center",
                gap: isMobile ? 1 : 10,
                width: isMobile ? "max-content" : "100%",
                height: isMobile ? "auto" : 30,
                paddingTop: isMobile ? 0 : 6,
                ...(isMobile
                  ? {
                      position: "absolute",
                      right: 0,
                      bottom: 0,
                      zIndex: 60,
                      padding: 1,
                      width: "max-content",
                      maxWidth: "calc(100vw - 32px)",
                      flexWrap: "nowrap",
                      justifyContent: "flex-end",
                      border: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                      borderRadius: 10,
                      background: "color-mix(in srgb, var(--bg-panel) 92%, var(--bg))",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                      backdropFilter: "blur(10px)",
                    }
                  : null),
              }}
            >
              {!isStreaming && onThinkingLevelChange && (
                <div ref={thinkingDropdownRef} {...stylex.props(inlineStyles.inline69)}>
                  <button
                    onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                    disabled={isStreaming}
                    title={`${t("Change reasoning level")}: ${t(thinkingDisplayLabel)}`}
                    aria-label={t("Change reasoning level")}
                    {...stylex.props(inlineStyles.inline70)}
                    style={{
                      padding: isMobile ? "0 6px" : 0,
                      width: isMobile ? "auto" : undefined,
                      background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      opacity: isStreaming ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return
                      e.currentTarget.style.background = "var(--bg-hover)"
                      e.currentTarget.style.color = "var(--text)"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none"
                      e.currentTarget.style.color = "var(--text-muted)"
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ display: isMobile ? "block" : "none" }}
                    >
                      <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                      <line x1="7" y1="18" x2="12" y2="18" />
                      <line x1="8" y1="21" x2="11" y2="21" />
                    </svg>
                    {(!isMobile || controlsMenuOpen) && (
                      <span {...stylex.props(inlineStyles.inline71)}>
                        {!isMobile && `${locale === "zh-CN" ? "推理" : "Reasoning"} · `}
                        {t(thinkingDisplayLabel)}
                      </span>
                    )}
                  </button>
                  {thinkingDropdownOpen && (
                    <div {...stylex.props(inlineStyles.inline72)}>
                      {THINKING_LEVELS.filter((lvl) => {
                        if (!availableThinkingLevels) return true
                        if (lvl === "auto") return true
                        return availableThinkingLevels.includes(lvl)
                      }).map((lvl) => {
                        const isActive = (thinkingLevel ?? "auto") === lvl
                        const desc = t(THINKING_LEVEL_DESC[lvl])
                        const mappedVal = lvl !== "auto" && thinkingLevelMap ? thinkingLevelMap[lvl] : undefined
                        const displayLabel = mappedVal != null && mappedVal !== lvl ? mappedVal : lvl
                        const showOriginal = mappedVal != null && mappedVal !== lvl
                        return (
                          <button
                            key={lvl}
                            onClick={() => {
                              setThinkingDropdownOpen(false)
                              if (!isActive) onThinkingLevelChange(lvl)
                            }}
                            {...stylex.props(inlineStyles.inline73)}
                            style={{
                              background: isActive ? "var(--bg-selected)" : "none",
                              color: isActive ? "var(--text)" : "var(--text-muted)",
                              fontWeight: isActive ? 600 : 400,
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "none"
                            }}
                          >
                            {isActive ? (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                {...stylex.props(inlineStyles.inline74)}
                              >
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span {...stylex.props(inlineStyles.inline75)} />
                            )}
                            <span {...stylex.props(inlineStyles.inline76)}>
                              {displayLabel}
                              {showOriginal && <span {...stylex.props(inlineStyles.inline77)}>({lvl})</span>}
                            </span>
                            <span {...stylex.props(inlineStyles.inline78)}>{desc}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {!isStreaming && onToolPresetChange && (
                <div ref={toolDropdownRef} {...stylex.props(inlineStyles.inline79)}>
                  <button
                    onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                    disabled={isStreaming}
                    title={`${t("Change tool preset")}: ${t(toolPresetOption.label)}`}
                    aria-label={t("Change tool preset")}
                    {...stylex.props(inlineStyles.inline80)}
                    style={{
                      padding: isMobile ? "0 6px" : 0,
                      width: isMobile ? "auto" : undefined,
                      background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      opacity: isStreaming ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return
                      e.currentTarget.style.background = "var(--bg-hover)"
                      e.currentTarget.style.color = "var(--text)"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none"
                      e.currentTarget.style.color = "var(--text-muted)"
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                    {(!isMobile || controlsMenuOpen) && (
                      <span {...stylex.props(inlineStyles.inline81)}>{t(toolPresetOption.label)}</span>
                    )}
                  </button>
                  {toolDropdownOpen && (
                    <div {...stylex.props(inlineStyles.inline82)}>
                      {TOOL_PRESET_OPTIONS.map((option) => {
                        const { preset } = option
                        const isActive = (toolPreset ?? DEFAULT_TOOL_PRESET) === preset
                        return (
                          <button
                            key={preset}
                            onClick={() => {
                              setToolDropdownOpen(false)
                              if (!isActive) onToolPresetChange(preset)
                            }}
                            {...stylex.props(inlineStyles.inline83)}
                            style={{
                              background: isActive ? "var(--bg-selected)" : "none",
                              color: isActive ? "var(--text)" : "var(--text-muted)",
                              fontWeight: isActive ? 600 : 400,
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "none"
                            }}
                          >
                            {isActive ? (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                {...stylex.props(inlineStyles.inline84)}
                              >
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span {...stylex.props(inlineStyles.inline85)} />
                            )}
                            <span {...stylex.props(inlineStyles.inline86)}>{t(option.label)}</span>
                            <span {...stylex.props(inlineStyles.inline87)}>{t(option.description)}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {!isStreaming && onOpenSkills && (
                <button
                  type="button"
                  onClick={onOpenSkills}
                  title={t("Skills")}
                  aria-label={t("Skills")}
                  {...stylex.props(inlineStyles.metricButton)}
                >
                  <span>
                    {t("Skills")} · {skillsCount}
                  </span>
                </button>
              )}

              <span {...stylex.props(inlineStyles.metaSpacer)} />

              {sessionStats && (
                <Tooltip
                  content={
                    <span {...stylex.props(inlineStyles.metricTooltip)}>
                      <span>{t("Input")}</span>
                      <b>{sessionStats.tokens.input.toLocaleString()}</b>
                      <span>{t("Output")}</span>
                      <b>{sessionStats.tokens.output.toLocaleString()}</b>
                      <span>{t("Cache Read")}</span>
                      <b>{sessionStats.tokens.cacheRead.toLocaleString()}</b>
                      <span>{t("Total")}</span>
                      <b>{sessionStats.tokens.total.toLocaleString()}</b>
                      <span>Cost</span>
                      <b>${sessionStats.cost.toFixed(4)}</b>
                    </span>
                  }
                >
                  <button type="button" aria-label={t("Session total")} {...stylex.props(inlineStyles.metricButton)}>
                    <strong {...stylex.props(inlineStyles.metricCost)}>${sessionStats.cost.toFixed(4)}</strong>
                    <small {...stylex.props(inlineStyles.metricLabel)}>Cost</small>
                  </button>
                </Tooltip>
              )}

              {contextUsage?.contextWindow ? (
                <Tooltip
                  content={`${contextUsage.percent === null ? "?" : contextUsage.percent.toFixed(1) + "%"} · ${(contextUsage.tokens ?? 0).toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()}`}
                >
                  <button
                    type="button"
                    {...stylex.props(inlineStyles.contextRingButton)}
                    aria-label={t("Context usage")}
                  >
                    <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true">
                      <circle cx="11" cy="11" r="8" fill="none" stroke="var(--border)" strokeWidth="2.5" />
                      <circle
                        cx="11"
                        cy="11"
                        r="8"
                        fill="none"
                        stroke={
                          contextUsage.percent !== null && contextUsage.percent > 90 ? "#ef4444" : "var(--accent)"
                        }
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={`${Math.min(100, contextUsage.percent ?? 0) * 0.5027} 50.27`}
                        transform="rotate(-90 11 11)"
                      />
                    </svg>
                    <small>{contextUsage.percent === null ? "?" : `${Math.round(contextUsage.percent)}%`}</small>
                  </button>
                </Tooltip>
              ) : null}

              {isStreaming && (
                <button
                  onClick={onAbort}
                  title={t(isBashRunning ? "Stop shell command" : "Stop agent")}
                  {...stylex.props(inlineStyles.inline93)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.16)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.08)"
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                  </svg>
                  {t("Stop")}
                </button>
              )}

              {isMobile && controlsMenuOpen && (
                <button
                  type="button"
                  title={t("Collapse controls")}
                  aria-label={t("Collapse controls")}
                  aria-expanded={true}
                  onClick={() => {
                    setToolDropdownOpen(false)
                    setThinkingDropdownOpen(false)
                    setControlsMenuOpen(false)
                  }}
                  {...stylex.props(inlineStyles.inline95)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-selected)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)"
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
const inlineStyles = stylex.create({
  inline1: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "3px 10px",
    fontSize: 12,
    color: "var(--text-muted)",
    minWidth: 0,
  },
  inline2: {
    flexShrink: 0,
    fontSize: 10,
    fontFamily: "var(--font-mono)",
    padding: "1px 7px",
    borderRadius: 999,
  },
  inline3: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline4: {
    flexShrink: 0,
    background: "transparent",
    padding: { default: "0 16px 12px", "@media (max-width: 760px)": "0 10px 10px" },
  },
  inline5: {
    display: "none",
  },
  inline6: {
    borderRadius: 12,
    maxWidth: 850,
    margin: "0 auto",
    overflow: "visible",
  },
  inline7: {
    marginBottom: 0,
    border: "1px solid var(--border)",
    borderBottom: "none",
    borderRadius: "9px 9px 0 0",
    background: "var(--bg-hover)",
    padding: "5px 0",
  },
  inline28: {
    background: "var(--bg-raised)",
    border: "1px solid var(--composer-border)",
    borderBottom: "none",
    boxShadow: "0 9px 28px rgba(31,31,25,.1)",
    position: "relative",
  },
  inline8: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "2px 8px 4px 10px",
  },
  inline9: {
    fontSize: 10,
    fontFamily: "var(--font-mono)",
    color: "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  inline10: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    fontSize: 12,
    color: "var(--text)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 7,
    cursor: "pointer",
    transition: "background 0.12s, border-color 0.12s",
    whiteSpace: "nowrap",
  },
  inline11: {
    marginBottom: 8,
    padding: "5px 10px",
    background: "rgba(234,179,8,0.08)",
    border: "1px solid rgba(234,179,8,0.25)",
    borderRadius: 6,
    fontSize: 12,
    color: "rgba(180,130,0,0.9)",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  inline12: {
    flexShrink: 0,
  },
  inline13: {
    opacity: 0.7,
    marginLeft: 4,
  },
  inline14: {
    marginBottom: 8,
    padding: "5px 10px",
    background: "rgba(16,185,129,0.08)",
    border: "1px solid rgba(16,185,129,0.24)",
    borderRadius: 6,
    fontSize: 12,
    color: "rgba(5,150,105,0.95)",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  inline15: {
    flexShrink: 0,
  },
  inline16: {
    display: "flex",
    gap: 6,
    marginBottom: 6,
    flexWrap: "wrap",
    alignItems: "center",
  },
  inline17: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    maxWidth: 300,
    height: 34,
    padding: "0 8px",
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--bg-panel)",
    color: "var(--text)",
  },
  inline18: {
    display: "flex",
    flexShrink: 0,
  },
  inline19: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 11,
  },
  inline20: {
    flexShrink: 0,
    fontSize: 10,
    color: "var(--text-dim)",
  },
  inline21: {
    display: "flex",
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    background: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
  },
  inline22: {
    fontSize: 11,
    color: "var(--text-muted)",
  },
  inline23: {
    fontSize: 11,
    color: "#ef4444",
  },
  inline24: {
    display: "flex",
    gap: 6,
    marginBottom: 6,
    flexWrap: "wrap",
  },
  inline25: {
    position: "relative",
    flexShrink: 0,
  },
  inline26: {
    width: 56,
    height: 56,
    objectFit: "cover",
    borderRadius: 6,
    border: "1px solid var(--border)",
    display: "block",
  },
  inline27: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: 0,
    color: "var(--text-muted)",
  },
  inline29: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "calc(100% + 8px)",
    zIndex: 120,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
    overflow: "hidden",
    maxHeight: "min(56vh, 460px)",
  },
  inline30: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline31: {
    fontFamily: "var(--font-mono)",
  },
  inline32: {
    maxHeight: "calc(min(56vh, 460px) - 34px)",
    overflowY: "auto",
    padding: 10,
  },
  inline33: {
    padding: "2px 2px 4px",
    fontSize: 12,
    color: "var(--text-dim)",
  },
  inline34: {
    marginBottom: 12,
  },
  inline35: {
    position: "sticky",
    top: -10,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "4px 0 6px",
    background: "var(--bg)",
    color: "var(--text-dim)",
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
  },
  inline36: {
    fontFamily: "var(--font-mono)",
    fontWeight: 500,
  },
  inline37: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 8,
  },
  inline38: {
    width: "100%",
    minWidth: 0,
    minHeight: 58,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    justifyContent: "center",
    padding: "9px 10px",
    borderRadius: 7,
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
  },
  inline39: {
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  inline40: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    fontSize: 11,
    lineHeight: 1.35,
    color: "var(--text-dim)",
  },
  inline41: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "calc(100% + 8px)",
    zIndex: 120,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
    overflow: "hidden",
    maxHeight: "min(48vh, 400px)",
  },
  inline42: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline43: {
    fontFamily: "var(--font-mono)",
  },
  inline44: {
    maxHeight: "calc(min(48vh, 400px) - 34px)",
    overflowY: "auto",
    padding: 4,
  },
  inline45: {
    padding: "6px 8px",
    fontSize: 12,
    color: "var(--text-dim)",
  },
  inline46: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    border: "none",
    borderRadius: 6,
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
  },
  inline47: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  inline48: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline49: {
    color: "var(--text-dim)",
  },
  inline50: {
    color: "var(--text-dim)",
  },
  inline51: {
    flex: 1,
    background: "none",
    border: "none",
    outline: "none",
    resize: "none",
    color: "var(--text)",
    fontSize: 14,
    lineHeight: 1.5,
    fontFamily: "inherit",
    minHeight: 43,
    maxHeight: 120,
    overflow: "auto",
    padding: "7px 9px",
  },
  inline52: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    alignSelf: "flex-end",
    bottom: -35,
    position: "absolute",
    right: 7,
    zIndex: 1,
  },
  inline53: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "7px 12px",
    border: "1px solid rgba(234,179,8,0.35)",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    transition: "background 0.12s",
  },
  inline54: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "7px 12px",
    border: "1px solid rgba(129,140,248,0.35)",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    transition: "background 0.12s",
  },
  inline55: {
    flexShrink: 0,
    alignSelf: "flex-end",
    display: "flex",
    alignItems: "center",
    gap: 6,
    bottom: -35,
    height: 29,
    justifyContent: "center",
    padding: 0,
    width: 29,
    border: "none",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    transition: "background 0.15s, box-shadow 0.15s",
    position: "absolute",
    right: 7,
    zIndex: 1,
  },
  inline56: {
    background: "var(--bg-raised)",
    border: "1px solid var(--composer-border)",
    borderTop: "none",
    borderRadius: "0 0 12px 12px",
    marginBottom: { default: 30, "@media (max-width: 760px)": 0 },
    minHeight: 42,
    alignItems: "center",
    gap: 5,
    padding: { default: "6px 7px 7px", "@media (max-width: 760px)": "6px 43px 7px 7px" },
    position: "relative",
  },
  inline57: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  inline58: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    padding: 0,
    background: "none",
    border: "none",
    borderRadius: 7,
    transition: "background 0.12s, color 0.12s",
  },
  inline59: {
    position: "relative",
    minWidth: 0,
  },
  inline60: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    height: 28,
    overflow: "hidden",
    background: "transparent",
    border: "1px solid var(--border-soft)",
    borderRadius: 7,
    color: "var(--text-muted)",
    fontSize: 11,
    transition: "background 0.12s, color 0.12s",
  },
  inline61: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  inline62: {
    alignItems: "center",
    backgroundColor: "var(--bg)",
    border: "none",
    cursor: "pointer",
    display: "flex",
    gap: 7,
    padding: "6px 12px 4px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    width: "100%",
  },
  manageModels: {
    alignItems: "center",
    backgroundColor: "var(--bg)",
    border: "none",
    borderTop: "1px solid var(--border)",
    color: "var(--accent)",
    cursor: "pointer",
    display: "flex",
    fontSize: 11,
    gap: 7,
    paddingBlock: 8,
    paddingInline: 12,
    width: "100%",
  },
  emptyModelButton: {
    alignItems: "center",
    backgroundColor: "var(--bg-hover)",
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    color: "var(--accent)",
    cursor: "pointer",
    display: "flex",
    fontSize: 11,
    height: 28,
    justifyContent: "center",
    lineHeight: 1,
    paddingInline: 10,
  },
  inline63: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 12px",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  inline64: {
    flexShrink: 0,
  },
  inline65: {
    width: 10,
    flexShrink: 0,
  },
  inline66: {
    flex: 1,
  },
  inline67: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    position: { default: "absolute", "@media (max-width: 760px)": "relative" },
    top: { default: "calc(100% + 1px)", "@media (max-width: 760px)": "auto" },
    left: { default: 4, "@media (max-width: 760px)": "auto" },
    right: { default: 4, "@media (max-width: 760px)": "auto" },
    height: { default: 30, "@media (max-width: 760px)": "auto" },
  },
  inline68: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: 32,
    padding: "8px 10px",
    background: "none",
    border: "none",
    borderRadius: 9,
    color: "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.12s, color 0.12s",
  },
  inline69: {
    position: "relative",
  },
  inline70: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 24,
    border: "none",
    borderRadius: 7,
    color: "var(--text-muted)",
    fontSize: 11,
    transition: "background 0.12s, color 0.12s",
  },
  inline71: {
    whiteSpace: "nowrap",
  },
  inline72: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    right: 0,
    zIndex: 100,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
    overflow: "hidden",
    minWidth: 180,
  },
  inline73: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 12px",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  inline74: {
    flexShrink: 0,
  },
  inline75: {
    width: 10,
    flexShrink: 0,
  },
  inline76: {
    flex: 1,
  },
  inline77: {
    fontSize: 10,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    marginLeft: 5,
  },
  inline78: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginLeft: 8,
  },
  inline79: {
    position: "relative",
  },
  inline80: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 24,
    border: "none",
    borderRadius: 9,
    color: "var(--text-muted)",
    fontSize: 11,
    transition: "background 0.12s, color 0.12s",
  },
  inline81: {
    whiteSpace: "nowrap",
  },
  inline82: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    right: 0,
    zIndex: 100,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
    overflow: "hidden",
    minWidth: 260,
  },
  inline83: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 12px",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  inline84: {
    flexShrink: 0,
  },
  inline85: {
    width: 10,
    flexShrink: 0,
  },
  inline86: {
    flex: 1,
  },
  inline87: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginLeft: 8,
  },
  inline88: {
    position: "relative",
  },
  inline89: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    right: 0,
    background: "#1f2937",
    color: "#f87171",
    fontSize: 11,
    padding: "4px 8px",
    borderRadius: 5,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    zIndex: 50,
  },
  inline90: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 32,
    border: "none",
    borderRadius: 9,
    fontSize: 12,
    transition: "background 0.12s, color 0.12s",
  },
  inline91: {
    whiteSpace: "nowrap",
  },
  inline92: {
    whiteSpace: "nowrap",
  },
  inline93: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    height: 32,
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 9,
    color: "#ef4444",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
    transition: "background 0.12s",
  },
  inline94: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 32,
    padding: 0,
    background: "none",
    border: "none",
    borderRadius: 9,
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s, opacity 0.12s",
  },
  metricButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    fontSize: 11,
    gap: 5,
    height: 24,
    paddingInline: 5,
  },
  promptToken: {
    alignItems: "center",
    background: "transparent",
    border: "1px solid var(--border-soft)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: { default: "flex", "@media (max-width: 760px)": "none" },
    fontSize: 11,
    height: 28,
    justifyContent: "center",
    lineHeight: 1,
    padding: "0 7px",
    whiteSpace: "nowrap",
    ":hover": { color: "var(--text)", background: "var(--bg-selected)" },
  },
  metricTooltip: {
    display: "grid",
    gap: "2px 12px",
    gridTemplateColumns: "auto auto",
    textAlign: "left",
  },
  contextRingButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    gap: 5,
    height: 24,
    justifyContent: "center",
    padding: "0 5px",
    width: "auto",
  },
  metaSpacer: {
    flex: 1,
  },
  metricCost: {
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: ".85px",
  },
  metricLabel: {
    color: "var(--text-dim)",
    fontSize: 10,
  },
  modelStatusDot: {
    background: "var(--success)",
    borderRadius: "50%",
    flexShrink: 0,
    height: 5,
    width: 5,
  },
  inline95: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 32,
    padding: 0,
    marginLeft: 0,
    background: "var(--bg-hover)",
    border: "none",
    borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
    borderRadius: "0 9px 9px 0",
    color: "var(--text)",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s",
  },
})
