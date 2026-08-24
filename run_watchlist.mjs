import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = 'C:/Data/Hermes/~/tradingview-mcp/src/server.js';

async function run() {
    const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH],
    });

    const client = new Client({ name: 'tv-script', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
        const checkWatchlistApi = `(async function() {
            try {
                if (!window.TradingViewApi || !window.TradingViewApi._watchlistApiDeferredPromise) return "No promise";
                const api = await window.TradingViewApi._watchlistApiDeferredPromise;
                if (!api) return "api is falsy";
                let props = [];
                for (let k in api) { props.push(k); }
                return JSON.stringify({ type: typeof api, props: props });
            } catch(e) { return e.toString(); }
        })()`;
        let res = await client.callTool({ name: 'ui_evaluate', arguments: { expression: checkWatchlistApi } });
        console.log("WatchlistApi details:", res.content?.[0]?.text);
    } catch(e) {
        console.error(e);
    } finally {
        await client.close();
    }
}
run();
