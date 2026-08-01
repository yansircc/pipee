const entries = (value) =>
  typeof value === "string"
    ? value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const isLoopbackHost = (host) =>
  host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);

/**
 * A real remote site must retain the caller's proxy policy. LocalWP is only a
 * remote-site stand-in for acceptance, so its configured endpoint is the sole
 * source of a direct-connect exception.
 */
export const loopbackEndpointHosts = (sites) => [
  ...new Set(
    sites.flatMap((site) => {
      if (typeof site?.endpoint !== "string") return [];
      try {
        const host = new URL(site.endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
        return isLoopbackHost(host) ? [host] : [];
      } catch {
        return [];
      }
    }),
  ),
];

export const withLoopbackNoProxy = (environment, sites) => {
  const loopbackHosts = loopbackEndpointHosts(sites);
  if (loopbackHosts.length === 0) return environment;

  // Undici's EnvHttpProxyAgent gives lowercase no_proxy precedence. Set both
  // spellings to one merged value so inherited configuration cannot mask the
  // LocalWP exception.
  const noProxy = [
    ...new Set([
      ...entries(environment.NO_PROXY),
      ...entries(environment.no_proxy),
      ...loopbackHosts,
    ]),
  ].join(",");
  return { ...environment, NO_PROXY: noProxy, no_proxy: noProxy };
};
