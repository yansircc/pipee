import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { useState, useCallback, useEffect, useRef } from "react"
import { getFileIcon, FolderIcon } from "./FileIcons"
import { getRelativeFilePath } from "@/lib/file-paths"
import { useI18n } from "@/lib/i18n"
import { writePathDrag } from "@/lib/drop-paths"
import { withApi, apiUrls, runApi, type Cancel } from "@/browser/api-client"
interface FileNode {
  name: string
  fullPath: string
  isDir: boolean
  size: number
  children?: FileNode[]
  loaded?: boolean
}
interface Props {
  cwd: string
  onOpenFile: (filePath: string, fileName: string) => void
  refreshKey?: number
  onAtMention?: (relativePath: string, isDir: boolean) => void
  selectedFilePath?: string | null
}
const toFileNodes = (
  entries: ReadonlyArray<{ name: string; path: string; kind: "file" | "directory"; size?: number }>,
): FileNode[] =>
  entries.map((entry) => ({
    name: entry.name,
    fullPath: entry.path,
    isDir: entry.kind === "directory",
    size: entry.size ?? 0,
    children: entry.kind === "directory" ? [] : undefined,
    loaded: entry.kind !== "directory",
  }))
function loadEntries(
  dirPath: string,
  callbacks: {
    readonly onSuccess: (entries: FileNode[]) => void
    readonly onFailure: (error: unknown) => void
  },
): Cancel {
  return runApi(
    withApi((api) =>
      api.workspace.fileIndex({
        query: {
          root: dirPath,
        },
      }),
    ),
    {
      onSuccess: ({ entries }) => callbacks.onSuccess(toFileNodes(entries)),
      onFailure: callbacks.onFailure,
    },
  )
}
function loadRootEntries(
  root: string,
  callbacks: {
    readonly onSuccess: (entries: FileNode[]) => void
    readonly onFailure: (error: unknown) => void
  },
): Cancel {
  return runApi(
    withApi((api) =>
      api.workspace.validateCwd({ payload: { cwd: root } }).pipe(
        Effect.flatMap(({ cwd }) =>
          api.workspace.fileIndex({
            query: { root: cwd },
          }),
        ),
      ),
    ),
    {
      onSuccess: ({ entries }) => callbacks.onSuccess(toFileNodes(entries)),
      onFailure: callbacks.onFailure,
    },
  )
}
function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
  selectedFilePath,
}: {
  node: FileNode
  depth: number
  cwd: string
  onOpenFile: (filePath: string, fileName: string) => void
  onAtMention?: (relativePath: string, isDir: boolean) => void
  expandedPaths: Set<string>
  onToggleExpanded: (fullPath: string, open: boolean) => void
  refreshKey?: number
  selectedFilePath?: string | null
}) {
  const { t } = useI18n()
  const open = expandedPaths.has(node.fullPath)
  const selected = !node.isDir && selectedFilePath === node.fullPath
  const [children, setChildren] = useState<FileNode[]>(node.children ?? [])
  const [loaded, setLoaded] = useState(node.loaded ?? false)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(false)
  const loadChildren = useCallback(
    (force = false) => {
      if (loaded && !force) return
      setLoading(true)
      loadEntries(node.fullPath, {
        onSuccess: (entries) => {
          setChildren(entries)
          setLoaded(true)
          setLoading(false)
        },
        onFailure: () => setLoading(false),
      })
    },
    [loaded, node.fullPath],
  )

  // When refreshKey causes a re-render with the same node identity, reload open dirs
  const prevLoadedRef = useRef(loaded)
  useEffect(() => {
    prevLoadedRef.current = loaded
  })

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])
  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open
      onToggleExpanded(node.fullPath, next)
      if (next && !loaded) loadChildren()
    } else {
      onOpenFile(node.fullPath, node.name)
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded])
  return (
    <div>
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={node.name}
        aria-current={selected ? "true" : undefined}
        onDragStart={(event) => writePathDrag(event.dataTransfer, node.fullPath, node.isDir)}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            handleClick()
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        {...stylex.props(inlineStyles.inline1)}
        style={{
          paddingLeft: 8 + depth * 14,
          background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
          color: selected ? "var(--text)" : undefined,
        }}
      >
        {node.isDir && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            {...stylex.props(inlineStyles.inline2)}
            style={{
              transform: open ? "rotate(90deg)" : "none",
            }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span {...stylex.props(inlineStyles.inline3)} />}
        <span {...stylex.props(inlineStyles.inline4)}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span {...stylex.props(inlineStyles.inline5)} title={node.fullPath}>
          {node.name}
        </span>
        {loading && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir)
            }}
            title={t("Insert path into chat")}
            {...stylex.props(inlineStyles.inline6)}
            style={{
              right: !node.isDir ? 28 : 4,
            }}
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
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            {t("mention")}
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={apiUrls.workspace.downloadFile({
              query: {
                path: node.fullPath,
              },
            })}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("Download file")}
            {...stylex.props(inlineStyles.inline7)}
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
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
              selectedFilePath={selectedFilePath}
            />
          ))}
          {children.length === 0 && loaded && (
            <div
              {...stylex.props(inlineStyles.inline8)}
              style={{
                paddingLeft: 8 + (depth + 1) * 14,
              }}
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}
export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, selectedFilePath }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const prevCwdRef = useRef<string | null>(null)
  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (open) next.add(fullPath)
      else next.delete(fullPath)
      return next
    })
  }, [])
  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd
    prevCwdRef.current = cwd

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) setExpandedPaths(new Set())
    setLoading(cwdChanged)
    setError(null)
    return loadRootEntries(cwd, {
      onSuccess: (entries) => {
        setRoots(entries)
        setLoading(false)
      },
      onFailure: (failure) => {
        setError(failure instanceof Error ? failure.message : String(failure))
        setLoading(false)
      },
    })
  }, [cwd, refreshKey])
  if (loading) {
    return <div {...stylex.props(inlineStyles.inline9)}>Loading files...</div>
  }
  if (error) {
    return <div {...stylex.props(inlineStyles.inline10)}>{error}</div>
  }
  return (
    <div {...stylex.props(inlineStyles.inline11)}>
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={refreshKey}
          selectedFilePath={selectedFilePath}
        />
      ))}
      {roots.length === 0 && <div {...stylex.props(inlineStyles.inline12)}>No files found</div>}
    </div>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 4,
    paddingRight: 8,
    height: 24,
    cursor: "pointer",
    borderRadius: 4,
    userSelect: "none",
  },
  inline2: {
    flexShrink: 0,
    transition: "transform 0.1s",
  },
  inline3: {
    width: 10,
    flexShrink: 0,
  },
  inline4: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  inline5: {
    fontSize: 12,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },
  inline6: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "0 8px",
    height: 20,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--accent)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  inline7: {
    position: "absolute",
    right: 4,
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "0 5px",
    height: 20,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    textDecoration: "none",
  },
  inline8: {
    fontSize: 11,
    color: "var(--text-dim)",
    height: 22,
    display: "flex",
    alignItems: "center",
  },
  inline9: {
    padding: "8px 12px",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline10: {
    padding: "8px 12px",
    fontSize: 11,
    color: "#f87171",
  },
  inline11: {
    padding: "2px 4px",
  },
  inline12: {
    padding: "8px 12px",
    fontSize: 11,
    color: "var(--text-dim)",
  },
})
