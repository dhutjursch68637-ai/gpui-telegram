import * as http from 'node:http';
import type { Socket } from 'node:net';
import { findFreeDualStackPort, registerAsyncCleanupHook } from '../harness/env.ts';

export interface ParsedToolResult {
  toolCallId: string;
  name?: string;
  rawContent: string;
  json: Record<string, any> | null;
}

export interface ChatMessageInput {
  role: string;
  content?: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  [extra: string]: any;
}

export interface MockLlmTurnContext {
  turnIndex: number;
  userPrompt: string;
  messages: ChatMessageInput[];
  toolResults: ParsedToolResult[];
  latestRoundToolResults: ParsedToolResult[];
  allHistoryToolResults: ParsedToolResult[];
  latestToolResult: ParsedToolResult | null;
  availableToolNames: string[];
  model: string;
  stream: boolean;
}

export interface MockLlmToolCallSpec {
  id?: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface MockLlmStepOutput {
  reasoning?: string;
  content?: string;
  toolCalls?: MockLlmToolCallSpec[];
  httpStatus?: number;
  headers?: Record<string, string>;
  errorBody?: Record<string, unknown>;
  delayMs?: number;
}

export type MockLlmScenarioHandler =
  | MockLlmStepOutput[]
  | ((ctx: MockLlmTurnContext) => MockLlmStepOutput | Promise<MockLlmStepOutput>);

export interface RecordedLlmRequest {
  timestampMs: number;
  path: string;
  headers: http.IncomingHttpHeaders;
  model: string;
  stream: boolean;
  messages: ChatMessageInput[];
  tools: any[];
  availableToolNames: string[];
  matchedScenarioId: string | null;
  turnIndex: number;
}

export interface MockLlmServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly v1BaseUrl: string;
  readonly localhostV1BaseUrl: string;
  readonly recordedRequests: RecordedLlmRequest[];
  registerScenario(scenarioId: string, handler: MockLlmScenarioHandler): void;
  enqueueScenario(handler: MockLlmScenarioHandler): void;
  enqueueStep(step: MockLlmStepOutput): void;
  setStickyError(httpStatus: number, errorBody?: Record<string, unknown>, headers?: Record<string, string>): void;
  clearStickyError(): void;
  reset(): void;
  stop(): Promise<void>;
}

const SCENARIO_TAG_RE = /\[E2E_SCENARIO:([a-zA-Z0-9_.:-]+)\]/;

function extractMessageText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function parseToolMessage(msg: ChatMessageInput): ParsedToolResult {
  const rawContent = extractMessageText(msg.content);
  let json: Record<string, any> | null = null;
  if (rawContent.trim().startsWith('{') || rawContent.trim().startsWith('[')) {
    try {
      json = JSON.parse(rawContent);
    } catch {
      json = null;
    }
  }
  return {
    toolCallId: String(msg.tool_call_id ?? ''),
    name: typeof msg.name === 'string' ? msg.name : undefined,
    rawContent,
    json,
  };
}

function buildTurnContext(
  messages: ChatMessageInput[],
  tools: any[],
  model: string,
  stream: boolean,
): { ctx: MockLlmTurnContext; scenarioId: string | null } {
  let lastUserIdx = -1;
  let scenarioId: string | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      if (lastUserIdx === -1) {
        lastUserIdx = i;
      }
      if (!scenarioId) {
        const text = extractMessageText(m.content);
        const match = SCENARIO_TAG_RE.exec(text);
        if (match) {
          scenarioId = match[1];
        }
      }
    }
  }

  // Also check system messages if tag was placed in system prompt
  if (!scenarioId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractMessageText(messages[i].content);
      const match = SCENARIO_TAG_RE.exec(text);
      if (match) {
        scenarioId = match[1];
        break;
      }
    }
  }

  const userPrompt =
    lastUserIdx >= 0 ? extractMessageText(messages[lastUserIdx].content) : '';
  const sliceStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;

  let assistantToolRounds = 0;
  let lastAssistantRoundIdx = -1;
  const currentTurnToolResults: ParsedToolResult[] = [];

  for (let i = sliceStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      assistantToolRounds++;
      lastAssistantRoundIdx = i;
    } else if (m.role === 'tool') {
      currentTurnToolResults.push(parseToolMessage(m));
    }
  }

  const latestRoundToolResults: ParsedToolResult[] = [];
  if (lastAssistantRoundIdx >= 0) {
    for (let i = lastAssistantRoundIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        latestRoundToolResults.push(parseToolMessage(messages[i]));
      }
    }
  }

  const allHistoryToolResults = messages
    .filter((m) => m.role === 'tool')
    .map(parseToolMessage);

  // If caller supplied tool messages without preceding assistant message, fall back to tool count
  const turnIndex =
    assistantToolRounds > 0
      ? assistantToolRounds
      : currentTurnToolResults.length > 0
        ? currentTurnToolResults.length
        : 0;

  const availableToolNames = Array.isArray(tools)
    ? tools
        .map((t) => (typeof t?.function?.name === 'string' ? t.function.name : t?.name))
        .filter((n): n is string => typeof n === 'string')
    : [];

  const latestToolResult =
    currentTurnToolResults.length > 0
      ? currentTurnToolResults[currentTurnToolResults.length - 1]
      : allHistoryToolResults.length > 0
        ? allHistoryToolResults[allHistoryToolResults.length - 1]
        : null;

  return {
    scenarioId,
    ctx: {
      turnIndex,
      userPrompt,
      messages,
      toolResults: currentTurnToolResults,
      latestRoundToolResults,
      allHistoryToolResults,
      latestToolResult,
      availableToolNames,
      model,
      stream,
    },
  };
}

function readJsonRequest(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sleepAbortable(ms: number, req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      req.off('close', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    req.once('close', onAbort);
  });
}

export async function startMockLlmServer(
  explicitPort?: number,
): Promise<MockLlmServerHandle> {
  const port = explicitPort ?? (await findFreeDualStackPort());
  const recordedRequests: RecordedLlmRequest[] = [];
  const scenarios = new Map<string, MockLlmScenarioHandler>();
  const fifoQueue: Array<{
    kind: 'scenario' | 'single_step';
    handler: MockLlmScenarioHandler;
  }> = [];
  let stickyError: {
    httpStatus: number;
    errorBody: Record<string, unknown>;
    headers?: Record<string, string>;
  } | null = null;
  let seqCounter = 1;
  const sockets = new Set<Socket>();

  const resolveStep = async (
    scenarioId: string | null,
    ctx: MockLlmTurnContext,
  ): Promise<MockLlmStepOutput> => {
    if (stickyError) {
      return {
        httpStatus: stickyError.httpStatus,
        errorBody: stickyError.errorBody,
        headers: stickyError.headers,
      };
    }

    const evaluateHandler = async (
      handler: MockLlmScenarioHandler,
    ): Promise<MockLlmStepOutput> => {
      if (Array.isArray(handler)) {
        if (ctx.turnIndex < handler.length) {
          return handler[ctx.turnIndex];
        }
        return { content: 'Completed scripted scenario steps.' };
      }
      return await handler(ctx);
    };

    if (scenarioId && scenarios.has(scenarioId)) {
      return await evaluateHandler(scenarios.get(scenarioId)!);
    }

    if (fifoQueue.length > 0) {
      const head = fifoQueue[0];
      if (head.kind === 'single_step') {
        fifoQueue.shift();
        const arr = head.handler as MockLlmStepOutput[];
        return arr[0];
      }
      const step = await evaluateHandler(head.handler);
      const hasMoreTools = Array.isArray(step.toolCalls) && step.toolCalls.length > 0;
      if (!hasMoreTools || (step.httpStatus !== undefined && step.httpStatus >= 400)) {
        fifoQueue.shift();
      }
      return step;
    }

    const cleanExcerpt = ctx.userPrompt.replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      content: `MockLLM default response: ${cleanExcerpt || 'acknowledged'}`,
    };
  };

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, `http://127.0.0.1:${port}`);
    const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port }));
      return;
    }

    if (
      (pathname === '/v1/models' ||
        pathname === '/models' ||
        pathname === '/api/v1/magpie/v1/models') &&
      req.method === 'GET'
    ) {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1760000000, owned_by: 'e2e-mock' },
            { id: 'mock-hermes-v1', object: 'model', created: 1760000000, owned_by: 'e2e-mock' },
            { id: 'mock-browser-agent-v1', object: 'model', created: 1760000000, owned_by: 'e2e-mock' },
            { id: 'e2e-browser-agent', object: 'model', created: 1760000000, owned_by: 'e2e-mock' },
          ],
        }),
      );
      return;
    }

    if (
      (pathname === '/v1/chat/completions' ||
        pathname === '/chat/completions' ||
        pathname === '/api/v1/magpie/v1/chat/completions') &&
      req.method === 'POST'
    ) {
      let body: Record<string, any>;
      try {
        body = await readJsonRequest(req);
      } catch {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
        return;
      }

      const model = typeof body.model === 'string' ? body.model : 'gpt-4o';
      const stream = body.stream === true;
      const messages: ChatMessageInput[] = Array.isArray(body.messages) ? body.messages : [];
      const tools: any[] = Array.isArray(body.tools) ? body.tools : [];

      const { ctx, scenarioId } = buildTurnContext(messages, tools, model, stream);
      recordedRequests.push({
        timestampMs: Date.now(),
        path: pathname,
        headers: req.headers,
        model,
        stream,
        messages,
        tools,
        availableToolNames: ctx.availableToolNames,
        matchedScenarioId: scenarioId,
        turnIndex: ctx.turnIndex,
      });

      const step = await resolveStep(scenarioId, ctx);

      if (step.delayMs && step.delayMs > 0) {
        const alive = await sleepAbortable(step.delayMs, req);
        if (!alive || res.destroyed) return;
      }

      if (step.httpStatus && step.httpStatus >= 400) {
        res.writeHead(step.httpStatus, {
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...(step.httpStatus === 429 ? { 'Retry-After': '1' } : {}),
          ...(step.headers ?? {}),
        });
        res.end(
          JSON.stringify(
            step.errorBody ?? {
              error: {
                message: `Simulated upstream HTTP ${step.httpStatus}`,
                type: 'upstream_error',
                code: String(step.httpStatus),
              },
            },
          ),
        );
        return;
      }

      const cmplId = `chatcmpl_e2e_${seqCounter++}`;
      const created = Math.floor(Date.now() / 1000);
      const formattedToolCalls = (step.toolCalls ?? []).map((tc, idx) => ({
        id: tc.id ?? `call_e2e_${seqCounter}_${idx}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments:
            typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      }));
      const hasTools = formattedToolCalls.length > 0;
      const finishReason = hasTools ? 'tool_calls' : 'stop';
      const contentText = step.content ?? (hasTools ? '' : '');
      const usage = {
        prompt_tokens: 64,
        completion_tokens: 32,
        total_tokens: 96,
      };

      if (!stream) {
        res.writeHead(200, {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...(step.headers ?? {}),
        });
        res.end(
          JSON.stringify({
            id: cmplId,
            object: 'chat.completion',
            created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  ...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
                  content: hasTools && !contentText ? null : contentText,
                  ...(hasTools ? { tool_calls: formattedToolCalls } : {}),
                },
                finish_reason: finishReason,
              },
            ],
            usage,
          }),
        );
        return;
      }

      // Multi-chunk SSE streaming response
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(step.headers ?? {}),
      });

      const writeChunk = (delta: Record<string, unknown>, finish: string | null = null, includeUsage = false): void => {
        if (res.destroyed || res.writableEnded) return;
        const frame: Record<string, unknown> = {
          id: cmplId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finish,
            },
          ],
        };
        if (includeUsage) {
          frame.usage = usage;
        }
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      };

      // Chunk 1: assistant role + optional reasoning_content
      writeChunk({
        role: 'assistant',
        ...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
      });

      // Chunk 2..3: split content across 2 deltas when non-empty
      if (contentText.length > 0) {
        if (contentText.length > 6) {
          const mid = Math.ceil(contentText.length / 2);
          writeChunk({ content: contentText.slice(0, mid) });
          writeChunk({ content: contentText.slice(mid) });
        } else {
          writeChunk({ content: contentText });
        }
      }

      // Chunk K..M: split each tool_call arguments across 2 chunks to exercise SSE delta assembly
      for (let idx = 0; idx < formattedToolCalls.length; idx++) {
        const tc = formattedToolCalls[idx];
        const argStr = tc.function.arguments;
        const splitAt = Math.max(1, Math.floor(argStr.length / 2));
        const partA = argStr.slice(0, splitAt);
        const partB = argStr.slice(splitAt);

        writeChunk({
          tool_calls: [
            {
              index: idx,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: partA,
              },
            },
          ],
        });

        if (partB.length > 0) {
          writeChunk({
            tool_calls: [
              {
                index: idx,
                function: {
                  arguments: partB,
                },
              },
            ],
          });
        }
      }

      // Final chunk with finish_reason + usage + [DONE]
      writeChunk({}, finishReason, true);
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }

    res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: pathname }));
  };

  const router = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  };

  const srv4 = http.createServer(router);
  const srv6 = http.createServer(router);

  const trackConn = (sock: Socket): void => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  };
  srv4.on('connection', trackConn);
  srv6.on('connection', trackConn);

  await new Promise<void>((resolve, reject) => {
    srv4.once('error', reject);
    srv4.listen(port, '127.0.0.1', () => resolve());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      srv6.once('error', reject);
      srv6.listen(port, '::1', () => resolve());
    });
  } catch (err) {
    srv4.close();
    throw err;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    unregisterHook();
    for (const s of sockets) {
      s.destroy();
    }
    sockets.clear();
    await Promise.all([
      new Promise<void>((resolve) => srv4.close(() => resolve())),
      new Promise<void>((resolve) => srv6.close(() => resolve())),
    ]);
  };

  const unregisterHook = registerAsyncCleanupHook(stop);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    v1BaseUrl: `http://127.0.0.1:${port}/v1`,
    localhostV1BaseUrl: `http://localhost:${port}/v1`,
    recordedRequests,
    registerScenario(scenarioId: string, handler: MockLlmScenarioHandler): void {
      scenarios.set(scenarioId, handler);
    },
    enqueueScenario(handler: MockLlmScenarioHandler): void {
      fifoQueue.push({ kind: 'scenario', handler });
    },
    enqueueStep(step: MockLlmStepOutput): void {
      fifoQueue.push({ kind: 'single_step', handler: [step] });
    },
    setStickyError(
      httpStatus: number,
      errorBody: Record<string, unknown> = {},
      headers?: Record<string, string>,
    ): void {
      stickyError = { httpStatus, errorBody, headers };
    },
    clearStickyError(): void {
      stickyError = null;
    },
    reset(): void {
      recordedRequests.length = 0;
      scenarios.clear();
      fifoQueue.length = 0;
      stickyError = null;
    },
    stop,
  };
}
