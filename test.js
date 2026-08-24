import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const SERVER_PATH = 'C:/Data/Hermes/~/tradingview-mcp/src/server.js';

async function run() {
    const transport = new StdioClientTransport({ command: 'node', args: [SERVER_PATH] });
    const client = new Client({ name: 'tv-script', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
        console.log("Switching to Stocks...");
        let res = await client.callTool({ name: 'watchlist_switch', arguments: { name: 'Stocks' } });
        console.log("Switch result:", JSON.stringify(res, null, 2));

        console.log("Getting watchlist...");
        let getRes = await client.callTool({ name: 'watchlist_get', arguments: {} });
        console.log("Watchlist:", JSON.stringify(getRes, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        await client.close();
    }
}
run();
