export function installPiChromeInstrumentation() {
  const CONSOLE_ENTRY_LIMIT = 80;
  const CONSOLE_ARGUMENT_LIMIT = 8;
  const CONSOLE_ARGUMENT_CHAR_LIMIT = 512;
  const CONSOLE_VALUE_CHAR_LIMIT = 256;
  const CONSOLE_VALUE_NODE_LIMIT = 64;
  const CONSOLE_VALUE_DEPTH_LIMIT = 4;
  const NETWORK_ENTRY_LIMIT = 40;
  const NETWORK_BODY_CHAR_LIMIT = 8_000;
  const NETWORK_URL_CHAR_LIMIT = 1_024;
  const NETWORK_HEADER_LIMIT = 24;
  const NETWORK_HEADER_NAME_CHAR_LIMIT = 64;
  const NETWORK_HEADER_VALUE_CHAR_LIMIT = 256;
  const NETWORK_HEADER_TEXT_CHAR_LIMIT = 4_096;
  const NETWORK_ERROR_CHAR_LIMIT = 512;

  const state: PiChromePageState = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    nextFrontierUid: 1,
    refs: new Map(),
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
    lastSnapshotDigest: null,
  };
  window.__PI_CHROME_STATE__ = state;
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;

  const boundedText = (value: unknown, limit: number): string => {
    let text: string;
    try {
      text = String(value);
    } catch {
      text = "[unprintable]";
    }
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
  };
  const serializeConsoleArgument = (argument: unknown): unknown => {
    let remainingNodes = CONSOLE_VALUE_NODE_LIMIT;
    const seen = new WeakSet<object>();
    const project = (value: unknown, depth: number): unknown => {
      if (remainingNodes <= 0) return "[truncated]";
      remainingNodes -= 1;
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "string") return boundedText(value, CONSOLE_VALUE_CHAR_LIMIT);
      if (typeof value !== "object") return boundedText(value, CONSOLE_VALUE_CHAR_LIMIT);
      if (value instanceof Error) {
        return {
          name: boundedText(value.name, CONSOLE_VALUE_CHAR_LIMIT),
          message: boundedText(value.message, CONSOLE_VALUE_CHAR_LIMIT),
          stack: boundedText(value.stack || "", CONSOLE_VALUE_CHAR_LIMIT),
        };
      }
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      if (depth >= CONSOLE_VALUE_DEPTH_LIMIT) {
        return Array.isArray(value) ? "[array depth limit]" : "[object depth limit]";
      }
      if (Array.isArray(value)) {
        const result: Array<unknown> = [];
        const count = Math.min(value.length, CONSOLE_ARGUMENT_LIMIT);
        for (let index = 0; index < count; index += 1) {
          result.push(project(value[index], depth + 1));
        }
        if (value.length > count) result.push(`[${value.length - count} more items]`);
        return result;
      }
      let keys: Array<string>;
      try {
        keys = Object.keys(value);
      } catch {
        return "[unreadable object]";
      }
      const result: Record<string, unknown> = {};
      const count = Math.min(keys.length, CONSOLE_ARGUMENT_LIMIT);
      for (let index = 0; index < count; index += 1) {
        const rawKey = keys[index]!;
        const key = boundedText(rawKey, CONSOLE_VALUE_CHAR_LIMIT);
        try {
          result[key] = project((value as Record<string, unknown>)[rawKey], depth + 1);
        } catch {
          result[key] = "[unreadable]";
        }
      }
      if (keys.length > count) result.__truncatedKeys = keys.length - count;
      return result;
    };

    const projected = project(argument, 0);
    try {
      const json = JSON.stringify(projected);
      return json && json.length > CONSOLE_ARGUMENT_CHAR_LIMIT
        ? boundedText(json, CONSOLE_ARGUMENT_CHAR_LIMIT)
        : projected;
    } catch {
      return boundedText(argument, CONSOLE_ARGUMENT_CHAR_LIMIT);
    }
  };
  const pushConsole = (level: string, args: ArrayLike<unknown>) => {
    const serialized: Array<unknown> = [];
    const count = Math.min(args.length, CONSOLE_ARGUMENT_LIMIT);
    for (let index = 0; index < count; index += 1) {
      serialized.push(serializeConsoleArgument(args[index]));
    }
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: boundedText(location.href, NETWORK_URL_CHAR_LIMIT),
      args: serialized,
    });
    if (state.console.length > CONSOLE_ENTRY_LIMIT) {
      state.console.splice(0, state.console.length - CONSOLE_ENTRY_LIMIT);
    }
  };
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function (this: Console, ...args: Array<unknown>): void {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) =>
    pushConsole("pageerror", [
      event.message,
      event.filename + ":" + event.lineno + ":" + event.colno,
    ]),
  );
  window.addEventListener("unhandledrejection", (event) =>
    pushConsole("unhandledrejection", [event.reason]),
  );

  const boundedHeaders = (headers: Headers): Array<[string, string]> => {
    const result: Array<[string, string]> = [];
    try {
      for (const [name, value] of headers.entries()) {
        if (result.length >= NETWORK_HEADER_LIMIT) break;
        result.push([
          boundedText(name, NETWORK_HEADER_NAME_CHAR_LIMIT),
          boundedText(value, NETWORK_HEADER_VALUE_CHAR_LIMIT),
        ]);
      }
    } catch {}
    return result;
  };
  const readBoundedResponseBody = async (
    response: Response,
  ): Promise<{ readonly body: string; readonly truncated: boolean }> => {
    const body = response.clone().body;
    if (!body) return { body: "", truncated: false };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          const tail = decoder.decode();
          const remaining = NETWORK_BODY_CHAR_LIMIT - text.length;
          text += tail.slice(0, Math.max(0, remaining));
          truncated = tail.length > remaining;
          break;
        }
        const chunk = decoder.decode(part.value, { stream: true });
        const remaining = NETWORK_BODY_CHAR_LIMIT - text.length;
        text += chunk.slice(0, Math.max(0, remaining));
        if (chunk.length > remaining) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return { body: text, truncated };
  };
  const record = (entry: PiChromeNetworkEntry): PiChromeNetworkEntry => {
    entry.method = boundedText(entry.method, 32);
    entry.url = boundedText(entry.url, NETWORK_URL_CHAR_LIMIT);
    entry.pageUrl = boundedText(entry.pageUrl, NETWORK_URL_CHAR_LIMIT);
    state.network.push(entry);
    if (state.network.length > NETWORK_ENTRY_LIMIT) {
      state.network.splice(0, state.network.length - NETWORK_ENTRY_LIMIT);
    }
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch: typeof window.fetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init.method ||
        (input instanceof Request ? input.method : undefined) ||
        "GET"
      ).toUpperCase();
      const entry = record({
        id,
        type: "fetch",
        method,
        url: String(url || ""),
        startedAt,
        pageUrl: location.href,
        status: "pending",
      });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = boundedText(response.statusText, NETWORK_ERROR_CHAR_LIMIT);
        entry.ok = response.ok;
        entry.responseUrl = boundedText(response.url, NETWORK_URL_CHAR_LIMIT);
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = boundedHeaders(response.headers);
        void readBoundedResponseBody(response)
          .then(({ body, truncated }) => {
            entry.responseBody = body;
            entry.responseBodyTruncated = truncated;
          })
          .catch((error: unknown) => {
            entry.responseBodyError = boundedText(
              (error as { message?: unknown } | null | undefined)?.message || error,
              NETWORK_ERROR_CHAR_LIMIT,
            );
          });
        return response;
      } catch (error) {
        entry.error = boundedText(
          (error as { message?: unknown } | null | undefined)?.message || error,
          NETWORK_ERROR_CHAR_LIMIT,
        );
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    // oxlint-disable-next-line typescript/unbound-method -- invoked with each XHR instance below
    const originalOpen = XMLHttpRequest.prototype.open;
    // oxlint-disable-next-line typescript/unbound-method -- invoked with each XHR instance below
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: [async?: boolean, username?: string | null, password?: string | null]
    ): void {
      this.__piChromeRequest = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
      };
      return (
        originalOpen as (
          this: XMLHttpRequest,
          method: string,
          url: string | URL,
          ...rest: [async?: boolean, username?: string | null, password?: string | null]
        ) => void
      ).call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({
        id,
        type: "xhr",
        method: info.method || "GET",
        url: info.url || "",
        startedAt,
        pageUrl: location.href,
        status: "pending",
      });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = boundedText(this.statusText, NETWORK_ERROR_CHAR_LIMIT);
        entry.responseUrl = boundedText(this.responseURL, NETWORK_URL_CHAR_LIMIT);
        entry.durationMs = Date.now() - startedAt;
        try {
          entry.responseHeadersText = boundedText(
            this.getAllResponseHeaders(),
            NETWORK_HEADER_TEXT_CHAR_LIMIT,
          );
        } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = boundedText(this.responseText, NETWORK_BODY_CHAR_LIMIT);
            entry.responseBodyTruncated = this.responseText.length > NETWORK_BODY_CHAR_LIMIT;
          }
        } catch (error) {
          entry.responseBodyError = boundedText(
            (error as { message?: unknown } | null | undefined)?.message || error,
            NETWORK_ERROR_CHAR_LIMIT,
          );
        }
      });
      this.addEventListener("error", () => {
        entry.error = "XMLHttpRequest error";
        entry.durationMs = Date.now() - startedAt;
      });
      return originalSend.call(this, body);
    };
  }
}

export function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}
