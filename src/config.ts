// Configuration resolution for the Clarity MCP server.
//
// Values come from command-line arguments first (`--name=value` or `--name value`),
// then environment variables (`name` or `NAME`).

export const getConfigValue = (name: string, fallback?: string): string | undefined => {
  const flag = `--${name}`;
  const argIndex = process.argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (argIndex !== -1) {
    const arg = process.argv[argIndex]!;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      // Keep everything after the first "=" (values may themselves contain "=").
      return arg.slice(eq + 1);
    }
    // --name value format: return next argument if it exists and isn't another flag
    const nextArg = process.argv[argIndex + 1];
    if (nextArg && !nextArg.startsWith("--")) {
      return nextArg;
    }
  }

  const envValue = process.env[name] || process.env[name.toUpperCase()];
  if (envValue) {
    return envValue;
  }

  return fallback;
};

/**
 * Authentication modes:
 *  - "token" (default): the server reads CLARITY_API_TOKEN locally and sends
 *    `Authorization: Bearer <token>` itself. This is the original behavior.
 *  - "proxy": the server sends NO Authorization header and does not need a
 *    token. Requests are routed through the HTTPS proxy from the environment
 *    (HTTPS_PROXY), which is expected to inject the real credential, e.g.
 *    Claude Code on the web "Network secrets".
 */
export type AuthMode = "token" | "proxy";

const AUTH_MODES: readonly AuthMode[] = ["token", "proxy"];

export const resolveAuthMode = (): AuthMode => {
  const raw = getConfigValue("clarity_auth_mode")?.trim().toLowerCase();
  if (!raw) {
    return "token";
  }
  if ((AUTH_MODES as readonly string[]).includes(raw)) {
    return raw as AuthMode;
  }
  throw new Error(`Invalid clarity_auth_mode "${raw}". Expected one of: ${AUTH_MODES.join(", ")}.`);
};

/** Returns the HTTPS proxy URL from the environment, if any (never logged: may embed credentials). */
export const getHttpsProxyFromEnv = (): string | undefined =>
  process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

export const CLARITY_AUTH_MODE: AuthMode = resolveAuthMode();

// In proxy mode the local token is intentionally never read, so it can never be sent.
export const CLARITY_API_TOKEN: string | undefined =
  CLARITY_AUTH_MODE === "token" ? getConfigValue("clarity_api_token") : undefined;

/** True when a local token is present in the environment/args but ignored because of proxy mode. */
export const LOCAL_TOKEN_IGNORED: boolean =
  CLARITY_AUTH_MODE === "proxy" && Boolean(getConfigValue("clarity_api_token"));
