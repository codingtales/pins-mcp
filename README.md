# intellipins-addressing MCP

An MCP server that exposes Intellipins address geocoding tools to Claude Code.

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
claude mcp add intellipins-addressing \
  node "/path/to/pins-mcp/dist/index.js"
```

Note: do not pass the key as a flag — the server picks it up from the environment.

### Step 5 — Verify

```sh
claude mcp list
```

You should see:

```
intellipins-addressing: ... ✓ Connected
```

## Available Tools

- `geocode_forward` — Address → coordinates
- `geocode_reverse` — Coordinates → address
- `parcel_lookup` — Look up parcel data for an address
- `postal_city_lookup` — Look up city/state for a ZIP code
- `property_search_urls` — Generate Zillow/Redfin search URLs for a property
