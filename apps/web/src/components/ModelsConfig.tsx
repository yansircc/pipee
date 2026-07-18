import { useState, useEffect, useCallback, useRef } from "react"
import { Effect } from "effect"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import { withApi, runApi, runApiStream, runBrowser, type Cancel } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import {
  ModelsConfigJsonError,
  decodeModelsConfig,
  formatModelsConfigJson,
  parseModelsConfigJson,
} from "@/lib/models-config-json"
import {
  ApiKeyProvider as ApiKeyProviderSchema,
  ModelConfigEntry,
  ModelsConfig as ModelsConfigSchema,
  OAuthProvider as OAuthProviderSchema,
  ProviderConfigEntry,
} from "@/api/contract"
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "A",
  openai: "OA",
  "openai-codex": "OA",
  google: "G",
  "google-vertex": "G",
  "ant-ling": "蚂",
  deepseek: "DS",
  groq: "GQ",
  mistral: "M",
  moonshotai: "K",
  "moonshotai-cn": "K",
  moonshot: "K",
  minimax: "MM",
  "minimax-cn": "MM",
  fireworks: "FW",
  huggingface: "HF",
  cerebras: "C",
  openrouter: "OR",
  xai: "X",
  "cloudflare-ai-gateway": "CF",
  "cloudflare-workers-ai": "CF",
  "vercel-ai-gateway": "V",
  "github-copilot": "GH",
  "amazon-bedrock": "AWS",
  "azure-openai-responses": "AZ",
  "kimi-coding": "K",
  nvidia: "NV",
  opencode: "OC",
  "opencode-go": "OC",
  qwen: "Q",
  xiaomi: "MI",
  "xiaomi-token-plan-ams": "MI",
  "xiaomi-token-plan-cn": "MI",
  "xiaomi-token-plan-sgp": "MI",
  zai: "Z",
  "zai-coding-cn": "Z",
  zhipu: "ZP",
  cohere: "CO",
  perplexity: "P",
  together: "TO",
  grok: "GK",
}

// ── Types ─────────────────────────────────────────────────────────────────────

type OAuthProvider = typeof OAuthProviderSchema.Type
type ApiKeyProvider = typeof ApiKeyProviderSchema.Type

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null }
  | {
      phase: "device_code"
      userCode: string
      verificationUri: string
      intervalSeconds: number | null
      expiresInSeconds: number | null
    }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string }

type ModelEntry = typeof ModelConfigEntry.Type
type ProviderEntry = typeof ProviderConfigEntry.Type
type ModelsJson = typeof ModelsConfigSchema.Type
type RawValidationState = "idle" | "validating" | "valid"

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number }

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error)
}

const requirePiValidModelsConfig = (config: ModelsJson) =>
  withApi((api) => api.models.validateConfig({ payload: config })).pipe(
    Effect.flatMap((result) =>
      result.valid
        ? Effect.succeed(config)
        : Effect.fail(new ModelsConfigJsonError({ operation: "decode", message: result.error })),
    ),
  )

const requireValidModelsConfig = (value: unknown) =>
  decodeModelsConfig(value).pipe(Effect.flatMap(requirePiValidModelsConfig))

const parseAndValidateModelsConfig = (source: string) =>
  parseModelsConfigJson(source).pipe(Effect.flatMap(requirePiValidModelsConfig))

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{t(label)}</label>
      {children}
    </div>
  )
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
}

const toolbarButtonStyle = {
  padding: "5px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  whiteSpace: "nowrap" as const,
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  const { t } = useI18n()
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ? t(placeholder) : undefined}
      style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
    />
  )
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  autoComplete?: string
  spellCheck?: boolean
  style?: React.CSSProperties
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!value) setVisible(false)
  }, [value])

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide API key" : "Show API key"}
        title={visible ? "Hide API key" : "Show API key"}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  )
}

function NumInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={inputStyle}
    />
  )
}

function Select({
  value,
  onChange,
  options,
  required,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly string[]
  required?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}
    >
      {!required && <option value="">— inherit / none —</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n()
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        fontSize: 12,
        color: "var(--text-muted)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }}
      />
      {t(label)}
    </label>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 2,
      }}
    >
      {typeof children === "string" ? t(children) : children}
    </div>
  )
}

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({
  name,
  provider,
  onChange,
  onRename,
  onDelete,
}: {
  name: string
  provider: ProviderEntry
  onChange: (p: ProviderEntry) => void
  onRename: (n: string) => void
  onDelete: () => void
}) {
  const [editingName, setEditingName] = useState(name)
  useEffect(() => setEditingName(name), [name])
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v })

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Provider</SectionTitle>
        <button
          onClick={onDelete}
          style={{
            padding: "3px 8px",
            background: "none",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 4,
            color: "#ef4444",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          Delete
        </button>
      </div>

      <Field label="Provider name">
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button
            onClick={() => onRename(editingName.trim())}
            style={{
              marginTop: 4,
              padding: "3px 10px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
              fontSize: 11,
              alignSelf: "flex-start",
            }}
          >
            Rename
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput
          value={provider.baseUrl ?? ""}
          onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1"
          mono
        />
      </Field>

      <Field label="API Key">
        <SecretTextInput
          value={provider.apiKey ?? ""}
          onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key"
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Prefix with <code style={{ fontFamily: "var(--font-mono)" }}>!</code> to run a shell command, or use an env
          var name
        </span>
      </Field>

      <Field label="API">
        <Select
          value={provider.api ?? "openai-completions"}
          onChange={(v) => set("api", v)}
          options={API_OPTIONS}
          required
        />
      </Field>
    </div>
  )
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
const OMIT_THINKING_LEVEL = Symbol("omit-thinking-level")

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off: "var(--text-dim)",
  minimal: "#6b7280",
  low: "#60a5fa",
  medium: "#a78bfa",
  high: "#f472b6",
  xhigh: "#fb923c",
  max: "#ef4444",
}

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined
  onChange: (v: Record<string, string | null> | undefined) => void
}) {
  const map = value ?? {}

  const setLevel = (level: ThinkingLevel, entry: string | null | typeof OMIT_THINKING_LEVEL) => {
    const next = { ...map }
    if (entry === OMIT_THINKING_LEVEL) {
      delete next[level]
    } else {
      next[level] = entry
    }
    onChange(Object.keys(next).length ? next : undefined)
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level]
        const state: "omit" | "null" | "string" = !(level in map) ? "omit" : raw === null ? "null" : "string"
        const strVal = typeof raw === "string" ? raw : ""
        const color = LEVEL_COLORS[level]

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        }
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
        }
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        }

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  flexShrink: 0,
                  opacity: state === "null" ? 0.3 : 1,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                  textDecoration: state === "null" ? "line-through" : "none",
                }}
              >
                {level}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: "1px solid var(--border)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setLevel(level, OMIT_THINKING_LEVEL)}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                Default
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{
                  ...btnBase,
                  borderLeft: "1px solid var(--border)",
                  ...(state === "null" ? btnActiveDisabled : {}),
                }}
              >
                Disabled
              </button>
            </div>

            {/* Custom button + input fused */}
            <div
              style={{
                display: "flex",
                borderRadius: 5,
                border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`,
                overflow: "hidden",
                transition: "border-color 0.1s",
              }}
            >
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{
                  ...btnBase,
                  ...(state === "string" ? btnActive : {}),
                  borderRight: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              >
                Custom
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => {
                  if (state !== "string") setLevel(level, strVal || level)
                }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek"
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...model.compat, ...DEEPSEEK_COMPAT } }
  }
  if (!model.compat) return model
  const rest = { ...model.compat }
  delete rest.thinkingFormat
  delete rest.requiresReasoningContentOnAssistantMessages
  return { ...model, compat: Object.keys(rest).length ? rest : undefined }
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string
  provider: ProviderEntry
  model: ModelEntry
  onChange: (m: ModelEntry) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" })
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v })
  type CostRate = "input" | "output" | "cacheRead" | "cacheWrite"
  const costVal = (k: CostRate) => (model.cost?.[k] !== undefined ? String(model.cost[k]) : "")
  const setCost = (k: CostRate, v: string) => {
    const n = parseFloat(v)
    onChange({
      ...model,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
        ...(model.cost?.tiers === undefined ? {} : { tiers: model.cost.tiers }),
        [k]: isNaN(n) ? 0 : n,
      },
    })
  }
  const testSummary = (() => {
    if (testState.phase === "idle") return null
    if (testState.phase === "testing") return "Testing model connection..."
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean)
    if (testState.phase === "success") {
      return ["Connected", ...meta, testState.responseText || null].filter(Boolean).join(" · ")
    }
    return ["Failed", ...meta, testState.message].filter(Boolean).join(" · ")
  })()

  useEffect(() => {
    setTestState({ phase: "idle" })
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api])

  const handleTest = useCallback(() => {
    if (!model.id.trim() || testState.phase === "testing") return
    setTestState({ phase: "testing" })
    runApi(
      withApi((api) => api.models.testConfig({ payload: { providerName, provider, model } })),
      {
        onSuccess: (result) => {
          if (!result.ok) {
            setTestState({
              phase: "error",
              message: result.error ?? "Model connection failed",
              latencyMs: result.latencyMs,
              status: result.status,
            })
            return
          }
          setTestState({
            phase: "success",
            latencyMs: result.latencyMs,
            status: result.status,
            responseText: result.responseText,
          })
        },
        onFailure: (error) => setTestState({ phase: "error", message: errorMessage(error) }),
      },
    )
  }, [model, provider, providerName, testState.phase])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Model</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background:
                  testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <button
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("Test model connection")}
            style={{
              height: 24,
              padding: "0 8px",
              background: testState.phase === "success" ? "#16a34a" : "none",
              border: `1px solid ${testState.phase === "success" ? "#16a34a" : "var(--border)"}`,
              borderRadius: 4,
              color:
                testState.phase === "success"
                  ? "#fff"
                  : !model.id.trim() || testState.phase === "testing"
                    ? "var(--text-dim)"
                    : "var(--text-muted)",
              cursor: !model.id.trim() || testState.phase === "testing" ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "success" && (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing" ? "Testing…" : testState.phase === "success" ? "OK" : "Test"}
          </button>
          <button
            onClick={onDelete}
            style={{
              height: 24,
              padding: "0 8px",
              background: "none",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 4,
              color: "#ef4444",
              cursor: "pointer",
              fontSize: 11,
              boxSizing: "border-box",
            }}
          >
            Remove
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="ID *">
          <TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono />
        </Field>
        <Field label="Name">
          <TextInput
            value={model.name ?? ""}
            onChange={(v) => set("name", v || undefined)}
            placeholder="Display name"
          />
        </Field>
      </div>

      <Field label="API override">
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check
          label="Reasoning / thinking"
          checked={model.reasoning ?? false}
          onChange={(v) => set("reasoning", v || undefined)}
        />
        <Check
          label="Image input"
          checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)}
        />
      </div>

      {model.reasoning && (
        <>
          <Check
            label="DeepSeek thinking compat"
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>Thinking level map</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                >
                  clear all
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor value={model.thinkingLevelMap} onChange={(v) => set("thinkingLevelMap", v)} />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Context window (tokens)">
          <NumInput
            value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)}
            placeholder="128000"
          />
        </Field>
        <Field label="Max output tokens">
          <NumInput
            value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)}
            placeholder="16384"
          />
        </Field>
      </div>

      <div>
        <SectionTitle>Cost (per million tokens)</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={k}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const { t } = useI18n()
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" })
  const [inputValue, setInputValue] = useState("")
  const cancelLoginRef = useRef<Cancel | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (loginState.phase !== "auth" && loginState.phase !== "prompt") return
    const input = inputRef.current
    if (!input) return
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.focusAfter(input, "50 millis"))), {
      onSuccess: () => undefined,
    })
  }, [loginState.phase])

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" })
    setInputValue("")
    cancelLoginRef.current?.()
    cancelLoginRef.current = null
  }, [provider.id])

  useEffect(() => {
    return () => {
      cancelLoginRef.current?.()
    }
  }, [])

  const handleLogin = useCallback(() => {
    cancelLoginRef.current?.()
    setLoginState({ phase: "connecting" })
    setInputValue("")
    cancelLoginRef.current = runApiStream(
      withApi((api) => api.auth.oauthEvents({ params: { provider: provider.id } })),
      {
        onValue: (event) => {
          switch (event._tag) {
            case "Auth":
              setLoginState({ phase: "auth", url: event.url, instructions: event.instructions })
              runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.openExternal(event.url))), {
                onSuccess: () => undefined,
              })
              break
            case "DeviceCode":
              setLoginState({
                phase: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds,
                expiresInSeconds: event.expiresInSeconds,
              })
              runBrowser(
                BrowserPlatform.pipe(Effect.flatMap((browser) => browser.openExternal(event.verificationUri))),
                { onSuccess: () => undefined },
              )
              break
            case "Prompt":
              setLoginState({
                phase: "prompt",
                message: event.message,
                placeholder: event.placeholder,
                token: event.token,
              })
              break
            case "Select":
              setLoginState({
                phase: "select",
                message: event.message,
                options: [...event.options],
                token: event.token,
              })
              break
            case "Progress":
              setLoginState({ phase: "progress", message: event.message })
              break
            case "Succeeded":
              cancelLoginRef.current?.()
              cancelLoginRef.current = null
              setLoginState({ phase: "success" })
              onRefresh()
              break
            case "Failed":
              cancelLoginRef.current?.()
              cancelLoginRef.current = null
              setLoginState({ phase: "error", message: event.message })
              break
            case "Cancelled":
              cancelLoginRef.current?.()
              cancelLoginRef.current = null
              setLoginState({ phase: "idle" })
              break
          }
        },
        onFailure: (error) => setLoginState({ phase: "error", message: errorMessage(error) }),
      },
    )
  }, [provider.id, onRefresh])

  const handleLogout = useCallback(() => {
    runApi(
      withApi((api) => api.auth.logout({ params: { provider: provider.id }, payload: {} })),
      {
        onSuccess: () => {
          setLoginState({ phase: "idle" })
          onRefresh()
        },
        onFailure: (error) => setLoginState({ phase: "error", message: errorMessage(error) }),
      },
    )
  }, [provider.id, onRefresh])

  const submitCode = useCallback(
    (token: string, code: string) => {
      if (!code.trim()) return
      setLoginState({ phase: "progress", message: "Verifying…" })
      runApi(
        withApi((api) =>
          api.auth.submitOAuthInput({
            params: { provider: provider.id },
            payload: { token, code: code.trim() },
          }),
        ),
        {
          onSuccess: () => setInputValue(""),
          onFailure: (error) => setLoginState({ phase: "error", message: errorMessage(error) }),
        },
      )
    },
    [provider.id],
  )

  const submitSelection = useCallback(
    (token: string, value: string) => {
      setLoginState({ phase: "progress", message: "Continuing…" })
      runApi(
        withApi((api) =>
          api.auth.submitOAuthInput({
            params: { provider: provider.id },
            payload: { token, code: value },
          }),
        ),
        {
          onSuccess: () => undefined,
          onFailure: (error) => setLoginState({ phase: "error", message: errorMessage(error) }),
        },
      )
    },
    [provider.id],
  )

  const isWorking =
    loginState.phase === "connecting" ||
    loginState.phase === "progress" ||
    loginState.phase === "device_code" ||
    loginState.phase === "prompt" ||
    loginState.phase === "select"

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Subscription</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.loggedIn ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
            {provider.loggedIn ? "connected" : "not connected"}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn
              ? "Already connected. You can re-login or disconnect."
              : `Connect your ${provider.name} account.`}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("Opening browser…")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{
                    padding: "6px 9px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 12,
                    textAlign: "left",
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {loginState.phase === "auth" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.instructions ?? "Complete sign-in in the browser."}
            </p>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              If the browser window did not open,{" "}
              <a
                href={loginState.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", wordBreak: "break-all" }}
              >
                click here to open the login page
              </a>
              .
            </p>
          </div>
        )}
        {loginState.phase === "prompt" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.message}</p>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCode(loginState.token, inputValue)
                }}
                placeholder={loginState.placeholder ?? "Enter value…"}
                style={{
                  flex: 1,
                  padding: "6px 9px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text)",
                  fontSize: 12,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{
                  padding: "6px 12px",
                  background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)",
                  border: "none",
                  borderRadius: 5,
                  color: inputValue.trim() ? "#fff" : "var(--text-dim)",
                  cursor: inputValue.trim() ? "pointer" : "not-allowed",
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                Submit
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Open the verification page and enter this code:
            </p>
            <div
              style={{
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
                letterSpacing: 0,
              }}
            >
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a
                href={loginState.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", wordBreak: "break-all" }}
              >
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` Expires in ${Math.ceil(loginState.expiresInSeconds / 60)} minutes.` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{t("Connected successfully.")}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={() => {
              cancelLoginRef.current?.()
              cancelLoginRef.current = null
              setLoginState({ phase: "idle" })
            }}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              onClick={handleLogin}
              style={{
                padding: "5px 14px",
                background: "var(--accent)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {provider.loggedIn ? "Re-login" : "Login"}
            </button>
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{
                  padding: "5px 12px",
                  background: "none",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 5,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const dismissSavedRef = useRef<Cancel | null>(null)

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("")
    setError(null)
    setSavedOk(false)
    dismissSavedRef.current?.()
    dismissSavedRef.current = null
  }, [provider.id])

  useEffect(() => () => dismissSavedRef.current?.(), [])

  const handleSave = useCallback(() => {
    if (!apiKey.trim()) return
    setSaving(true)
    setError(null)
    setSavedOk(false)
    runApi(
      withApi((api) => api.auth.setApiKey({ params: { provider: provider.id }, payload: { apiKey: apiKey.trim() } })),
      {
        onSuccess: () => {
          setApiKey("")
          setSavedOk(true)
          dismissSavedRef.current?.()
          dismissSavedRef.current = runApi(Effect.sleep("2 seconds"), {
            onSuccess: () => setSavedOk(false),
          })
          setSaving(false)
          onRefresh()
        },
        onFailure: (cause) => {
          setError(errorMessage(cause))
          setSaving(false)
        },
      },
    )
  }, [apiKey, provider.id, onRefresh])

  const handleRemove = useCallback(() => {
    setRemoving(true)
    setError(null)
    runApi(
      withApi((api) => api.auth.removeApiKey({ params: { provider: provider.id } })),
      {
        onSuccess: () => {
          setRemoving(false)
          onRefresh()
        },
        onFailure: (cause) => {
          setError(errorMessage(cause))
          setRemoving(false)
        },
      },
    )
  }, [provider.id, onRefresh])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>API Key</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.configured ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
            {provider.configured ? "configured" : "not configured"}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? `API key is stored. Enter a new key below to replace it, or disconnect to remove it.`
          : `Enter your ${provider.displayName} API key to enable ${provider.modelCount} model${provider.modelCount !== 1 ? "s" : ""}.`}
      </p>

      <Field label="API Key">
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) handleSave()
            }}
            placeholder={provider.configured ? "Enter new key to replace…" : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none",
              borderRadius: 5,
              color: apiKey.trim() || savedOk ? "#fff" : "var(--text-dim)",
              cursor: saving || !apiKey.trim() || savedOk ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {savedOk && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {savedOk ? "Saved" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

      {provider.configured && (
        <button
          onClick={handleRemove}
          disabled={removing}
          style={{
            alignSelf: "flex-start",
            padding: "5px 12px",
            background: "none",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 5,
            color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {removing ? "Removing…" : "Disconnect"}
        </button>
      )}
    </div>
  )
}

// ── Provider badge ────────────────────────────────────────────────────────────

function ProviderBadge({ id, size }: { id: string; size: number }) {
  const label =
    PROVIDER_LABELS[id] ??
    (id
      .split(/[-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() ||
      "?")
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.36)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  )
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: ReadonlyArray<OAuthProvider>
  apiKeyProviders: ReadonlyArray<ApiKeyProvider>
  onSelectOAuth: (id: string) => void
  onSelectApiKey: (id: string) => void
  onAddCustom: () => void
  onClose: () => void
}

function AddProviderPicker({
  oauthProviders,
  apiKeyProviders,
  onSelectOAuth,
  onSelectApiKey,
  onAddCustom,
  onClose,
}: AddProviderPickerProps) {
  const { t } = useI18n()
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.focusAfter(input, "30 millis"))), {
      onSuccess: () => undefined,
    })
  }, [])

  const q = search.trim().toLowerCase()

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)))
  const availableApiKey = apiKeyProviders.filter(
    (p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
  )
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q)

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0)

  const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: 820,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "min(72vh, calc(100vh - 32px))",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {/* Search */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
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
            style={{ color: "var(--text-dim)", flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose()
            }}
            placeholder={t("Search providers…")}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
              {t("No providers match")}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
                gap: 8,
              }}
            >
              {showCustom && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("Custom")}
                </div>
              )}
              {showCustom && (
                <button
                  onClick={() => {
                    onAddCustom()
                    onClose()
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)"
                    e.currentTarget.style.background = "var(--bg-hover)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)"
                    e.currentTarget.style.background = "var(--bg-panel)"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("OpenAI / Anthropic compatible")}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {t("Custom endpoint format")}
                    </div>
                  </div>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 5,
                      background: "var(--bg-hover)",
                      border: "1px dashed var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
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
                      style={{ color: "var(--text-dim)" }}
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    paddingTop: showCustom ? 6 : 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("Subscriptions")}
                </div>
              )}
              {availableOAuth.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectOAuth(p.id)
                    onClose()
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)"
                    e.currentTarget.style.background = "var(--bg-hover)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)"
                    e.currentTarget.style.background = "var(--bg-panel)"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.name}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderBadge id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    paddingTop: availableOAuth.length > 0 ? 6 : 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                  }}
                >
                  {t("API Key")}
                </div>
              )}
              {availableApiKey.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onSelectApiKey(p.id)
                    onClose()
                  }}
                  style={cardStyle}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)"
                    e.currentTarget.style.background = "var(--bg-hover)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)"
                    e.currentTarget.style.background = "var(--bg-panel)"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.displayName}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{p.modelCount} models</div>
                  </div>
                  <ProviderBadge id={p.id} size={28} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [config, setConfig] = useState<ModelsJson>({ providers: {} })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const dismissSavedRef = useRef<Cancel | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [oauthProviders, setOauthProviders] = useState<ReadonlyArray<OAuthProvider>>([])
  const [apiKeyProviders, setApiKeyProviders] = useState<ReadonlyArray<ApiKeyProvider>>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rawMode, setRawMode] = useState(false)
  const [rawSource, setRawSource] = useState("")
  const [rawValidation, setRawValidation] = useState<RawValidationState>("idle")
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => () => dismissSavedRef.current?.(), [])

  const loadOAuthProviders = useCallback(() => {
    runApi(
      withApi((api) => api.auth.oauthProviders({})),
      {
        onSuccess: ({ providers }) => setOauthProviders(providers),
      },
    )
  }, [])

  const loadApiKeyProviders = useCallback(() => {
    runApi(
      withApi((api) => api.auth.apiKeyProviders({})),
      {
        onSuccess: ({ providers }) => setApiKeyProviders(providers),
      },
    )
  }, [])

  const replaceConfig = useCallback((value: ModelsJson) => {
    setConfig(value)
    const firstProvider = Object.keys(value.providers)[0]
    setSelection(firstProvider === undefined ? null : { type: "provider", name: firstProvider })
  }, [])

  useEffect(() => {
    const cancel = runApi(
      withApi((api) => api.models.config({})),
      {
        onSuccess: (value) => {
          replaceConfig(value)
          setLoading(false)
        },
        onFailure: () => {
          setConfig({ providers: {} })
          setLoading(false)
        },
      },
    )
    loadOAuthProviders()
    loadApiKeyProviders()
    return cancel
  }, [loadOAuthProviders, loadApiKeyProviders, replaceConfig])

  const openRawEditor = useCallback(() => {
    setSaveError(null)
    setNotice(null)
    runApi(formatModelsConfigJson(config), {
      onSuccess: (source) => {
        setRawSource(source)
        setRawValidation("idle")
        setRawMode(true)
      },
      onFailure: (cause) => setSaveError(errorMessage(cause)),
    })
  }, [config])

  const validateRawEditor = useCallback(() => {
    setRawValidation("validating")
    setSaveError(null)
    setNotice(null)
    runApi(parseAndValidateModelsConfig(rawSource), {
      onSuccess: (value) => {
        replaceConfig(value)
        setRawValidation("valid")
        setNotice(t("Valid configuration"))
      },
      onFailure: (cause) => {
        setRawValidation("idle")
        setSaveError(errorMessage(cause))
      },
    })
  }, [rawSource, replaceConfig, t])

  const importModelsConfig = useCallback(
    (file: File) => {
      setSaveError(null)
      setNotice(null)
      runBrowser(
        BrowserPlatform.pipe(
          Effect.flatMap((browser) => browser.readTextFile(file)),
          Effect.flatMap(parseAndValidateModelsConfig),
        ),
        {
          onSuccess: (value) => {
            replaceConfig(value)
            setRawMode(false)
            setRawValidation("idle")
            setNotice(t("Imported and validated. Save to apply."))
          },
          onFailure: (cause) => setSaveError(errorMessage(cause)),
        },
      )
    },
    [replaceConfig, t],
  )

  const exportModelsConfig = useCallback(() => {
    setSaveError(null)
    setNotice(null)
    runBrowser(
      requireValidModelsConfig(config).pipe(
        Effect.flatMap(formatModelsConfigJson),
        Effect.flatMap((source) =>
          BrowserPlatform.pipe(
            Effect.flatMap((browser) => browser.downloadTextFile("models.json", source, "application/json")),
          ),
        ),
      ),
      {
        onSuccess: () => setNotice(t("Exported validated configuration")),
        onFailure: (cause) => setSaveError(errorMessage(cause)),
      },
    )
  }, [config, t])

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider"
    let n = 1
    while (config.providers[finalName]) finalName = `new-provider-${n++}`
    setConfig((prev) => ({
      ...prev,
      providers: { ...prev.providers, [finalName]: { api: "openai-completions" } },
    }))
    setSelection({ type: "provider", name: finalName })
  }, [config.providers])

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...prev.providers, [name]: p } }))
  }, [])

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers)
      const idx = entries.findIndex(([k]) => k === oldName)
      if (idx === -1) return prev
      entries[idx] = [newName, entries[idx][1]]
      return { ...prev, providers: Object.fromEntries(entries) }
    })
    setSelection((prev) => {
      if (!prev) return prev
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName }
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName }
      return prev
    })
  }, [])

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...prev.providers }
      delete providers[name]
      return { ...prev, providers }
    })
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers)
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null)
      return prev
    })
  }, [])

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers[providerName] ?? {}
      const models = [...(provider.models ?? []), { id: "" }]
      return { ...prev, providers: { ...prev.providers, [providerName]: { ...provider, models } } }
    })
    setConfig((prev) => {
      const idx = (prev.providers[providerName]?.models?.length ?? 1) - 1
      setSelection({ type: "model", providerName, index: idx })
      return prev
    })
  }, [])

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers[providerName] ?? {}
      const models = [...(provider.models ?? [])]
      models[index] = m
      return { ...prev, providers: { ...prev.providers, [providerName]: { ...provider, models } } }
    })
  }, [])

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers[providerName] ?? {}
      const models = [...(provider.models ?? [])]
      models.splice(index, 1)
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [providerName]: { ...provider, models: models.length ? models : undefined },
        },
      }
    })
    setSelection({ type: "provider", name: providerName })
  }, [])

  const handleSave = useCallback(() => {
    setSaving(true)
    setSaveError(null)
    setNotice(null)
    setSavedOk(false)
    runApi(
      requireValidModelsConfig(config).pipe(
        Effect.flatMap((validated) => withApi((api) => api.models.saveConfig({ payload: validated }))),
      ),
      {
        onSuccess: () => {
          setSaving(false)
          setSavedOk(true)
          dismissSavedRef.current?.()
          dismissSavedRef.current = runApi(Effect.sleep("2 seconds"), {
            onSuccess: () => setSavedOk(false),
          })
        },
        onFailure: (cause) => {
          setSaving(false)
          setSaveError(errorMessage(cause))
        },
      },
    )
  }, [config])

  const providers = Object.entries(config.providers)
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn)
  const activeApiKey = apiKeyProviders.filter((p) => p.configured)
  const rawDraftPending = rawMode && rawValidation !== "valid"
  const saveDisabled = saving || savedOk || rawDraftPending

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId)
      if (!p) return null
      return <OAuthDetail key={p.id} provider={p} onRefresh={loadOAuthProviders} />
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId)
      if (!p) return null
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={loadApiKeyProviders} />
    }
    if (selection.type === "provider") {
      const provider = config.providers[selection.name]
      if (!provider) return null
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
        />
      )
    }
    const provider = config.providers[selection.providerName]
    const model = provider?.models?.[selection.index]
    if (!model) return null
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    )
  })()

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          style={{
            width: isMobile ? "calc(100vw - 16px)" : 860,
            maxWidth: "calc(100vw - 16px)",
            height: isMobile ? "calc(100dvh - 16px)" : "78vh",
            maxHeight: "calc(100dvh - 16px)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("Models")}</span>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  display: isMobile ? "none" : undefined,
                }}
              >
                ~/.pi/agent/models.json
              </code>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flex: 1 }}>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ""
                  if (file !== undefined) importModelsConfig(file)
                }}
              />
              <button onClick={() => importInputRef.current?.click()} style={toolbarButtonStyle}>
                {t("Import")}
              </button>
              <button
                onClick={exportModelsConfig}
                disabled={rawDraftPending}
                style={{
                  ...toolbarButtonStyle,
                  cursor: rawDraftPending ? "default" : toolbarButtonStyle.cursor,
                  opacity: rawDraftPending ? 0.5 : 1,
                }}
              >
                {t("Export")}
              </button>
              <button
                onClick={() => {
                  if (rawMode) setRawMode(false)
                  else openRawEditor()
                }}
                style={{
                  ...toolbarButtonStyle,
                  color: rawMode ? "var(--accent)" : toolbarButtonStyle.color,
                  borderColor: rawMode ? "var(--accent)" : "var(--border)",
                }}
              >
                {t(rawMode ? "Back to form" : "Raw JSON")}
              </button>
            </div>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
            {/* Left: tree */}
            <div
              style={{
                width: isMobile ? "100%" : 210,
                maxHeight: isMobile ? "40vh" : undefined,
                borderRight: isMobile ? "none" : "1px solid var(--border)",
                borderBottom: isMobile ? "1px solid var(--border)" : "none",
                display: "flex",
                flexDirection: "column",
                flexShrink: 0,
                background: "var(--bg-panel)",
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
                {/* Active OAuth subscriptions */}
                {activeOAuth.map((p) => {
                  const isSelected = selection?.type === "oauth" && selection.providerId === p.id
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none"
                      }}
                    >
                      <ProviderBadge id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.name}
                      </span>
                    </div>
                  )
                })}

                {/* Active API key providers */}
                {activeApiKey.map((p) => {
                  const isSelected = selection?.type === "apikey" && selection.providerId === p.id
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none"
                      }}
                    >
                      <ProviderBadge id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.displayName}
                      </span>
                    </div>
                  )
                })}

                {/* Divider before custom providers, only when there are active managed providers */}
                {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                  <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
                )}

                {/* Custom providers */}
                {loading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{t("Loading…")}</div>
                ) : (
                  providers.map(([pName, pData]) => {
                    const isProviderSelected = selection?.type === "provider" && selection.name === pName
                    const models = pData.models ?? []
                    return (
                      <div key={pName} style={{ marginBottom: 2 }}>
                        {/* Provider row */}
                        <div
                          onClick={() => setSelection({ type: "provider", name: pName })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "7px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isProviderSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "var(--bg-hover)"
                          }}
                          onMouseLeave={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "none"
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
                            style={{ color: "var(--text-dim)", flexShrink: 0 }}
                          >
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <rect x="9" y="9" width="6" height="6" />
                            <line x1="9" y1="1" x2="9" y2="4" />
                            <line x1="15" y1="1" x2="15" y2="4" />
                            <line x1="9" y1="20" x2="9" y2="23" />
                            <line x1="15" y1="20" x2="15" y2="23" />
                            <line x1="20" y1="9" x2="23" y2="9" />
                            <line x1="20" y1="14" x2="23" y2="14" />
                            <line x1="1" y1="9" x2="4" y2="9" />
                            <line x1="1" y1="14" x2="4" y2="14" />
                          </svg>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: isProviderSelected ? 600 : 400,
                              color: "var(--text)",
                              fontFamily: "var(--font-mono)",
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {pName}
                          </span>
                        </div>

                        {/* Model rows */}
                        {models.map((m, i) => {
                          const isModelSelected =
                            selection?.type === "model" && selection.providerName === pName && selection.index === i
                          return (
                            <div
                              key={i}
                              onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "5px 8px 5px 26px",
                                borderRadius: 5,
                                cursor: "pointer",
                                background: isModelSelected ? "var(--bg-selected)" : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "var(--bg-hover)"
                              }}
                              onMouseLeave={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "none"
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                  color: m.id ? "var(--text-muted)" : "var(--text-dim)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {m.id || t("new model")}
                              </span>
                              {m.reasoning && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    padding: "1px 4px",
                                    background: "rgba(99,102,241,0.12)",
                                    color: "rgba(99,102,241,0.8)",
                                    borderRadius: 3,
                                    flexShrink: 0,
                                  }}
                                >
                                  T
                                </span>
                              )}
                            </div>
                          )
                        })}

                        {/* Add model button */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation()
                            addModel(pName)
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 8px 4px 26px",
                            borderRadius: 5,
                            cursor: "pointer",
                            color: "var(--text-dim)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)"
                            e.currentTarget.style.background = "var(--bg-hover)"
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = "var(--text-dim)"
                            e.currentTarget.style.background = "none"
                          }}
                        >
                          <span style={{ fontSize: 11 }}>{t("+ model")}</span>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Add provider */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "8px 6px" }}>
                <button
                  onClick={() => setPickerOpen(true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    width: "100%",
                    padding: "6px 0",
                    background: "none",
                    border: "1px dashed var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)"
                    e.currentTarget.style.color = "var(--accent)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)"
                    e.currentTarget.style.color = "var(--text-muted)"
                  }}
                >
                  {t("+ Add provider")}
                </button>
              </div>
            </div>

            {/* Right: detail */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {loading ? null : rawMode ? (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("Raw models JSON")}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {t("Validate the JSON before saving. Invalid content never replaces models.json.")}
                  </div>
                  <textarea
                    aria-label={t("Raw models JSON")}
                    value={rawSource}
                    spellCheck={false}
                    onChange={(event) => {
                      setRawSource(event.target.value)
                      setRawValidation("idle")
                      setSaveError(null)
                      setNotice(null)
                    }}
                    style={{
                      flex: 1,
                      minHeight: 280,
                      resize: "none",
                      padding: 12,
                      border: `1px solid ${rawValidation === "valid" ? "#16a34a" : "var(--border)"}`,
                      borderRadius: 6,
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.5,
                      outline: "none",
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                    {rawValidation === "valid" && (
                      <span style={{ color: "#16a34a", fontSize: 11, marginRight: "auto" }}>
                        {t("Valid configuration")}
                      </span>
                    )}
                    <button
                      onClick={validateRawEditor}
                      disabled={rawValidation === "validating"}
                      style={toolbarButtonStyle}
                    >
                      {t(rawValidation === "validating" ? "Validating…" : "Validate")}
                    </button>
                  </div>
                </div>
              ) : (
                (detailContent ?? (
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-dim)",
                      fontSize: 13,
                    }}
                  >
                    {t("Select a provider or model")}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 10,
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {saveError && <div style={{ fontSize: 12, color: "#f87171" }}>{saveError}</div>}
              {!saveError && notice && <div style={{ fontSize: 12, color: "#16a34a" }}>{notice}</div>}
            </div>
            <button
              onClick={onClose}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t("Cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={saveDisabled}
              style={{
                position: "relative",
                padding: "6px 16px",
                minWidth: 92,
                background: savedOk ? "#16a34a" : saveDisabled ? "var(--bg-panel)" : "var(--accent)",
                border: "none",
                borderRadius: 6,
                color: savedOk ? "#fff" : saveDisabled ? "var(--text-muted)" : "#fff",
                cursor: saveDisabled ? "default" : "pointer",
                fontSize: 13,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                transition: "background-color 0.2s ease, color 0.2s ease",
                animation: savedOk ? "saved-pop 0.45s ease" : undefined,
              }}
            >
              {savedOk && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
              <span>{t(savedOk ? "Saved" : saving ? "Saving…" : "Save")}</span>
            </button>
          </div>
        </div>
      </div>
      {pickerOpen && (
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
          onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
          onAddCustom={addCustomProvider}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}
