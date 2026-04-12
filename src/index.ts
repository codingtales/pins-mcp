#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { deflateSync } from "node:zlib";

const BASE_URL = "https://api.intellipins.com/v1/address";

function buildGeojsonIoUrl(geometry: unknown): string {
  const featureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry, properties: {} }],
  };
  const compressed = deflateSync(Buffer.from(JSON.stringify(featureCollection), "utf8"));
  const base64 = compressed.toString("base64");
  return `https://geojson.io/#data=base64,${base64}`;
}

function extractGeometry(result: unknown): unknown | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const candidates = r.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown>;
  // Try top-level geometry first, then nested in document
  const geom =
    first.geometry ??
    (first.document && typeof first.document === "object"
      ? (first.document as Record<string, unknown>).geometry
      : null);
  if (geom && typeof geom === "object" && (geom as Record<string, unknown>).type) {
    return geom;
  }
  return null;
}

function getAuthHeader(): Record<string, string> {
  const token = process.env.INTELLIPINS_BEARER_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const key = process.env.INTELLIPINS_API_KEY;
  if (key) {
    return { "X-API-KEY": key };
  }
  throw new Error(
    "No Intellipins credentials found. Set either INTELLIPINS_BEARER_TOKEN or INTELLIPINS_API_KEY."
  );
}

async function callApi(
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...getAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Intellipins API error ${response.status}: ${text}`);
  }

  return response.json();
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "intellipins",
    version: "1.0.0",
  });

// ─── Tool 1: Forward Geocode ──────────────────────────────────────────────────

  server.tool(
    "geocode_forward",
  `Convert a street address into geographic coordinates (lat/lng), a standardized address, and a unique ipins_id.

WORKFLOW: This is always the FIRST step. Run this before parcel_lookup or any property research.
- If the user provides an address string → call this tool
- If the user provides coordinates → call geocode_reverse instead
- If the prompt already contains an Intellipins response (fields: ipins_id, match_info, document) → skip this call entirely and use the existing data

MATCH QUALITY — read match_info.FALLBACK in the response:
  • null (absent) + ipins_id present → Perfect point match. High confidence. Offer parcel lookup.
  • "INTERPOLATED"                   → On the right street/range but no exact hit. Tell the user and ask if they want to search online.
  • "STREET"                         → Street matched but house number unresolvable. Low confidence. Flag it.
  • "POSTAL"                         → Only admin/postal match. Very low confidence. Flag it.

DELIVERABILITY — combine FALLBACK and ipins_id:
  FALLBACK null    + ipins_id present → Valid and deliverable.
  FALLBACK present + ipins_id absent  → Not deliverable. Flag to user.

ADDRESS TYPE — always explain document.address_type to the user when present:
  • "Base"          → This is the base record for a multi-unit property (e.g. multi-family building, apartment complex, strip mall). The address exists and is valid, but it is NOT a deliverable location on its own — it is a parent address. A specific unit number (Supplementary) is needed for delivery.
  • "Supplementary" → This is a valid unit-level address (e.g. Apt 3B, Suite 200). It is a confirmed deliverable location.
  • null (absent) but ipins_id present → Most likely a single-family or standalone address. Valid and deliverable.

ALWAYS show ipins_id prominently in your output. If absent, state: "ipins_id: not available (low-confidence or unmatched address)"

AFTER this call, offer to run parcel_lookup (if ipins_id is present) or property_search_urls to find listing details online.`,
  {
    address: z
      .string()
      .describe("Street address to geocode (e.g. '620 Manhattan Pl Boulder CO')"),
    country: z.string().default("usa").describe("Country code — defaults to 'usa'"),
    candidates: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of candidate results to return (1–10, default 1)"),
    fuzziness: z
      .enum(["Greedy", "Exact", "Fuzzy"])
      .default("Greedy")
      .describe("Match fuzziness: Greedy (default), Exact, or Fuzzy"),
    allow_fallbacks: z
      .boolean()
      .default(true)
      .describe(
        "Allow INTERPOLATED, STREET, or POSTAL fallback matches when exact match is unavailable"
      ),
    allow_interpolated: z
      .boolean()
      .default(true)
      .describe("Allow interpolated (estimated) address points"),
    admin_filter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Restrict results to a specific admin area (state/county FIPS or name). Null = no filter"
      ),
  },
  async (params) => {
    const body: Record<string, unknown> = {
      address: params.address,
      country: params.country,
      candidates: params.candidates,
      fuzziness: params.fuzziness,
      return_formatted_address: true,
      allow_fallbacks: params.allow_fallbacks,
      allow_interpolated: params.allow_interpolated,
      admin_filter: params.admin_filter ?? null,
    };

    const result = await callApi("/geocode/forward", body);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
  );

// ─── Tool 2: Reverse Geocode ──────────────────────────────────────────────────

  server.tool(
    "geocode_reverse",
  `Convert geographic coordinates (latitude, longitude) into a standardized street address and ipins_id.

WORKFLOW: Use this when the user provides lat/lng coordinates instead of a street address.
- Always run this first when coordinates are given — get the standardized address before searching anything online.
- The response contains the same fields as geocode_forward: ipins_id, document.address_type, formatted_address.

MATCH QUALITY — combine ipins_id and document.address_type to determine deliverability:

  ipins_id present → address was matched to a known point. Assess deliverability via address_type below.
  ipins_id absent  → low-confidence or no match. Flag to user. Not deliverable.

ADDRESS TYPE — always explain document.address_type to the user when present:
  • "Base"          → This is the base record for a multi-unit property (e.g. multi-family building, apartment complex, strip mall). The address exists and is valid, but it is NOT a deliverable location on its own — it is a parent address. A specific unit number (Supplementary) is needed for delivery.
  • "Supplementary" → This is a valid unit-level address (e.g. Apt 3B, Suite 200). It is a confirmed deliverable location.
  • null (absent) but ipins_id present → Most likely a single-family or standalone address. Valid and deliverable.

ALWAYS show ipins_id prominently in your output. If absent, state: "ipins_id: not available (low-confidence match)"

AFTER this call, offer to run parcel_lookup (if ipins_id is present) or property_search_urls to find listing details online.`,
  {
    latitude: z
      .number()
      .describe("Latitude of the point to reverse geocode (e.g. 47.868355)"),
    longitude: z
      .number()
      .describe("Longitude of the point to reverse geocode (e.g. -122.251364)"),
    country: z.string().default("usa").describe("Country code — defaults to 'usa'"),
    candidates: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of candidate results to return (1–10, default 1)"),
  },
  async (params) => {
    const body: Record<string, unknown> = {
      origin: [params.latitude, params.longitude],
      country: params.country,
      candidates: params.candidates,
      return_formatted_address: true,
    };

    const result = await callApi("/geocode/reverse", body);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
  );

// ─── Tool 3: Postal City Lookup ───────────────────────────────────────────────

  server.tool(
    "postal_city_lookup",
  `Look up ZIP codes for a given city and state.
Returns a list of matching postal/city combinations with county and state FIPS codes.
Use this when the user wants to know what ZIP codes cover a city, or to verify a city/state combination.`,
  {
    city: z.string().describe("City name (e.g. 'boulder')"),
    admin1: z
      .string()
      .describe("State abbreviation or full name (e.g. 'co' or 'Colorado')"),
    country: z.string().default("usa").describe("Country code — defaults to 'usa'"),
    candidates: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Number of results to return (default 10)"),
  },
  async (params) => {
    const body: Record<string, unknown> = {
      country: params.country,
      city: params.city,
      admin1: params.admin1,
      candidates: params.candidates,
    };

    const result = await callApi("/postal-city", body);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
  );

// ─── Tool 4: Parcel Lookup ────────────────────────────────────────────────────

  server.tool(
    "parcel_lookup",
  `Retrieve parcel-level property data for an address using its ipins_id.

PREREQUISITE: ipins_id must come from geocode_forward or geocode_reverse — never guess or fabricate it.
Only call this when ipins_id is present in the geocode response. If ipins_id was absent (INTERPOLATED/STREET/POSTAL match), skip this and go to property_search_urls instead.

Returns: parcel owner name, APN (assessor parcel number), parcel area, elevation, county/state FIPS, and optionally parcel boundary geometry.

AFTER this call — do ALL of the following:
- Present owner name, APN, area, and formatted address clearly.
- If the response contains geojson_io_url: display it as a clickable markdown link "[View parcel boundary on map](url)" — NEVER output raw coordinates or a coordinate table. The link is the only boundary output.
- If the response does NOT contain geojson_io_url (geometry was not returned), ask the user: "Would you like to see the actual parcel boundaries on the map?"
- If the user wants market value, listing status, beds/baths, or sale history → call property_search_urls next (max 2–3 web searches total).`,
  {
    ipins_id: z
      .string()
      .describe(
        "Intellipins address identifier from geocode_forward or geocode_reverse (e.g. 'iUS00044688633')"
      ),
    country: z.string().default("usa").describe("Country code — defaults to 'usa'"),
    return_geometry: z
      .boolean()
      .default(false)
      .describe(
        "Set to true when the user asks for parcel boundary, geometry, shape, or outline. Sends return_geometry=true to the API to include GeoJSON polygon in the response."
      ),
    candidates: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1)
      .describe("Number of results to return (default 1)"),
  },
  async (params) => {
    const body: Record<string, unknown> = {
      country: params.country,
      ipins_id: params.ipins_id,
      return_geometry: params.return_geometry,
      return_formatted_address: true,
      candidates: params.candidates,
    };

    const result = await callApi("/parcel-lookup", body);

    let output = result as Record<string, unknown>;
    const geom = extractGeometry(result);
    if (geom) {
      output = { ...output, geojson_io_url: buildGeojsonIoUrl(geom) };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    };
  }
  );

// ─── Tool 5: Property Search URLs ────────────────────────────────────────────

  server.tool(
    "property_search_urls",
  `Generate Zillow and Redfin search URLs and web search queries for a standardized address.

WHEN TO USE:
- After geocode_forward / geocode_reverse when the user asks for property details (value, beds/baths, listing status, sale history, taxes, HOA, etc.)
- When ipins_id was absent (INTERPOLATED/STREET/POSTAL match) and parcel_lookup cannot be called
- Always use the STANDARDIZED address from the geocoder (document.formatted_address), not the user's raw input

FETCH RULES (enforce strictly):
- Prefer WebFetch on direct_url over WebSearch — WebFetch retrieves the actual property page with current data; WebSearch only returns snippets which may be stale or incomplete
- Run the first 2 fetches in parallel using the provided direct_url values
- Only fall back to web_search_query if WebFetch returns an error or no property data
- Only add a 3rd search if both of the first two returned no useful data
- Stop as soon as you have enough to answer — do not fetch for completeness
- Never re-fetch data already present in the conversation context

WHAT TO LOOK FOR (only what's missing from context):
  property type · beds/baths/sqft · lot size · year built
  estimated/market value · land value · last sold price & date
  current listing status (active/pending/off-market/recently sold)
  property taxes · HOA fees

Present findings as "online results" — do not mention specific site names in your response.
If no listing is found on any site, say so — the address may be new, rural, or commercial.`,
  {
    formatted_address: z
      .string()
      .describe(
        "Standardized address from geocoder — use document.formatted_address joined into one line (e.g. '620 Manhattan Pl, Boulder CO 80303')"
      ),
    state: z
      .string()
      .optional()
      .describe("State abbreviation for constructing accurate search URLs (e.g. 'CO')"),
    city: z.string().optional().describe("City name (e.g. 'Boulder')"),
    zip: z.string().optional().describe("ZIP code (e.g. '80303')"),
  },
  async (params) => {
    const addr = params.formatted_address;

    // Zillow property pages use hyphenated slugs (not %20-encoded)
    // e.g. "1312 142nd Pl SW, Lynnwood WA 98087" → "1312-142nd-Pl-SW-Lynnwood-WA-98087"
    const zillowSlug = addr.replace(/,/g, "").replace(/\s+/g, "-");
    const zillowUrl = `https://www.zillow.com/homes/${zillowSlug}_rb/`;
    const zillowSearch = `site:zillow.com "${addr}"`;

    // Redfin search uses encoded address
    const redfinQuery = encodeURIComponent(addr);
    const redfinUrl = `https://www.redfin.com/search#combined/${redfinQuery}`;
    const redfinSearch = `site:redfin.com "${addr}"`;

    const output = {
      instructions:
        "Prefer WebFetch on direct_url (retrieves actual property page with current data). Only fall back to web_search_query if WebFetch fails or returns no property data. Run the first 2 in parallel. Cap total fetches/searches at 2–3.",
      max_searches: 3,
      searches: [
        {
          priority: 1,
          direct_url: zillowUrl,
          web_search_query: zillowSearch,
          fallback_query: `${addr} property details zillow`,
        },
        {
          priority: 2,
          direct_url: redfinUrl,
          web_search_query: redfinSearch,
          fallback_query: `${addr} property details redfin`,
        },
        {
          priority: 3,
          note: "Only use if fetches 1 and 2 returned nothing useful",
          web_search_query: `${addr} property value beds baths year built`,
        },
      ],
      standardized_address: addr,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    };
  }
  );

  return server;
}

// ─── Start server ─────────────────────────────────────────────────────────────

type RuntimeTransport = "stdio" | "http";

function getRuntimeTransport(): RuntimeTransport {
  const transportArg = process.argv.find((arg) => arg.startsWith("--transport="));
  const transportValue = transportArg?.split("=")[1] ?? process.env.MCP_TRANSPORT ?? "stdio";
  return transportValue === "http" || transportValue === "streamable-http" ? "http" : "stdio";
}

function getHttpPort(): number {
  const rawPort = process.env.PORT ?? process.env.MCP_PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HTTP port: ${rawPort}`);
  }
  return port;
}

function getHttpHost(): string {
  return process.env.HOST ?? process.env.MCP_HOST ?? "0.0.0.0";
}

function getMcpPath(): string {
  const rawPath = process.env.MCP_PATH ?? "/mcp";
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
}

function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  mcpPath: string
): Promise<void> | void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, transport: "streamable-http", path: mcpPath }));
    return;
  }

  if (url.pathname !== mcpPath) {
    setCorsHeaders(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  setCorsHeaders(res);
  return transport.handleRequest(req, res);
}

async function startHttpServer(): Promise<void> {
  const host = getHttpHost();
  const port = getHttpPort();
  const mcpPath = getMcpPath();

  const httpServer = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      Promise.resolve(handleHttpRequest(req, res, new StreamableHTTPServerTransport(), mcpPath)).catch(
        (err) => {
          console.error("HTTP transport error:", err);
          if (!res.headersSent) {
            setCorsHeaders(res);
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      );
      return;
    }

    if ((req.url ?? "").startsWith("/health")) {
      Promise.resolve(handleHttpRequest(req, res, new StreamableHTTPServerTransport(), mcpPath)).catch(
        (err) => {
          console.error("HTTP transport error:", err);
          if (!res.headersSent) {
            setCorsHeaders(res);
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      );
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    Promise.resolve(server.connect(transport))
      .then(() => handleHttpRequest(req, res, transport, mcpPath))
      .catch((err) => {
        console.error("HTTP transport error:", err);
        if (!res.headersSent) {
          setCorsHeaders(res);
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
  });

  httpServer.listen(port, host, () => {
    console.error(
      `Intellipins MCP server running on Streamable HTTP at http://${host}:${port}${mcpPath}`
    );
  });
}

async function main() {
  if (getRuntimeTransport() === "http") {
    await startHttpServer();
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Intellipins MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
