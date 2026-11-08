// End-to-end authentication tests.
//
// Spawns the built MCP server (dist/cli.js) over stdio and routes its HTTPS traffic
// through a local mock proxy. The mock proxy terminates TLS for clarity.microsoft.com
// with a throwaway self-signed certificate (like a real egress proxy does), so it can
// observe the exact headers the server sends and optionally simulate credential injection.
//
// No real Clarity credentials are used. Requires `openssl` and a prior `npm run build`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FAKE_LOCAL_TOKEN = "fake-local-token-for-tests-0123456789";
const FAKE_INJECTED_TOKEN = "fake-injected-token-for-tests-9876543210";
const CLARITY_HOST = "clarity.microsoft.com";

let certDir;
let certPath;
let proxy;
let proxyUrl;
const state = { requests: [], connects: [], refuseConnect: false, inject: false, status: 200 };

const resetState = (overrides = {}) => {
  state.requests = [];
  state.connects = [];
  state.refuseConnect = false;
  state.inject = false;
  state.status = 200;
  Object.assign(state, overrides);
};

before(async () => {
  certDir = mkdtempSync(join(tmpdir(), "clarity-auth-test-"));
  certPath = join(certDir, "cert.pem");
  const keyPath = join(certDir, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath,
    "-subj", `/CN=${CLARITY_HOST}`,
    "-addext", `subjectAltName=DNS:${CLARITY_HOST}`,
  ], { stdio: "ignore" });
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  // "Upstream" Clarity, reached only through the MITM proxy.
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sentAuthorization = req.headers.authorization;
      // Simulate a network-secret proxy: add the credential the client did not send.
      const effectiveAuthorization = state.inject && !sentAuthorization
        ? `Bearer ${FAKE_INJECTED_TOKEN}`
        : sentAuthorization;
      state.requests.push({ host: req.headers.host, path: req.url, headers: { ...req.headers }, body, effectiveAuthorization });
      if (state.status !== 200) {
        res.writeHead(state.status).end();
        return;
      }
      if (!effectiveAuthorization) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, authorizedWith: effectiveAuthorization === `Bearer ${FAKE_INJECTED_TOKEN}` ? "injected" : "client" }));
    });
  });

  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, socket) => {
    state.connects.push(req.url);
    if (state.refuseConnect) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSocket = new tls.TLSSocket(socket, { isServer: true, key, cert });
    upstream.emit("connection", tlsSocket);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => {
  proxy?.close();
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

/** Starts the server with a clean env (no inherited proxy/Clarity/CA settings) plus `env`. */
async function withServer(env, args, fn) {
  const baseEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/proxy|^clarity_|^node_options$|^node_extra_ca_certs$/i.test(k)) continue;
    baseEnv[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", ...args],
    env: { ...baseEnv, NODE_EXTRA_CA_CERTS: certPath, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += c));
  const client = new Client({ name: "auth-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client, () => stderr);
  } finally {
    await client.close();
  }
}

const callDocs = async (client) => {
  const result = await client.callTool({ name: "query-documentation-resources", arguments: { query: "How do I install Clarity?" } });
  return result.content[0].text;
};

describe("proxy auth mode", () => {
  test("sends no Authorization header and needs no local token", async () => {
    resetState({ inject: true });
    await withServer({ HTTPS_PROXY: proxyUrl, CLARITY_AUTH_MODE: "proxy" }, [], async (client) => {
      const text = await callDocs(client);
      assert.equal(state.connects.length, 1);
      assert.equal(state.connects[0], `${CLARITY_HOST}:443`);
      assert.equal(state.requests.length, 1);
      const req = state.requests[0];
      assert.equal(req.path, "/mcp/documentation/query");
      assert.equal(req.headers.authorization, undefined, "client must not send any Authorization header");
      assert.equal(req.effectiveAuthorization, `Bearer ${FAKE_INJECTED_TOKEN}`);
      assert.deepEqual(JSON.parse(text), { ok: true, authorizedWith: "injected" });
    });
  });

  test("never sends a local token even if one is also configured", async () => {
    resetState({ inject: true });
    await withServer(
      { HTTPS_PROXY: proxyUrl, CLARITY_AUTH_MODE: "proxy", CLARITY_API_TOKEN: FAKE_LOCAL_TOKEN },
      [`--clarity_api_token=${FAKE_LOCAL_TOKEN}`],
      async (client, getStderr) => {
        await callDocs(client);
        const req = state.requests[0];
        assert.equal(req.headers.authorization, undefined);
        assert.ok(!JSON.stringify(req).includes(FAKE_LOCAL_TOKEN), "local token must not appear in the request");
        assert.match(getStderr(), /ignored in proxy auth mode/);
        assert.ok(!getStderr().includes(FAKE_LOCAL_TOKEN), "token must not be logged");
      }
    );
  });

  test("can be enabled with the --clarity_auth_mode flag", async () => {
    resetState({ inject: true });
    await withServer({ HTTPS_PROXY: proxyUrl }, ["--clarity_auth_mode=proxy"], async (client) => {
      const text = await callDocs(client);
      assert.equal(state.requests[0].headers.authorization, undefined);
      assert.equal(JSON.parse(text).authorizedWith, "injected");
    });
  });

  test("refuses to run without an HTTPS proxy and makes no request", async () => {
    resetState();
    await withServer({ CLARITY_AUTH_MODE: "proxy" }, [], async (client) => {
      const text = await callDocs(client);
      assert.match(text, /no HTTPS proxy is configured/);
      assert.equal(state.connects.length, 0);
    });
  });

  test("explains a missing Network secret when Clarity returns 401", async () => {
    resetState({ inject: false });
    await withServer({ HTTPS_PROXY: proxyUrl, CLARITY_AUTH_MODE: "proxy" }, [], async (client) => {
      const text = await callDocs(client);
      assert.equal(state.requests[0].headers.authorization, undefined);
      assert.match(text, /HTTP 401/);
      assert.match(text, /Network secret/);
    });
  });

  test("reports a proxy-refused host clearly", async () => {
    resetState({ refuseConnect: true });
    await withServer({ HTTPS_PROXY: proxyUrl, CLARITY_AUTH_MODE: "proxy" }, [], async (client) => {
      const text = await callDocs(client);
      assert.equal(state.requests.length, 0);
      assert.match(text, /network proxy/);
    });
  });
});

describe("token auth mode (default, unchanged behavior)", () => {
  test("sends Authorization: Bearer <token> from CLARITY_API_TOKEN", async () => {
    resetState();
    await withServer({ HTTPS_PROXY: proxyUrl, CLARITY_API_TOKEN: FAKE_LOCAL_TOKEN }, [], async (client, getStderr) => {
      const text = await callDocs(client);
      assert.equal(state.requests[0].headers.authorization, `Bearer ${FAKE_LOCAL_TOKEN}`);
      assert.equal(JSON.parse(text).authorizedWith, "client");
      assert.ok(!getStderr().includes(FAKE_LOCAL_TOKEN), "token must not be logged");
    });
  });

  test("sends Authorization: Bearer <token> from --clarity_api_token", async () => {
    resetState();
    await withServer({ HTTPS_PROXY: proxyUrl }, [`--clarity_api_token=${FAKE_LOCAL_TOKEN}==`], async (client) => {
      await callDocs(client);
      // Values containing "=" are preserved in full.
      assert.equal(state.requests[0].headers.authorization, `Bearer ${FAKE_LOCAL_TOKEN}==`);
    });
  });

  test("returns a helpful error and makes no request without a token", async () => {
    resetState();
    await withServer({ HTTPS_PROXY: proxyUrl }, [], async (client) => {
      const text = await callDocs(client);
      assert.match(text, /No Clarity API token provided/);
      assert.equal(state.connects.length, 0);
    });
  });

  test("rejects an invalid auth mode at startup", async () => {
    resetState();
    await assert.rejects(withServer({ CLARITY_AUTH_MODE: "bogus" }, [], async () => {}));
  });
});
