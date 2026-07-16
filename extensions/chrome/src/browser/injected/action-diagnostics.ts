import { getPiChromeState } from "./action-core.js";
import { installPiChromeInstrumentation } from "./action-instrumentation.js";

export function listConsoleMessages(clear: boolean) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

export function listNetworkRequests(includePreservedRequests: boolean, clear: boolean) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({
      ...summary,
      hasResponseBody: responseBody !== undefined,
    }));
  if (clear) state.network = [];
  return {
    requests,
    count: requests.length,
    note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured.",
  };
}

export function getNetworkRequest(requestId: string): PiChromeNetworkEntry {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}
