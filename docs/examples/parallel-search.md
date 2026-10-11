# Web research alongside OpenWA MCP

An MCP client can use OpenWA to read WhatsApp and [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
to search the web and fetch pages. This is useful when researching an answer before drafting a reply.
Parallel's anonymous endpoint needs no account or API key; searches use Fast mode. It is intended for
exploration and light use, with lower rate limits than authenticated access.

This example adds a separate server to the client. OpenWA's `/api/search` continues to search stored
WhatsApp messages. It does not send message history to Parallel automatically. Parallel receives the tool inputs you
supply, including queries, objectives and URLs. Avoid including private chat content in those inputs.

## Configure the client

Follow [MCP setup and authentication](../24-mcp-integration.md#246-enabling--client-setup) first. Keep
OpenWA read-only unless the agent needs to send messages, and use a dedicated, least-privilege key.

For a client using the `.mcp.json` format shown in that guide, merge the following server entries into
your configuration. Replace `YOUR_API_KEY` with your dedicated OpenWA key and keep this file out of
version control. The Authorization header belongs only to `openwa`.

```json
{
  "mcpServers": {
    "openwa": {
      "type": "http",
      "url": "http://localhost:2785/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    },
    "parallel": {
      "type": "http",
      "url": "https://search.parallel.ai/mcp",
      "headers": { "User-Agent": "OpenWA-MCP-example/0.24.0" }
    }
  }
}
```

Parallel exposes `web_search` (an objective and keyword queries) and `web_fetch` (URLs and an optional
extraction objective). Use a stable `session_id` across related calls in one conversation. Free access
is rate-limited; if the service returns a rate-limit error, wait as directed by the response.

## Run search and fetch without a model

The following smoke example uses OpenWA's existing MCP SDK dependency and loads the `parallel` entry
above. It calls the tools directly, prints their responses, and fetches the first search result. It
requires neither a running OpenWA instance nor an LLM. It does not run an agent loop or send messages.

From a fresh OpenWA checkout, use Node.js 22.19 or newer and install the declared dependencies:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm ci
```

The flag skips Chromium, which this MCP-only check does not use. Omit it when installing OpenWA
for a whatsapp-web.js session that needs the bundled browser.

Save the configuration above as `.mcp.json` at the checkout root, then run there:

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { parallel } = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers;
const client = new Client({ name: 'openwa-web-research-example', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(parallel.url), {
  requestInit: { headers: parallel.headers },
});
const sessionId = randomUUID();
const queries = ['OpenWA MCP read only setup'];

function payload(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const text = result.content.find(item => item.type === 'text')?.text;
  return result.structuredContent ?? JSON.parse(text ?? '{}');
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['web_search', 'web_fetch']) {
    if (!tools.some(tool => tool.name === name)) throw new Error(`Missing tool: ${name}`);
  }
  const search = payload(await client.callTool({
    name: 'web_search',
    arguments: {
      objective: 'Find OpenWA MCP setup and read-only authentication guidance.',
      search_queries: queries,
      session_id: sessionId,
    },
  }, undefined, { timeout: 60_000 }));
  console.log(JSON.stringify(search, null, 2));
  const url = search.results?.[0]?.url;
  if (!url) throw new Error('Search returned no URLs.');
  const fetched = payload(await client.callTool({
    name: 'web_fetch',
    arguments: {
      urls: [url],
      objective: 'Extract MCP setup and authentication guidance.',
      search_queries: queries,
      session_id: sessionId,
    },
  }, undefined, { timeout: 60_000 }));
  console.log(JSON.stringify(fetched, null, 2));
  if (!fetched.results?.length) throw new Error('Fetch returned no content; inspect errors above.');
} finally {
  await client.close();
}
JS
```

A successful run prints search results with URLs and excerpts, followed by extracted page content.
The SDK handles Streamable HTTP initialization and tool dispatch; the configured User-Agent applies
to discovery, search and fetch. The script loads only `parallel`, so the OpenWA key is never attached
to these requests.
