import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import {
  CLARITY_API_TOKEN,
  CLARITY_AUTH_MODE,
  getHttpsProxyFromEnv,
} from "./config.js";

export { getConfigValue } from "./config.js";

type ToolResult = { content: { type: "text"; text: string }[] };

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

// Node's built-in fetch ignores HTTPS_PROXY/NO_PROXY. Use undici's EnvHttpProxyAgent
// so requests go through the environment's proxy whenever one is configured. This is
// required for proxy authentication (the proxy must see the request to inject the
// credential) and is harmless in token mode.
let proxyDispatcher: Dispatcher | undefined;
const getDispatcher = (): Dispatcher | undefined => {
  if (!getHttpsProxyFromEnv()) {
    return undefined;
  }
  proxyDispatcher ??= new EnvHttpProxyAgent();
  return proxyDispatcher;
};

/**
 * Builds the authentication headers for a Clarity request.
 *  - token mode: `Authorization: Bearer <local token>`
 *  - proxy mode: nothing at all; the proxy is responsible for adding the credential.
 */
export const buildAuthHeaders = (): Record<string, string> => {
  if (CLARITY_AUTH_MODE === "token" && CLARITY_API_TOKEN) {
    return { Authorization: `Bearer ${CLARITY_API_TOKEN}` };
  }
  return {};
};

/** Returns a user-facing error if the configuration cannot make an authenticated request. */
export const getAuthConfigError = (): string | undefined => {
  if (CLARITY_AUTH_MODE === "proxy") {
    if (!getHttpsProxyFromEnv()) {
      return "Proxy authentication mode is enabled (CLARITY_AUTH_MODE=proxy) but no HTTPS proxy is configured (HTTPS_PROXY is not set). " +
        "Proxy mode only works where a network proxy injects the Clarity credential, such as Claude Code on the web with a Network secret for clarity.microsoft.com.";
    }
    return undefined;
  }
  if (!CLARITY_API_TOKEN) {
    return "No Clarity API token provided. Please provide a token via the CLARITY_API_TOKEN environment variable or the --clarity_api_token command-line argument, " +
      "or set CLARITY_AUTH_MODE=proxy if a network proxy injects the token.";
  }
  return undefined;
};

const describeHttpFailure = (status: number): string => {
  if ((status === 401 || status === 403) && CLARITY_AUTH_MODE === "proxy") {
    return `Clarity rejected the request (HTTP ${status}). In proxy authentication mode this usually means no Network secret is configured for clarity.microsoft.com, ` +
      "or it was saved with the wrong header/format. It must inject `Authorization: Bearer <token>` for host clarity.microsoft.com.";
  }
  if (status === 401 || status === 403) {
    return `Clarity rejected the request (HTTP ${status}). Check that the Clarity API token is valid and has not expired.`;
  }
  if (status === 429) {
    return "Clarity rate limit reached (HTTP 429). Try again later.";
  }
  return `Endpoint request failed with status ${status}.`;
};

// Only log error codes/messages, never request options (which carry headers).
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return [error.message, cause?.code, cause?.message].filter(Boolean).join(" | ");
  }
  return String(error);
};

/** POSTs a JSON body to a Clarity endpoint with mode-appropriate authentication. */
export const postClarityAsync = async (url: string, body: unknown): Promise<ToolResult> => {
  const configError = getAuthConfigError();
  if (configError) {
    return textResult(configError);
  }

  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(),
      },
      body: JSON.stringify(body),
      dispatcher: getDispatcher(),
    });

    if (!response.ok) {
      const message = describeHttpFailure(response.status);
      console.error(`Clarity request to ${url} failed: HTTP ${response.status}`);
      return textResult(message);
    }

    const data = await response.json();
    return textResult(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Clarity request to ${url} failed: ${describeError(error)}`);
    return textResult(
      CLARITY_AUTH_MODE === "proxy"
        ? "An error occurred while contacting Clarity through the network proxy. If the proxy refused the connection, clarity.microsoft.com may not be allowed in this environment; saving a Network secret for that host allows it."
        : "An error occurred while fetching the data."
    );
  }
};
