import assert from "node:assert/strict";
import { loopbackEndpointHosts, withLoopbackNoProxy } from "./headless-acceptance/no-proxy.mjs";

assert.deepEqual(
  loopbackEndpointHosts([
    { endpoint: "http://localhost:10050" },
    { endpoint: "http://127.0.0.1:10051" },
    { endpoint: "http://[::1]:10052" },
    { endpoint: "https://remote.example" },
  ]),
  ["localhost", "127.0.0.1", "::1"],
);

const environment = withLoopbackNoProxy(
  { HTTP_PROXY: "http://proxy.test", NO_PROXY: "intranet.example", no_proxy: "service.test" },
  [{ endpoint: "http://localhost:10050" }, { endpoint: "https://remote.example" }],
);
assert.equal(environment.NO_PROXY, "intranet.example,service.test,localhost");
assert.equal(environment.no_proxy, environment.NO_PROXY);

const untouched = { HTTP_PROXY: "http://proxy.test", NO_PROXY: "intranet.example" };
assert.equal(withLoopbackNoProxy(untouched, [{ endpoint: "https://remote.example" }]), untouched);

process.stdout.write("zeroY headless loopback proxy policy passed.\n");
