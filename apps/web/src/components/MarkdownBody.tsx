import { Children, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react"
import { Effect } from "effect"
import ReactMarkdown from "react-markdown"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism"
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism"
import { useTheme } from "@/hooks/useTheme"
import { copyText } from "@/lib/clipboard"
import { resolveLocalFileHref } from "@/lib/file-links"
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown"
import { useI18n } from "@/lib/i18n"
import { runBrowser } from "@/browser/api-client"
import { renderMermaid } from "@/features/markdown/mermaid-controller"

interface MarkdownBodyProps {
  children: string
  className?: string
  isStreaming?: boolean
  cwd?: string
  onOpenFile?: (filePath: string) => void
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children])

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={{
          code({ className, children, ...props }) {
            const lang = className?.replace("language-", "").toLowerCase() ?? ""
            const raw = Children.toArray(children)
              .filter((child): child is string | number => typeof child === "string" || typeof child === "number")
              .join("")
            const isBlock = className?.includes("language-") || raw.includes("\n")
            if (isBlock) {
              if (lang === "mermaid") {
                return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />
              }
              return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />
            }
            return (
              <code className="markdown-inline-code" {...props}>
                {children}
              </code>
            )
          },
          pre({ children }) {
            return <>{children}</>
          },
          a({ href, children, ...props }) {
            const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null
            const openFile = onOpenFile
            if (!filePath || !openFile) {
              return (
                <a href={href} {...props}>
                  {children}
                </a>
              )
            }

            const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.defaultPrevented || event.button !== 0) return
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              const target = event.currentTarget.getAttribute("target")
              if (target && target !== "_self") return
              event.preventDefault()
              openFile(filePath)
            }

            return (
              <a href={href} {...props} onClick={handleClick}>
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="markdown-table-wrap">
                <table>{children}</table>
              </div>
            )
          },
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  )
}

function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n"
  const lines = markdown.split(/\r?\n/)
  let fence: { marker: string; size: number } | null = null

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fenceMatch) {
        const marker = fenceMatch[1][0]
        const size = fenceMatch[1].length
        if (!fence) fence = { marker, size }
        else if (marker === fence.marker && size >= fence.size) fence = null
        return line
      }

      if (fence) return line

      const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/)
      if (!displayMathMatch) return line

      const math = displayMathMatch[2].trim()
      if (!math) return line

      return `${displayMathMatch[1]}$$${lineBreak}${math}${lineBreak}${displayMathMatch[1]}$$`
    })
    .join(lineBreak)
}

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const [showPreview, setShowPreview] = useState(false)
  const [svg, setSvg] = useState<string | null>(null)
  const [renderedKey, setRenderedKey] = useState("")
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`

  useEffect(() => {
    if (!showPreview || isStreaming) return
    setFailedKey(null)
    return runBrowser(renderMermaid(code, isDark), {
      onSuccess: (result) => {
        setSvg(result.svg)
        setRenderedKey(currentKey)
      },
      onFailure: () => setFailedKey(currentKey),
    })
  }, [code, currentKey, isDark, isStreaming, showPreview])

  const previewButton = (
    <button
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={
        isStreaming
          ? "Preview available after streaming"
          : showPreview
            ? "Show Mermaid source"
            : "Preview Mermaid diagram"
      }
      className={["markdown-code-action", showPreview ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {showPreview ? "Source" : "Preview"}
    </button>
  )

  if (!showPreview || isStreaming) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} />
  }

  const body =
    failedKey === currentKey ? (
      <div className="mermaid-block mermaid-block-error">{t("Invalid Mermaid diagram")}</div>
    ) : !svg || renderedKey !== currentKey ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("Rendering Mermaid diagram")} />
    ) : (
      <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
    )

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  )
}

function CodeBlock({ code, lang, headerAction }: { code: string; lang: string; headerAction?: ReactNode }) {
  const { isDark } = useTheme()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    runBrowser(
      copyText(code).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      { onSuccess: () => undefined },
    )
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button onClick={copy} className="markdown-code-action">
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        language={lang || "text"}
        style={isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
        customStyle={{
          margin: 0,
          padding: "11px 13px",
          fontSize: 12.5,
          lineHeight: 1.62,
          borderRadius: 0,
          background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}
