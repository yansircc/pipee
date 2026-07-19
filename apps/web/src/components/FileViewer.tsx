import * as stylex from "@stylexjs/stylex"
import { useEffect, useState, useRef, useCallback } from "react"
import { Effect } from "effect"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism"
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism"
import ReactMarkdown from "react-markdown"
import { useTheme } from "@/hooks/useTheme"
import { DOCX_PREVIEW_MAX_BYTES, getFileExt, isAudioPath, isDocumentPreviewPath, isImagePath } from "@/lib/file-types"
import { getFileName, getRelativeFilePath } from "@/lib/file-paths"
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown"
import { useI18n } from "@/lib/i18n"
import { copyText } from "@/lib/clipboard"
import { withApi, apiUrls, runApi, runApiStream, runBrowser, type Cancel } from "@/browser/api-client"
interface Props {
  filePath: string
  cwd?: string
  sourceSessionId?: string | null
}
interface FileData {
  content: string
  language: string
  size: number
}
const fileQuery = (filePath: string, sourceSessionId?: string | null) => ({
  path: filePath,
  ...(sourceSessionId
    ? {
        sessionId: sourceSessionId,
      }
    : {}),
})
function useFileWatch(
  filePath: string,
  sourceSessionId: string | null | undefined,
  onChange: (size: number) => void,
): boolean {
  const [watching, setWatching] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    setWatching(true)
    return runApiStream(
      withApi((api) =>
        api.workspace.watchFile({
          query: fileQuery(filePath, sourceSessionId),
        }),
      ),
      {
        onValue: (event) => {
          if (event._tag === "Changed") onChangeRef.current(event.size)
        },
        onFailure: () => setWatching(false),
        onEnd: () => setWatching(false),
      },
    )
  }, [filePath, sourceSessionId])
  return watching
}
function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n()
  return (
    <a
      href={apiUrls.workspace.downloadFile({
        query: fileQuery(filePath, sourceSessionId),
      })}
      download={getFileName(filePath)}
      title={t("Download file")}
      {...stylex.props(inlineStyles.inline1)}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  )
}
type DiffLine =
  | {
      type: "unchanged"
      text: string
      lineNo: number
    }
  | {
      type: "removed"
      text: string
      lineNo: number
    }
  | {
      type: "added"
      text: string
      lineNo: number
    }
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Myers diff — returns line-level unified diff
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length
  const n = newLines.length
  const max = m + n
  const v = Array.from<number>({
    length: 2 * max + 1,
  }).fill(0)
  const trace: number[][] = []
  for (let d = 0; d <= max; d++) {
    trace.push([...v])
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]
      } else {
        x = v[k - 1 + max] + 1
      }
      let y = x - k
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++
        y++
      }
      v[k + max] = x
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = []
        let cx = m,
          cy = n
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1]
          const pk = cx - cy
          let prevK: number
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max] < pv[pk + 1 + max])) {
            prevK = pk + 1
          } else {
            prevK = pk - 1
          }
          const prevX = pv[prevK + max]
          const prevY = prevX - prevK
          while (cx > prevX && cy > prevY) {
            cx--
            cy--
            result.unshift({
              type: "unchanged",
              text: oldLines[cx],
              lineNo: cx + 1,
            })
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--
              result.unshift({
                type: "removed",
                text: oldLines[cx],
                lineNo: cx + 1,
              })
            } else {
              cy--
              result.unshift({
                type: "added",
                text: newLines[cy],
                lineNo: cy + 1,
              })
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--
          cy--
          result.unshift({
            type: "unchanged",
            text: oldLines[cx],
            lineNo: cx + 1,
          })
        }
        return result
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t, i) => ({
      type: "removed" as const,
      text: t,
      lineNo: i + 1,
    })),
    ...newLines.map((t, i) => ({
      type: "added" as const,
      text: t,
      lineNo: i + 1,
    })),
  ]
}
function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string; language: string }) {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  const diff = diffLines(oldLines, newLines)
  const hasChanges = diff.some((l) => l.type !== "unchanged")
  if (!hasChanges) {
    return <div {...stylex.props(inlineStyles.inline2)}>No changes</div>
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])))
  const visible = new Set<number>()
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j)
    }
  }
  const segments: Array<
    | {
        hidden: true
        count: number
      }
    | {
        hidden: false
        lines: DiffLine[]
      }
  > = []
  let i = 0
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = []
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i])
        i++
      }
      segments.push({
        hidden: false,
        lines: block,
      })
    } else {
      let count = 0
      while (i < diff.length && !visible.has(i)) {
        count++
        i++
      }
      segments.push({
        hidden: true,
        count,
      })
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = []
  let nlo = 1
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0)
    } else {
      newLineNos.push(nlo++)
    }
  }
  let diffIdx = 0
  return (
    <div {...stylex.props(inlineStyles.inline3)}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div key={si} {...stylex.props(inlineStyles.inline4)}>
              ... {seg.count} unchanged lines ...
            </div>
          )
          diffIdx += seg.count
          return result
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li
          const newLno = newLineNos[idx]
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
                ? "rgba(240,60,60,0.14)"
                : "transparent"
          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " "
          const prefixColor =
            line.type === "added" ? "#4ade80" : line.type === "removed" ? "#f87171" : "var(--text-dim)"
          return (
            <div
              key={li}
              {...stylex.props(inlineStyles.inline5)}
              style={{
                background: bg,
                borderLeft:
                  line.type === "added"
                    ? "3px solid #4ade80"
                    : line.type === "removed"
                      ? "3px solid #f87171"
                      : "3px solid transparent",
              }}
            >
              <span {...stylex.props(inlineStyles.inline6)}>
                {line.type === "removed" ? line.lineNo : newLno || ""}
              </span>
              <span
                {...stylex.props(inlineStyles.inline7)}
                style={{
                  color: prefixColor,
                }}
              >
                {prefix}
              </span>
              <span {...stylex.props(inlineStyles.inline8)}>{line.text || "\u00a0"}</span>
            </div>
          )
        })
        diffIdx += seg.lines.length
        return <div key={si}>{lines}</div>
      })}
    </div>
  )
}
function ImageViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n()
  const [bust, setBust] = useState(0)
  const [size, setSize] = useState<number | null>(null)
  const [naturalSize, setNaturalSize] = useState<{
    w: number
    h: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? ""
  useEffect(() => {
    setBust(0)
    setSize(null)
    setNaturalSize(null)
    setError(null)
  }, [filePath, sourceSessionId])
  const watching = useFileWatch(filePath, sourceSessionId, (nextSize) => {
    setSize(nextSize)
    setBust((value) => value + 1)
  })
  const src = apiUrls.workspace.downloadFile({
    query: fileQuery(filePath, sourceSessionId),
  })
  const formatSizeStr = size != null ? formatSize(size) : null
  return (
    <div {...stylex.props(inlineStyles.inline9)}>
      <div {...stylex.props(inlineStyles.inline10)}>
        <span {...stylex.props(inlineStyles.inline11)} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span {...stylex.props(inlineStyles.inline12)}>{ext || "image"}</span>
        {naturalSize && (
          <span>
            {naturalSize.w} × {naturalSize.h}
          </span>
        )}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={t(watching ? "Live sync active" : "Not watching")}
          {...stylex.props(inlineStyles.inline13)}
          style={{
            color: watching ? "#4ade80" : "var(--text-dim)",
          }}
        >
          <span
            {...stylex.props(inlineStyles.inline14)}
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div {...stylex.props(inlineStyles.inline15)}>
        {error ? (
          <div {...stylex.props(inlineStyles.inline16)}>{error}</div>
        ) : (
          <img
            key={bust}
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget
              setNaturalSize({
                w: img.naturalWidth,
                h: img.naturalHeight,
              })
            }}
            onError={() => setError(t("Failed to load image"))}
            {...stylex.props(inlineStyles.inline17)}
          />
        )}
      </div>
    </div>
  )
}
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return ""
  const totalSeconds = Math.round(seconds)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${String(secs).padStart(2, "0")}`
}
function AudioViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n()
  const [bust, setBust] = useState(0)
  const [size, setSize] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? ""
  useEffect(() => {
    setBust(0)
    setSize(null)
    setDuration(null)
    setError(null)
  }, [filePath, sourceSessionId])
  const watching = useFileWatch(filePath, sourceSessionId, (nextSize) => {
    setSize(nextSize)
    setDuration(null)
    setError(null)
    setBust((value) => value + 1)
  })
  const src = apiUrls.workspace.downloadFile({
    query: fileQuery(filePath, sourceSessionId),
  })
  return (
    <div {...stylex.props(inlineStyles.inline18)}>
      <div {...stylex.props(inlineStyles.inline19)}>
        <span {...stylex.props(inlineStyles.inline20)} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span {...stylex.props(inlineStyles.inline21)}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={t(watching ? "Live sync active" : "Not watching")}
          {...stylex.props(inlineStyles.inline22)}
          style={{
            color: watching ? "#4ade80" : "var(--text-dim)",
          }}
        >
          <span
            {...stylex.props(inlineStyles.inline23)}
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div {...stylex.props(inlineStyles.inline24)}>
        <div {...stylex.props(inlineStyles.inline25)}>
          {error && <div {...stylex.props(inlineStyles.inline26)}>{error}</div>}
          <audio
            key={`${src}:${bust}`}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("Failed to load audio"))}
            {...stylex.props(inlineStyles.inline27)}
          />
        </div>
      </div>
    </div>
  )
}
function DocumentViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n()
  const [bust, setBust] = useState(0)
  const [size, setSize] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const previewCancelRef = useRef<Cancel | null>(null)
  const ext = getFileExt(filePath)
  const isPdf = ext === "pdf"
  const previewUrl = apiUrls.workspace.downloadFile({
    query: fileQuery(filePath, sourceSessionId),
  })
  useEffect(() => {
    setBust(0)
    setSize(null)
    setError(null)
    setPreviewHtml(null)
    const load = withApi((api) =>
      api.workspace.fileMeta({
        query: fileQuery(filePath, sourceSessionId),
      }),
    ).pipe(
      Effect.flatMap((meta) =>
        isPdf || meta.size > DOCX_PREVIEW_MAX_BYTES
          ? Effect.succeed({
              meta,
              previewContent: null as string | null,
            })
          : withApi((api) =>
              api.workspace.previewFile({
                query: fileQuery(filePath, sourceSessionId),
              }),
            ).pipe(
              Effect.map((preview) => ({
                meta,
                previewContent: preview.content as string | null,
              })),
            ),
      ),
    )
    previewCancelRef.current = runApi(load, {
      onSuccess: ({ meta, previewContent }) => {
        setSize(meta.size)
        if (!isPdf && meta.size > DOCX_PREVIEW_MAX_BYTES) {
          setError(t("DOCX too large for preview (>10MB)"))
        } else if (previewContent !== null) {
          setPreviewHtml(previewContent)
        }
      },
      onFailure: (failure) => setError(String(failure)),
    })
    return () => {
      previewCancelRef.current?.()
      previewCancelRef.current = null
    }
  }, [filePath, isPdf, sourceSessionId, t])
  const watching = useFileWatch(filePath, sourceSessionId, (nextSize) => {
    setSize(nextSize)
    if (!isPdf && nextSize > DOCX_PREVIEW_MAX_BYTES) {
      setError(t("DOCX too large for preview (>10MB)"))
      return
    }
    setError(null)
    setBust((value) => value + 1)
    if (!isPdf) {
      previewCancelRef.current?.()
      previewCancelRef.current = runApi(
        withApi((api) =>
          api.workspace.previewFile({
            query: fileQuery(filePath, sourceSessionId),
          }),
        ),
        {
          onSuccess: (preview) => setPreviewHtml(preview.content),
          onFailure: (failure) => setError(String(failure)),
        },
      )
    }
  })
  return (
    <div {...stylex.props(inlineStyles.inline28)}>
      <div {...stylex.props(inlineStyles.inline29)}>
        <span {...stylex.props(inlineStyles.inline30)} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span {...stylex.props(inlineStyles.inline31)}>{ext === "docx" ? "docx preview" : "pdf"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
        <span
          title={t(watching ? "Live sync active" : "Not watching")}
          {...stylex.props(inlineStyles.inline32)}
          style={{
            color: watching ? "#4ade80" : "var(--text-dim)",
          }}
        >
          <span
            {...stylex.props(inlineStyles.inline33)}
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
      </div>
      <div {...stylex.props(inlineStyles.inline34)}>
        {error ? (
          <div {...stylex.props(inlineStyles.inline35)}>{error}</div>
        ) : (
          <iframe
            key={`${previewUrl}:${bust}`}
            {...(isPdf
              ? {
                  src: previewUrl,
                }
              : {
                  srcDoc: previewHtml ?? "",
                })}
            sandbox={isPdf ? undefined : ""}
            title={`Preview ${getFileName(filePath)}`}
            {...stylex.props(inlineStyles.inline36)}
            style={{
              background: isPdf ? "var(--bg)" : "#eef1f5",
            }}
          />
        )}
      </div>
    </div>
  )
}
export function FileViewer({ filePath, cwd, sourceSessionId }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />
}
function TextFileViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const [data, setData] = useState<FileData | null>(null)
  const [prevContent, setPrevContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const [viewMode, setViewMode] = useState<"source" | "diff">("source")
  const [wrapLines, setWrapLines] = useState(false)
  const [watching, setWatching] = useState(false)
  const [changeCount, setChangeCount] = useState(0)
  const fetchContent = useCallback(
    (filePath: string, isRefresh = false) => {
      return runApi(
        withApi((api) =>
          api.workspace.readFile({
            query: fileQuery(filePath, sourceSessionId),
          }),
        ),
        {
          onSuccess: (content) => {
            const d: FileData = {
              content: content.content,
              language: getFileExt(filePath) || "text",
              size: content.size,
            }
            if (isRefresh) {
              setData((prev) => {
                if (prev) setPrevContent(prev.content)
                return d
              })
              setChangeCount((c) => c + 1)
            } else {
              setData(d)
            }
            if (!isRefresh && d.language === "md") setPreviewMode(true)
            setLoading(false)
          },
          onFailure: (failure) => {
            setError(String(failure))
            setLoading(false)
          },
        },
      )
    },
    [sourceSessionId],
  )

  // Initial load + SSE watch setup
  useEffect(() => {
    setLoading(true)
    setError(null)
    setData(null)
    setPrevContent(null)
    setPreviewMode(false)
    setViewMode("source")
    setWrapLines(false)
    setChangeCount(0)
    setWatching(false)
    return fetchContent(filePath)
  }, [filePath, fetchContent, sourceSessionId])
  const liveWatching = useFileWatch(filePath, sourceSessionId, () => fetchContent(filePath, true))
  useEffect(() => setWatching(liveWatching), [liveWatching])
  if (loading) {
    return <div {...stylex.props(inlineStyles.inline37)}>Loading...</div>
  }
  if (error) {
    return <div {...stylex.props(inlineStyles.inline38)}>{error}</div>
  }
  if (!data) return null
  const isHtml = data.language === "html"
  const isMarkdown = data.language === "md" || data.language === "markdown"
  const lines = data.content.split("\n")
  const hasDiff = prevContent !== null && prevContent !== data.content
  return (
    <div {...stylex.props(inlineStyles.inline39)}>
      {/* Status bar */}
      <div {...stylex.props(inlineStyles.inline40)}>
        <span {...stylex.props(inlineStyles.inline41)} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span {...stylex.props(inlineStyles.inline42)}>{data.language}</span>
        {viewMode === "source" && <span {...stylex.props(inlineStyles.inline59)}>{lines.length} lines</span>}
        <span {...stylex.props(inlineStyles.inline59)}>{formatSize(data.size)}</span>

        {/* Live watch indicator */}
        <span
          title={t(watching ? "Live sync active" : "Not watching")}
          {...stylex.props(inlineStyles.inline43)}
          style={{
            color: watching ? "#4ade80" : "var(--text-dim)",
          }}
        >
          <span
            {...stylex.props(inlineStyles.inline44)}
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>

        {/* Diff / Source toggle — shown only when there are changes */}
        {hasDiff && (
          <div {...stylex.props(inlineStyles.inline45)}>
            <button
              onClick={() => setViewMode("source")}
              {...stylex.props(inlineStyles.inline46)}
              style={{
                background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "source" ? 600 : 400,
              }}
            >
              Source
            </button>
            <button
              onClick={() => setViewMode("diff")}
              {...stylex.props(inlineStyles.inline47)}
              style={{
                background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "diff" ? 600 : 400,
              }}
            >
              Diff {changeCount > 0 && <span {...stylex.props(inlineStyles.inline48)}>+{changeCount}</span>}
            </button>
          </div>
        )}

        {/* Word wrap toggle */}
        {viewMode === "source" && !previewMode && (
          <button
            onClick={() => setWrapLines((v) => !v)}
            title={t(wrapLines ? "Disable word wrap" : "Enable word wrap")}
            {...stylex.props(inlineStyles.inline49)}
            style={{
              background: wrapLines ? "var(--bg-selected)" : "var(--bg-hover)",
              color: wrapLines ? "var(--text)" : "var(--text-muted)",
              fontWeight: wrapLines ? 600 : 400,
            }}
          >
            wrap
          </button>
        )}

        {/* HTML source/preview toggle */}
        {isHtml && viewMode === "source" && (
          <div {...stylex.props(inlineStyles.inline50)}>
            <button
              onClick={() => setPreviewMode(false)}
              {...stylex.props(inlineStyles.inline51)}
              style={{
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              Code
            </button>
            <button
              onClick={() => setPreviewMode(true)}
              {...stylex.props(inlineStyles.inline52)}
              style={{
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              Preview
            </button>
          </div>
        )}

        {/* Markdown preview/raw toggle */}
        {isMarkdown && viewMode === "source" && (
          <div {...stylex.props(inlineStyles.inline53)}>
            <button
              onClick={() => setPreviewMode(true)}
              {...stylex.props(inlineStyles.inline54)}
              style={{
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              Preview
            </button>
            <button
              onClick={() => setPreviewMode(false)}
              {...stylex.props(inlineStyles.inline55)}
              style={{
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              Raw
            </button>
          </div>
        )}
        <button
          type="button"
          title={t("Copy")}
          aria-label={t("Copy")}
          onClick={() => runBrowser(copyText(data.content), { onSuccess: () => undefined })}
          {...stylex.props(inlineStyles.inline1)}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>

      {/* Content area */}
      <div {...stylex.props(inlineStyles.inline56)}>
        {viewMode === "diff" && hasDiff ? (
          <DiffView oldContent={prevContent!} newContent={data.content} language={data.language} />
        ) : isHtml && previewMode ? (
          <iframe
            srcDoc={data.content}
            sandbox="allow-scripts"
            {...stylex.props(inlineStyles.inline57)}
            title={t("HTML preview")}
          />
        ) : isMarkdown && previewMode ? (
          <div className={`${stylex.props(inlineStyles.inline58).className} markdown-body markdown-file-preview`}>
            <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "12px 0",
              background: "var(--bg)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono)",
              },
            }}
            wrapLongLines={wrapLines}
          >
            {data.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 20,
    padding: "0 5px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    textDecoration: "none",
  },
  inline2: {
    padding: "12px 16px",
    fontSize: 12,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
  },
  inline3: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    lineHeight: 1.6,
  },
  inline4: {
    padding: "2px 16px",
    color: "var(--text-dim)",
    background: "var(--bg-panel)",
    fontSize: 11,
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
  },
  inline5: {
    display: "flex",
  },
  inline6: {
    minWidth: 44,
    padding: "0 8px 0 16px",
    textAlign: "right",
    color: "var(--text-dim)",
    userSelect: "none",
    fontSize: 11,
    lineHeight: 1.6,
    borderRight: "1px solid var(--border)",
    background: "var(--bg-panel)",
    flexShrink: 0,
  },
  inline7: {
    minWidth: 16,
    padding: "0 6px",
    userSelect: "none",
    flexShrink: 0,
    fontWeight: 600,
  },
  inline8: {
    flex: 1,
    padding: "0 8px 0 0",
    whiteSpace: "pre",
    color: "var(--text)",
    overflowX: "auto",
  },
  inline9: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  inline10: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "4px 16px",
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    color: "var(--text-dim)",
    background: "var(--bg)",
    flexShrink: 0,
  },
  inline11: {
    fontFamily: "var(--font-mono)",
  },
  inline12: {
    marginLeft: "auto",
  },
  inline13: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline14: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
  },
  inline15: {
    flex: 1,
    overflow: "auto",
    background: "var(--bg-panel)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    backgroundImage:
      "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  },
  inline16: {
    color: "#f87171",
    fontSize: 13,
  },
  inline17: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  },
  inline18: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  inline19: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "4px 16px",
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    color: "var(--text-dim)",
    background: "var(--bg)",
    flexShrink: 0,
  },
  inline20: {
    fontFamily: "var(--font-mono)",
  },
  inline21: {
    marginLeft: "auto",
  },
  inline22: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline23: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
  },
  inline24: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "var(--bg-panel)",
  },
  inline25: {
    width: "min(680px, 100%)",
  },
  inline26: {
    color: "#f87171",
    fontSize: 13,
    marginBottom: 12,
    textAlign: "center",
  },
  inline27: {
    width: "100%",
  },
  inline28: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  inline29: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "4px 16px",
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    color: "var(--text-dim)",
    background: "var(--bg)",
    flexShrink: 0,
  },
  inline30: {
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline31: {
    marginLeft: "auto",
  },
  inline32: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  inline33: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
  },
  inline34: {
    flex: 1,
    minHeight: 0,
    background: "var(--bg-panel)",
  },
  inline35: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
  },
  inline36: {
    width: "100%",
    height: "100%",
    border: "none",
  },
  inline37: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-muted)",
    fontSize: 13,
  },
  inline38: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#f87171",
    fontSize: 13,
  },
  inline39: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  inline40: {
    display: "flex",
    alignItems: "center",
    gap: { default: 12, "@media (max-width: 520px)": 6 },
    padding: { default: "4px 16px", "@media (max-width: 520px)": "4px 8px" },
    borderBottom: "1px solid var(--border)",
    fontSize: 11,
    color: "var(--text-dim)",
    background: "var(--bg)",
    flexShrink: 0,
  },
  inline41: {
    flex: 1,
    fontFamily: "var(--font-mono)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline42: {
    marginLeft: "auto",
    display: { default: "inline", "@media (max-width: 520px)": "none" },
  },
  inline43: {
    display: { default: "flex", "@media (max-width: 520px)": "none" },
    alignItems: "center",
    gap: 4,
  },
  inline44: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
  },
  inline45: {
    display: "flex",
    borderRadius: 5,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  inline46: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    cursor: "pointer",
  },
  inline47: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    borderLeft: "1px solid var(--border)",
    cursor: "pointer",
  },
  inline48: {
    color: "#4ade80",
    marginLeft: 2,
  },
  inline49: {
    padding: "2px 8px",
    fontSize: 11,
    cursor: "pointer",
    border: "1px solid var(--border)",
    borderRadius: 5,
  },
  inline50: {
    display: "flex",
    borderRadius: 5,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  inline51: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    cursor: "pointer",
  },
  inline52: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    borderLeft: "1px solid var(--border)",
    cursor: "pointer",
  },
  inline53: {
    display: "flex",
    borderRadius: 5,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  inline54: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    cursor: "pointer",
  },
  inline55: {
    padding: "2px 8px",
    fontSize: 11,
    border: "none",
    borderLeft: "1px solid var(--border)",
    cursor: "pointer",
  },
  inline56: {
    flex: 1,
    overflow: "auto",
    background: "var(--bg)",
  },
  inline57: {
    width: "100%",
    height: "100%",
    border: "none",
    background: "var(--bg)",
  },
  inline58: {
    padding: "24px 32px",
    maxWidth: 800,
  },
  inline59: {
    display: { default: "inline", "@media (max-width: 520px)": "none" },
  },
})
