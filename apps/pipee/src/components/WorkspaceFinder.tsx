import * as stylex from "@stylexjs/stylex"
import { Suspense, useState } from "react"
import { FileExplorer } from "./FileExplorer"
import { FileViewer } from "@/browser/code-split"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import { getRelativeFilePath } from "@/lib/file-paths"
import { SettingsWorkspace } from "@/ui/interaction/SettingsWorkspace"

interface SelectedFile {
  readonly filePath: string
  readonly sourceSessionId?: string | null
}

interface WorkspaceFinderProps {
  readonly cwd: string
  readonly onAtMention: (relativePath: string, isDir: boolean) => void
  readonly onClose: () => void
  readonly onOpenFile: (filePath: string, fileName: string) => void
  readonly refreshKey: number
  readonly selectedFile: SelectedFile | null
}

export function WorkspaceFinder({
  cwd,
  onAtMention,
  onClose,
  onOpenFile,
  refreshKey,
  selectedFile,
}: WorkspaceFinderProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [query, setQuery] = useState("")

  return (
    <SettingsWorkspace
      closeLabel={t("Close")}
      context={isMobile ? undefined : <code {...stylex.props(styles.cwd)}>{cwd}</code>}
      height={isMobile ? "100dvh" : "min(720px, 82dvh)"}
      onClose={onClose}
      title={t("Resource manager")}
      width={isMobile ? "100vw" : "min(960px, 90vw)"}
    >
      <div {...stylex.props(styles.workspace)}>
        <aside {...stylex.props(styles.treePane)}>
          <label {...stylex.props(styles.search)}>
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              aria-label={t("Search files")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search files")}
              {...stylex.props(styles.searchInput)}
            />
          </label>
          <div {...stylex.props(styles.treeScroll)}>
            <FileExplorer
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              refreshKey={refreshKey}
              query={query}
              selectedFilePath={selectedFile?.filePath ?? null}
            />
          </div>
        </aside>
        <div {...stylex.props(styles.viewer)}>
          {selectedFile ? (
            <Suspense fallback={null}>
              <FileViewer
                actions={
                  <button
                    type="button"
                    onClick={() => onAtMention(getRelativeFilePath(selectedFile.filePath, cwd), false)}
                    {...stylex.props(styles.mentionAction)}
                  >
                    @ {t("mention")}
                  </button>
                }
                filePath={selectedFile.filePath}
                cwd={cwd}
                sourceSessionId={selectedFile.sourceSessionId}
              />
            </Suspense>
          ) : (
            <div {...stylex.props(styles.empty)}>
              <svg
                aria-hidden="true"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>{t("Select a file to preview")}</span>
            </div>
          )}
        </div>
      </div>
    </SettingsWorkspace>
  )
}

const styles = stylex.create({
  cwd: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    maxWidth: { default: 520, "@media (max-width: 760px)": 190 },
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  workspace: {
    display: "grid",
    gridTemplateColumns: { default: "220px minmax(0, 1fr)", "@media (max-width: 720px)": "148px minmax(0, 1fr)" },
    height: "100%",
    minHeight: 0,
  },
  treePane: {
    backgroundColor: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    display: "grid",
    gridTemplateRows: "46px minmax(0, 1fr)",
    minHeight: 0,
  },
  search: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-dim)",
    display: "flex",
    gap: 6,
    height: 32,
    marginInline: 9,
    paddingInline: 9,
  },
  searchInput: {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text)",
    fontSize: 11,
    minWidth: 0,
    outline: "none",
    width: "100%",
  },
  treeScroll: { minHeight: 0, overflow: "auto" },
  viewer: { height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" },
  empty: {
    alignItems: "center",
    background: "var(--bg-raised)",
    color: "var(--text-dim)",
    display: "flex",
    flexDirection: "column",
    fontSize: 12,
    gap: 9,
    height: "100%",
    justifyContent: "center",
  },
  mentionAction: {
    alignItems: "center",
    background: {
      default: "var(--bg-hover)",
      ":hover": "var(--bg-selected)",
    },
    border: "1px solid var(--border-soft)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    fontSize: 11,
    height: 24,
    padding: "0 7px",
  },
})
