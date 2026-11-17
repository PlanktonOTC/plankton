import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { handleMcp, inputSchema, RPC, tool, type McpTool, type RpcResponse } from '../src/mcp.ts';
import { planktonTools } from '../src/mcp-tools.ts';

const INFO = { name: 'plankton', title: 'Plankton market data', version: '1.0.0', instructions: 'read only' };
const echo = tool({
  name: 'echo',
  title: 'Echo',
  description: 'returns its input',
  input: z.object({ text: z.string(), times: z.number().int().min(1).optional() }),
  run: async ({ text, times = 1 }) => ({ text: text.repeat(times), big: 10n ** 20n }),
});
const broken = tool({ name: 'broken', title: 'Broken', description: 'fails', input: z.object({}), run: async () => { throw new Error('upstream down'); } });
const call = (message: unknown, tools: McpTool[] = [echo, broken]) => handleMcp(message, tools, INFO) as Promise<RpcResponse & { result?: any; error?: any }>;

describe('MCP server', () => {
  test('initialize echoes a supported protocol version and offers tools', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo).toEqual({ name: 'plankton', title: 'Plankton market data', version: '1.0.0' });
  });

  test('an unknown protocol version gets the newest one we speak', async () => {
    const r = await call({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.id).toBe('a');
  });

  test('notifications are acknowledged with no answer', async () => {
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, [echo], INFO)).toBeNull();
    expect(await handleMcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }], [echo], INFO)).toBeNull();
  });

  test('tools/list describes every tool as read only, with an object JSON schema', async () => {
    const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const [first] = r.result.tools;
    expect(first.name).toBe('echo');
    expect(first.inputSchema.type).toBe('object');
    expect(first.inputSchema.required).toEqual(['text']);
    expect(first.annotations.readOnlyHint).toBe(true);
    expect(first.inputSchema.$schema).toBeUndefined();
  });

  test('tools/call returns text and structured content, with big integers as strings', async () => {
    const r = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ab', times: 2 } } });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent).toEqual({ text: 'abab', big: '100000000000000000000' });
    expect(JSON.parse(r.result.content[0].text).text).toBe('abab');
  });

  test('bad arguments and failing tools come back as tool errors the agent can read', async () => {
    const bad = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { times: 0 } } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('text');
    const failed = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'broken' } });
    expect(failed.result).toEqual({ content: [{ type: 'text', text: 'upstream down' }], isError: true });
  });

  test('protocol mistakes are JSON-RPC errors', async () => {
    expect((await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code).toBe(RPC.invalidParams);
    expect((await call({ jsonrpc: '2.0', id: 7, method: 'resources/read' })).error.code).toBe(RPC.methodNotFound);
    expect((await call({ id: 8, method: 'ping' })).error).toEqual({ code: RPC.invalidRequest, message: 'invalid JSON-RPC request' });
    expect((await call([])).error.code).toBe(RPC.invalidRequest);
  });

  test('a batch gets one answer per request, in order', async () => {
    const r = (await handleMcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
      [echo],
      INFO,
    )) as RpcResponse[];
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  test('a schema that is not an object still advertises an object', () => {
    expect(inputSchema(z.string())).toEqual({ type: 'object', properties: {} });
  });
});

describe('Plankton tools', () => {
  const calls: string[] = [];
  const get = async (path: string): Promise<any> => {
    calls.push(path);
    if (path === '/v1/scanner') {
      return {
        updatedAt: 'now',
        rows: [
          { symbol: 'A', changePct: 2, gapPct: -8, relativeVolume: 0.5, extended: null, floatTurnoverPct: 1, tags: ['gap_down'] },
          { symbol: 'B', changePct: 12, gapPct: 1, relativeVolume: 3, extended: { changePct: -9 }, floatTurnoverPct: 4, tags: ['runner', 'high_volume'] },
          { symbol: 'C', changePct: null, gapPct: null, relativeVolume: null, extended: null, floatTurnoverPct: null, tags: [] },
        ],
      };
    }
    if (path.startsWith('/v1/halts')) {
      return { updatedAt: 'now', halts: [{ symbol: 'RCAT', state: 'resumed', listed: true }, { symbol: 'EDBL', state: 'halted', listed: false }] };
    }
    if (path.startsWith('/v1/quote/preview')) {
      return { ok: true, execPriceE18: '3500000000000000000', markE18: '3490000000000000000', liquidationE18: null, feeUsdg: '600000', notionalUsdg: '750000000', maxLeverageE18: '3000000000000000000' };
    }
    if (path === '/v1/markets') {
      return [{ symbol: 'RCAT', class: 'small', markFeedUp: true, mark: { status: 'open', priceE18: '3525000000000000000', confidenceBps: 12 }, trading: { opensAllowed: true, maxLeverage: 3, positionCapUsdg: '1000000000', longRoomUsdg: '5000000', shortRoomUsdg: '0' } }];
    }
    return { path };
  };
  const tools = planktonTools(get);
  const run = (name: string, args: unknown) => call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);

  test('every tool has a unique snake_case name and an object schema', async () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(inputSchema(t.input).type).toBe('object');
    }
  });

  test('the scanner sorts by the chosen figure and filters by tag', async () => {
    const byChange = await run('get_scanner', {});
    expect(byChange.result.structuredContent.rows.map((r: any) => r.symbol)).toEqual(['B', 'A', 'C']);
    const byGap = await run('get_scanner', { sort: 'gap', limit: 1 });
    expect(byGap.result.structuredContent.rows.map((r: any) => r.symbol)).toEqual(['A']);
    const runners = await run('get_scanner', { tag: 'runner' });
    expect(runners.result.structuredContent.rows.map((r: any) => r.symbol)).toEqual(['B']);
  });

  test('halts can be narrowed to one symbol or to those still halted', async () => {
    const active = await run('get_halts', { active_only: true });
    expect(active.result.structuredContent.halts.map((h: any) => h.symbol)).toEqual(['EDBL']);
    await run('get_halts', { listed_only: true, symbol: 'rcat' });
    expect(calls.at(-1)).toBe('/v1/halts?listed=1');
  });

  test('a trade preview is sent in API units and answered with plain decimals', async () => {
    const r = await run('preview_trade', { market: 'rcat', side: 'long', margin_usdg: 250, leverage: 3 });
    expect(calls.at(-1)).toBe('/v1/quote/preview?market=RCAT&side=long&marginUsdg=250000000&leverage=3');
    expect(r.result.structuredContent).toMatchObject({ execPrice: 3.5, mark: 3.49, fee: 0.6, notional: 750, maxLeverage: 3, liquidationPrice: null });
  });

  test('markets come back with decimal prices and USDG limits', async () => {
    const r = await run('list_markets', {});
    expect(r.result.structuredContent.markets[0]).toMatchObject({ symbol: 'RCAT', status: 'open', price: 3.525, limits: { maxLeverage: 3, positionCapUsdg: 1000, longRoomUsdg: 5, shortRoomUsdg: 0 } });
  });

  test('symbols and addresses are checked before any request', async () => {
    const before = calls.length;
    expect((await run('get_price_sources', { symbol: '../admin' })).result.isError).toBe(true);
    expect((await run('get_account', { address: '0x123' })).result.isError).toBe(true);
    expect(calls.length).toBe(before);
    await run('get_filings', { symbol: 'qubt', flagged_only: true, limit: 5 });
    expect(calls.at(-1)).toBe('/v1/filings/QUBT?limit=5&flagged=1');
  });
});
