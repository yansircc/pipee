import { useCallback, useEffect, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { createFileRoute } from "@tanstack/react-router"
import { runApi, withApi } from "@/browser/api-client"

type ZeroYSite = {
  readonly siteId: string
  readonly label: string
  readonly endpoint: string
  readonly grantId: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revoked: boolean
}

export const Route = createFileRoute("/zeroy")({
  component: ZeroYConnections,
})

function ZeroYConnections() {
  const [sites, setSites] = useState<ReadonlyArray<ZeroYSite>>([])
  const [endpoint, setEndpoint] = useState("")
  const [label, setLabel] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [codePairing, setCodePairing] = useState(false)
  const [codeEndpoint, setCodeEndpoint] = useState("")
  const [pairingCode, setPairingCode] = useState("")
  const [codeIntentId, setCodeIntentId] = useState("")
  const [codeState, setCodeState] = useState("")
  const [codeRedirect, setCodeRedirect] = useState(
    "http://127.0.0.1:30141/zeroy/connect/callback",
  )

  const refresh = useCallback(() => {
    setError(null)
    return runApi(
      withApi((api) => api.zeroYConnections.list({})).pipe(
        Effect.map((list) => list.sites),
        Effect.tap((sites) => Effect.sync(() => setSites(sites))),
      ),
      { onSuccess: () => undefined, onFailure: (failure) => setError(String(failure)) },
    )
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const beginPairing = useCallback(() => {
    if (endpoint.trim() === "") return
    setPairing(true)
    setError(null)
    setNotice(null)
    void runApi(
      withApi((api) =>
        api.zeroYConnections.beginPairing({ payload: { endpoint: endpoint.trim(), label: label.trim() || "Pipee" } }),
      ),
      {
        onSuccess: (intent) => {
          setPairing(false)
          setNotice(
            'Authorization URL opened. Complete the flow in WordPress, then click "Finish pairing" after the callback returns.',
          )
          window.open(intent.authorizationUrl, "_blank", "noopener,noreferrer")
        },
        onFailure: (failure) => {
          setPairing(false)
          setError(String(failure))
        },
      },
    )
  }, [endpoint, label])

  const revoke = useCallback(
    (siteId: string) => {
      setError(null)
      void runApi(
        withApi((api) => api.zeroYConnections.revoke({ params: { siteId } })),
        {
          onSuccess: () => void refresh(),
          onFailure: (failure) => setError(String(failure)),
        },
      )
    },
    [refresh],
  )

  const pairWithCode = useCallback(
    () => {
      if (codeEndpoint.trim() === "" || pairingCode.trim() === "") return
      setCodePairing(true)
      setError(null)
      setNotice(null)
      void runApi(
        withApi((api) =>
          api.zeroYConnections.pairWithCode({
            payload: {
              endpoint: codeEndpoint.trim(),
              intentId: codeIntentId.trim(),
              code: pairingCode.trim(),
              state: codeState.trim(),
              redirectUri:
                codeRedirect.trim() || "http://127.0.0.1:30141/zeroy/connect/callback",
              label: label.trim() || "Pipee",
            },
          }),
        ),
        {
          onSuccess: () => {
            setCodePairing(false)
            setPairingCode("")
            setNotice("Site connected with the pairing code.")
            void refresh()
          },
          onFailure: (failure) => {
            setCodePairing(false)
            setError(String(failure))
          },
        },
      )
    },
    [codeEndpoint, pairingCode, codeIntentId, codeState, codeRedirect, label, refresh],
  )

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>zeroY connections</h1>
      <p {...stylex.props(styles.subtitle)}>
        Connect WordPress sites to Pipee. The connection is stored in the Pipee connection directory and can be revoked
        at any time.
      </p>

      {error !== null && <div {...stylex.props(styles.error)}>{error}</div>}
      {notice !== null && <div {...stylex.props(styles.notice)}>{notice}</div>}

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(styles.sectionTitle)}>Add a WordPress site</h2>
        <div {...stylex.props(styles.form)}>
          <input
            {...stylex.props(styles.input)}
            placeholder="Site URL, e.g. https://example.com"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <input
            {...stylex.props(styles.input)}
            placeholder="Label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button
            {...stylex.props(styles.primaryButton)}
            disabled={endpoint.trim() === "" || pairing}
            onClick={beginPairing}
          >
            {pairing ? "Pairing…" : "Connect WordPress site"}
          </button>
        </div>
        <p {...stylex.props(styles.hint)}>
          You will be taken to the WordPress authorization page. After approving, the callback returns to Pipee and the
          site appears here.
        </p>
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(styles.sectionTitle)}>Pair with a code</h2>
        <p {...stylex.props(styles.hint)}>
          If the browser cannot return to Pipee (or Pipee is not on its default port), create a pairing code in
          WordPress (zeroY → Connections → Create pairing code) and enter it here. The code is single-use and expires
          in 10 minutes.
        </p>
        <div {...stylex.props(styles.form)}>
          <input
            {...stylex.props(styles.input)}
            placeholder="Site URL, e.g. https://example.com"
            value={codeEndpoint}
            onChange={(event) => setCodeEndpoint(event.target.value)}
          />
          <input
            {...stylex.props(styles.input)}
            placeholder="Pairing code"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
          />
          <input
            {...stylex.props(styles.input)}
            placeholder="Intent id (optional)"
            value={codeIntentId}
            onChange={(event) => setCodeIntentId(event.target.value)}
          />
          <input
            {...stylex.props(styles.input)}
            placeholder="State (optional)"
            value={codeState}
            onChange={(event) => setCodeState(event.target.value)}
          />
          <input
            {...stylex.props(styles.input)}
            placeholder="Pipee callback URL"
            value={codeRedirect}
            onChange={(event) => setCodeRedirect(event.target.value)}
          />
          <button
            {...stylex.props(styles.primaryButton)}
            disabled={codeEndpoint.trim() === "" || pairingCode.trim() === "" || codePairing}
            onClick={pairWithCode}
          >
            {codePairing ? "Pairing…" : "Pair with code"}
          </button>
        </div>
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(styles.sectionTitle)}>Connected sites</h2>
        {sites.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No connected sites yet.</p>
        ) : (
          <ul {...stylex.props(styles.list)}>
            {sites.map((site) => (
              <li key={site.siteId} {...stylex.props(styles.item)}>
                <div {...stylex.props(styles.itemInfo)}>
                  <strong>{site.label}</strong>
                  <span {...stylex.props(styles.itemEndpoint)}>{site.endpoint}</span>
                  <span {...stylex.props(styles.itemMeta)}>
                    {site.revoked ? "revoked" : "connected"} · created {site.createdAt.slice(0, 10)}
                  </span>
                </div>
                {!site.revoked && (
                  <button {...stylex.props(styles.dangerButton)} onClick={() => revoke(site.siteId)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

const styles = stylex.create({
  page: {
    maxWidth: 720,
    margin: "0 auto",
    padding: "2rem 1.5rem",
    fontFamily: "system-ui, sans-serif",
  },
  title: {
    fontSize: "1.5rem",
    margin: "0 0 0.25rem",
  },
  subtitle: {
    margin: "0 0 1.5rem",
    color: "var(--text-secondary, #666)",
    fontSize: "0.95rem",
  },
  section: {
    marginBottom: "1.5rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    margin: "0 0 0.75rem",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    maxWidth: 480,
  },
  input: {
    padding: "0.5rem 0.75rem",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: "0.95rem",
  },
  primaryButton: {
    padding: "0.55rem 1rem",
    borderRadius: 6,
    border: "none",
    backgroundColor: "var(--accent, #1f5eff)",
    color: "#fff",
    fontSize: "0.95rem",
    cursor: "pointer",
  },
  dangerButton: {
    padding: "0.4rem 0.75rem",
    borderRadius: 6,
    border: "1px solid #c52828",
    backgroundColor: "transparent",
    color: "#c52828",
    fontSize: "0.85rem",
    cursor: "pointer",
  },
  hint: {
    color: "var(--text-secondary, #888)",
    fontSize: "0.85rem",
    marginTop: "0.5rem",
  },
  error: {
    backgroundColor: "#fde8e8",
    border: "1px solid #c52828",
    color: "#7a1a1a",
    borderRadius: 6,
    padding: "0.6rem 0.9rem",
    marginBottom: "1rem",
  },
  notice: {
    backgroundColor: "#e8f0fe",
    border: "1px solid #1f5eff",
    color: "#123a9e",
    borderRadius: 6,
    padding: "0.6rem 0.9rem",
    marginBottom: "1rem",
  },
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "0.75rem 1rem",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    backgroundColor: "#fff",
  },
  itemInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
  },
  itemEndpoint: {
    fontSize: "0.9rem",
    color: "var(--text-secondary, #666)",
  },
  itemMeta: {
    fontSize: "0.8rem",
    color: "#999",
  },
  empty: {
    color: "var(--text-secondary, #888)",
  },
})
