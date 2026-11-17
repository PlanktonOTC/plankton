import { z } from 'zod';

// A read-only Model Context Protocol server over plain HTTP (the "Streamable HTTP" transport, answering with JSON, no
// sessions). Agents and bots connect to POST /mcp and get the same public market data as the website: prices, marks and
// their sources, the Tape (scanner, halts, filings, catalysts), trade previews and account state. Nothing here signs,
// sends a transaction or changes state.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST = PROTOCOL_VERSIONS[0];

export interface McpTool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (args: z.infer<S>) => Promise<unknown>;
}

export const tool = <S extends z.ZodType>(t: McpTool<S>): McpTool => t as unknown as McpTool;

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

type Id = string | number | null;
interface RpcError {
  jsonrpc: '2.0';
  id: Id;
  error: { code: number; message: string; data?: unknown };
}
interface RpcResult {
  jsonrpc: '2.0';
  id: Id;
  result: unknown;
}
export type RpcResponse = RpcError | RpcResult;

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

const request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const fail = (id: Id, code: number, message: string): RpcError => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: Id, result: unknown): RpcResult => ({ jsonrpc: '2.0', id, result });

const jsonText = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

/** JSON Schema for a tool's arguments, in the shape MCP clients expect (always an object). */
export function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out.type === 'object' ? out : { type: 'object', properties: {} };
}

/**
 * Answer one JSON-RPC message (or a batch). Returns null when nothing is owed back: a notification, or a batch made only
 * of notifications. The HTTP layer turns null into 202 Accepted.
 */
export async function handleMcp(message: unknown, tools: McpTool[], info: ServerInfo): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(message)) {
    if (message.length === 0) return fail(null, RPC.invalidRequest, 'empty batch');
    const answers = (await Promise.all(message.map((m) => handleOne(m, tools, info)))).filter((a): a is RpcResponse => a !== null);
    return answers.length ? answers : null;
  }
  return handleOne(message, tools, info);
}

async function handleOne(message: unknown, tools: McpTool[], info: ServerInfo): Promise<RpcResponse | null> {
  const parsed = request.safeParse(message);
  if (!parsed.success) {
    const id = (message as { id?: unknown } | null)?.id;
    return fail(typeof id === 'string' || typeof id === 'number' ? id : null, RPC.invalidRequest, 'invalid JSON-RPC request');
  }
  const { id, method, params = {} } = parsed.data;
  // A message without an id is a notification (notifications/initialized, cancellations): acknowledged, never answered.
  if (id === undefined) return null;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: info.title, version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: inputSchema(t.input),
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const t = tools.find((x) => x.name === name);
      if (!t) return fail(id, RPC.invalidParams, `unknown tool: ${name || '(none)'}`);
      const args = t.input.safeParse(params.arguments ?? {});
      if (!args.success) {
        const why = args.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
        return ok(id, { content: [{ type: 'text', text: `Invalid arguments. ${why}` }], isError: true });
      }
      try {
        const value = await t.run(args.data);
        const result: Record<string, unknown> = { content: [{ type: 'text', text: jsonText(value) }] };
        if (value && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = JSON.parse(jsonText(value));
        return ok(id, result);
      } catch (err) {
        // A tool failure is an answer the agent can read and act on, not a protocol error.
        return ok(id, { content: [{ type: 'text', text: (err as Error).message || 'the tool failed' }], isError: true });
      }
    }
    default:
      return fail(id, RPC.methodNotFound, `method not found: ${method}`);
  }
}
