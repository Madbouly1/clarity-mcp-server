import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import pkg from "../package.json" with { type: "json" };

import {
  ANALYTICS_DASHBOARD_DESCRIPTION,
  ANALYTICS_DASHBOARD_TOOL,
  DOCUMENTATION_DESCRIPTION,
  DOCUMENTATION_TOOL,
  SESSION_RECORDINGS_DESCRIPTION,
  SESSION_RECORDINGS_TOOL
} from "./constants.js";
import {
  CLARITY_API_TOKEN,
  CLARITY_AUTH_MODE,
  LOCAL_TOKEN_IGNORED,
  getHttpsProxyFromEnv
} from "./config.js";
import {
  SYSTEM_INSTRUCTIONS_PROMPT
} from "./instructions.js";
import {
  listSessionRecordingsAsync,
  queryAnalyticsDashboardAsync,
  queryDocumentationAsync
} from "./tools.js";
import {
  ListRequest,
  SearchRequest,
} from "./types.js";

// Create server instance
const server = new McpServer(
  {
    name: pkg.name,
    version: pkg.version,
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    },
    instructions: SYSTEM_INSTRUCTIONS_PROMPT,
  }
);

// Register the query-analytics-data tool
server.tool(
  ANALYTICS_DASHBOARD_TOOL,             /* Name */
  ANALYTICS_DASHBOARD_DESCRIPTION,      /* Description */
  SearchRequest,                        /* Parameter Schema */
  {                                     /* Metadata & Annotations */
    title: "Query Analytics Dashboard",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ query }) => {
    return await queryAnalyticsDashboardAsync(query, Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
);

// Register the session-recordings tool
server.tool(
  SESSION_RECORDINGS_TOOL,              /* Name */
  SESSION_RECORDINGS_DESCRIPTION,       /* Description */
  ListRequest,                          /* Parameter Schema */
  {                                     /* Metadata & Annotations */
    title: "List Session Recordings",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ filters, sortBy, count }) => {
    const now = new Date().toISOString();

    // Calculate end as now, start as now - numOfDays
    const endDate = new Date(filters?.date?.end || now);
    const startDate = new Date(filters?.date?.start || now);

    if (!filters?.date?.start) {
      startDate.setDate(endDate.getDate() - 2);
    }

    return await listSessionRecordingsAsync(startDate, endDate, filters, sortBy, count);
  }
);

// Register the query-documentation-resources tool
server.tool(
  DOCUMENTATION_TOOL,                   /* Name */
  DOCUMENTATION_DESCRIPTION,            /* Description */
  SearchRequest,                        /* Parameter Schema */
  {                                     /* Metadata & Annotations */
    title: "Query Documentation Resources",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ query }) => {
    return await queryDocumentationAsync(query);
  }
);

// Main function
async function main() {
  // Log configuration status (never the token or proxy URL, which may embed credentials)
  if (CLARITY_AUTH_MODE === "proxy") {
    console.error("Clarity auth mode: proxy (no Authorization header is sent; the network proxy must inject the credential)");
    if (!getHttpsProxyFromEnv()) {
      console.error("Warning: proxy auth mode is enabled but HTTPS_PROXY is not set; requests will be refused");
    }
    if (LOCAL_TOKEN_IGNORED) {
      console.error("Warning: a local Clarity API token was provided but is ignored in proxy auth mode");
    }
  } else if (CLARITY_API_TOKEN) {
    console.error("Clarity auth mode: token (API token configured via environment/command-line)");
  } else {
    console.error("Clarity auth mode: token, but no Clarity API token is configured; tool calls will fail until one is provided");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Microsoft Clarity Data Export MCP Server running on stdio...");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
