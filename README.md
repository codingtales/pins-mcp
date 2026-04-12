# intellipins MCP

An MCP server that exposes Intellipins address geocoding tools over stdio and Streamable HTTP.

## Prerequisites

- Node.js installed
- Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`
- An Intellipins API key

## Setup

### Step 1 — Clone the project

```
~/Library/CloudStorage/.../Intellipins/projects/pins-mcp/
```

Or place it anywhere — just note the path.

### Step 2 — Build the server

```sh
cd /path/to/pins-mcp
npm install
npm run build
```

This produces `dist/index.js`.

### Step 3 — Add your API key

Store the key in `~/.claude/.env`:

```sh
# ~/.claude/.env
INTELLIPINS_API_KEY=your_api_key_here
```

Then add this line to your shell profile (`~/.zshrc`) so the key is in the environment when Claude Code launches — the MCP server inherits it from there:

```sh
# ~/.zshrc
export INTELLIPINS_API_KEY=$(grep INTELLIPINS_API_KEY ~/.claude/.env | cut -d= -f2)
```

This keeps the key in one place (`.env`) and avoids duplicating it.

Then reload your shell:

```sh
source ~/.zshrc
```

### Step 4 — Register the MCP with Claude Code

```sh
claude mcp add intellipins \
  node "/path/to/pins-mcp/dist/index.js"
```

Note: do not pass the key as a flag — the server picks it up from the environment.

### Step 5 — Verify

```sh
claude mcp list
```

You should see:

```
intellipins: ... ✓ Connected
```

## Hosting Over Streamable HTTP

The server still defaults to stdio for local MCP clients, but it can now run as a hosted Streamable HTTP server.

### Run locally in HTTP mode

```sh
cd /path/to/pins-mcp
npm run build
MCP_TRANSPORT=http PORT=3000 npm run start:http
```

You can also use the dev entrypoint:

```sh
MCP_TRANSPORT=http PORT=3000 npm run dev:http
```

### HTTP configuration

- `MCP_TRANSPORT=http` or `--transport=http` enables Streamable HTTP mode
- `PORT` or `MCP_PORT` sets the listen port. Default: `3000`
- `HOST` or `MCP_HOST` sets the bind host. Default: `0.0.0.0`
- `MCP_PATH` sets the MCP endpoint path. Default: `/mcp`
- `GET /health` returns a simple health response for deployment checks

Example:

```sh
HOST=0.0.0.0 PORT=8080 MCP_PATH=/mcp MCP_TRANSPORT=http node dist/index.js
```

The MCP endpoint will then be available at:

```text
http://localhost:8080/mcp
```

## Available Tools

- `geocode_forward` — Address → coordinates
- `geocode_reverse` — Coordinates → address
- `parcel_lookup` — Look up parcel data for an address
- `postal_city_lookup` — Look up city/state for a ZIP code
- `property_search_urls` — Generate Zillow/Redfin search URLs for a property
