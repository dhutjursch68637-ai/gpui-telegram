/**
 * In-Extension AI Bot Runner (`ext_bot_runner.ts`).
 * Executes inside the MV3 Service Worker with:
 * - Zero-LLM local `/browser` & `/interrupt` slash command handling
 * - OpenAI / Magpie Gateway SSE streaming & JSON tool-calling loop (`max_iterations`, 429 `Retry-After`)
 * - Anthropic Messages API, Gemini `generateContent`, and offline `LocalHermes` modes
 * - Instant `AbortController` cancellation on UI Stop / `/interrupt` / `Alt+Shift+S`
 */

import {
  BROWSER_TOOL_DEFINITIONS,
  BrowserRpcError,
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  type StoredMessageDto,
  type StoredToolStepDto,
  type SwToUiEvent,
} from '../shared/rpc_types';
import { dbGetMessagesForChat, dbUpsertMessages, readNormalizedStorageConfig } from './db';
import type { BrowserController } from './browser_controller';
import type { BrowserPolicyEngine } from './policy_engine';

type BroadcastFn = (event: SwToUiEvent) => void;

interface ParsedTurnOutput {
  reasoning: string;
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    argumentsJson: string;
  }>;
}

function splitThinkTags(rawText: string): { thinking: string; visible: string } {
  const thinkBlocks: string[] = [];
  const cleaned = rawText.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    if (inner && String(inner).trim()) {
      thinkBlocks.push(String(inner).trim());
    }
    return '';
  });
  return {
    thinking: thinkBlocks.join('\n\n').trim(),
    visible: cleaned.trim(),
  };
}

export class ExtensionBotRunner {
  private readonly controller: BrowserController;
  private readonly policy: BrowserPolicyEngine;
  private readonly broadcast: BroadcastFn;

  private activeAbort: AbortController | null = null;
  private activeRunId: string | null = null;
  private activeChatId: number = LOCAL_COPILOT_CHAT_ID;
  private localMsgCounter = 10_000;

  constructor(
    controller: BrowserController,
    policy: BrowserPolicyEngine,
    broadcast: BroadcastFn,
  ) {
    this.controller = controller;
    this.policy = policy;
    this.broadcast = broadcast;

    this.policy.onEmergencyStop(() => {
      this.cancelActiveRun('Emergency stop');
    });
  }

  public isStreaming(): boolean {
    return this.activeAbort !== null;
  }

  public getActiveRunId(): string | null {
    return this.activeRunId;
  }

  private nextLocalMessageId(): number {
    this.localMsgCounter += 1;
    return Date.now() * 10 + (this.localMsgCounter % 10);
  }

  public cancelActiveRun(_reason = 'Cancelled by user'): boolean {
    if (!this.activeAbort) return false;
    try {
      this.activeAbort.abort();
    } catch {
      // ignore
    }
    this.activeAbort = null;
    this.activeRunId = null;
    return true;
  }

  public async handleUserPrompt(params: {
    chatId?: number;
    text: string;
  }): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    const chatId = params.chatId ?? LOCAL_COPILOT_CHAT_ID;
    const promptText = params.text.trim();
    if (!promptText) {
      return { ok: false, error: 'Empty prompt' };
    }

    // 1. Immediate cancellation slash commands (/interrupt, /stop, /cancel)
    if (/^\/(interrupt|stop|cancel)\b/i.test(promptText)) {
      this.cancelActiveRun('User sent /interrupt');
      const cfg = await readNormalizedStorageConfig();
      const userBubble: StoredMessageDto = {
        chat_id: chatId,
        message_id: this.nextLocalMessageId(),
        sender_id: cfg.userId ?? 1,
        sender_username: cfg.username ?? 'me',
        text: promptText,
        created_at_ms: Date.now(),
      };
      const ackBubble: StoredMessageDto = {
        chat_id: chatId,
        message_id: this.nextLocalMessageId(),
        sender_id: OFFICIAL_BOT_USER_ID,
        sender_username: 'hermes_browser_copilot',
        text: 'Stopped active generation.',
        created_at_ms: Date.now() + 1,
      };
      await dbUpsertMessages([userBubble, ackBubble]);
      await this.emitChatMessages(chatId);
      return { ok: true, cancelled: true };
    }

    // Cancel any overlapping run before starting the new turn
    if (this.activeAbort) {
      this.cancelActiveRun('Superseded by new prompt');
    }

    const cfg = await readNormalizedStorageConfig();
    const userMsg: StoredMessageDto = {
      chat_id: chatId,
      message_id: this.nextLocalMessageId(),
      sender_id: cfg.userId ?? 1,
      sender_username: cfg.username ?? 'me',
      text: promptText,
      created_at_ms: Date.now(),
    };
    await dbUpsertMessages([userMsg]);
    await this.emitChatMessages(chatId);

    // 2. Local /browser slash commands execute directly with ZERO external LLM calls!
    if (/^\/browser(\s|$)/i.test(promptText)) {
      await this.executeLocalBrowserSlashCommand(chatId, promptText);
      return { ok: true };
    }

    // 3. Multi-turn Agent Loop
    const abortController = new AbortController();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.activeAbort = abortController;
    this.activeRunId = runId;
    this.activeChatId = chatId;

    const assistantMsgId = this.nextLocalMessageId();
    const assistantMsg: StoredMessageDto = {
      chat_id: chatId,
      message_id: assistantMsgId,
      sender_id: OFFICIAL_BOT_USER_ID,
      sender_username: 'hermes_browser_copilot',
      text: '…',
      thinking: '',
      tool_steps: [],
      created_at_ms: Date.now() + 1,
    };

    await dbUpsertMessages([assistantMsg]);
    this.broadcast({
      type: 'bot_stream_delta',
      chat_id: chatId,
      message: assistantMsg,
      streaming: true,
    });

    try {
      await this.runProviderAgentLoop({
        chatId,
        promptText,
        assistantMsg,
        providerCfg: cfg.extBotConfig ?? {},
        signal: abortController.signal,
      });
      return { ok: true };
    } catch (err: any) {
      if (abortController.signal.aborted || err?.name === 'AbortError') {
        // Keep clean cancelled state without rendering half-aborted completion markers
        assistantMsg.text = assistantMsg.tool_steps?.length
          ? 'Generation stopped by user.'
          : 'Stopped.';
        await dbUpsertMessages([assistantMsg]);
        this.broadcast({
          type: 'bot_stream_delta',
          chat_id: chatId,
          message: assistantMsg,
          streaming: false,
        });
        await this.emitChatMessages(chatId);
        return { ok: true, cancelled: true };
      }

      const readableErr = String(err?.message ?? err);
      assistantMsg.text = `Error: ${readableErr}`;
      assistantMsg.is_error = true;
      await dbUpsertMessages([assistantMsg]);
      this.broadcast({
        type: 'bot_stream_delta',
        chat_id: chatId,
        message: assistantMsg,
        streaming: false,
      });
      await this.emitChatMessages(chatId);
      return { ok: false, error: readableErr };
    } finally {
      if (this.activeAbort === abortController) {
        this.activeAbort = null;
        this.activeRunId = null;
      }
      this.broadcast({
        type: 'bot_stream_delta',
        chat_id: chatId,
        message: assistantMsg,
        streaming: false,
      });
    }
  }

  private async emitChatMessages(chatId: number): Promise<void> {
    const messages = await dbGetMessagesForChat(chatId, 200);
    this.broadcast({ type: 'messages_updated', chat_id: chatId, messages });
  }

  private async executeLocalBrowserSlashCommand(chatId: number, rawCmd: string): Promise<void> {
    const rest = rawCmd.replace(/^\/browser\s*/i, '').trim();
    const [subRaw = 'status', ...argParts] = rest.split(/\s+/);
    const sub = (subRaw || 'status').toLowerCase();
    const argTail = argParts.join(' ').trim();

    let replyText = '';
    let mediaDataUrl: string | undefined;
    const steps: StoredToolStepDto[] = [];

    try {
      if (sub === 'status' || sub === '') {
        const res = await this.controller.invokeTool(
          'browser_status',
          {},
          { bypassInteractiveApproval: true },
        );
        steps.push({
          id: 'slash-status',
          tool: 'browser_status',
          args: {},
          status: 'done',
          result_summary: `policy=${res.run_policy}`,
        });
        replyText = [
          `Browser Extension: connected (online)`,
          `• Policy: ${res.run_policy}`,
          `• Server Relay: ${res.server_relay_connected ? 'connected' : 'disconnected'}`,
          `• Desktop Bridge: ${res.desktop_bridge_connected ? 'connected' : 'disconnected'}`,
          `• Active Tabs: ${res.active_tabs} (${res.controllable_tabs} controllable)`,
        ].join('\n');
      } else if (sub === 'tabs' || sub === 'list') {
        const res = await this.controller.invokeTool(
          'browser_list_tabs',
          {},
          { bypassInteractiveApproval: true },
        );
        const tabs = (res.tabs as any[]) ?? [];
        steps.push({
          id: 'slash-tabs',
          tool: 'browser_list_tabs',
          args: {},
          status: 'done',
          result_summary: `${tabs.length} tab(s)`,
        });
        replyText =
          tabs.length === 0
            ? 'No open tabs.'
            : [
                `Open Browser Tabs (${tabs.length}):`,
                ...tabs.map(
                  (t) =>
                    `• [${t.tab_id}] ${t.active ? '★ ' : ''}${t.title || '(Untitled)'} — ${t.url}`,
                ),
              ].join('\n');
      } else if (sub === 'snapshot' || sub === 'snap') {
        const res = await this.controller.invokeTool(
          'browser_snapshot',
          {},
          { bypassInteractiveApproval: true },
        );
        const els = (res.interactive_elements as any[]) ?? [];
        steps.push({
          id: 'slash-snapshot',
          tool: 'browser_snapshot',
          args: {},
          status: 'done',
          result_summary: `${els.length} interactive refs`,
        });
        replyText = [
          `Snapshot: ${res.title || '(Untitled)'}`,
          `URL: ${res.url}`,
          `Interactive Elements: ${els.length}`,
          els
            .slice(0, 8)
            .map((e) => `  [${e.ref}] <${e.tag}> ${e.label || e.text || e.selector}`)
            .join('\n'),
          res.markdown_excerpt ? `\nExcerpt:\n${String(res.markdown_excerpt).slice(0, 600)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      } else if ((sub === 'open' || sub === 'navigate' || sub === 'goto') && argTail) {
        const tool = sub === 'open' ? 'browser_open_tab' : 'browser_navigate';
        const res = await this.controller.invokeTool(
          tool,
          { url: argTail },
          { bypassInteractiveApproval: true },
        );
        replyText = `${sub === 'open' ? 'Opened' : 'Navigated to'} ${res.title || argTail} (${res.url})`;
      } else if (sub === 'screenshot' || sub === 'shot') {
        const res = await this.controller.invokeTool(
          'browser_screenshot',
          { format: 'png' },
          { bypassInteractiveApproval: true },
        );
        if (typeof res.data_base64 === 'string' && res.data_base64) {
          mediaDataUrl = `data:${res.mime_type || 'image/png'};base64,${res.data_base64}`;
        }
        replyText = `Captured screenshot of ${res.title || res.url} (${res.width}x${res.height}).`;
      } else if (sub === 'off' || sub === 'disable') {
        await this.policy.setPolicy('disabled');
        replyText = 'Browser control policy set to disabled.';
      } else if (sub === 'on' || sub === 'enable') {
        await this.policy.setPolicy('always_allow_authorized');
        replyText = 'Browser control policy set to always_allow_authorized.';
      } else {
        replyText =
          'Usage: `/browser status`, `/browser tabs`, `/browser snapshot`, `/browser open <url>`, `/browser screenshot`, `/browser on|off`';
      }
    } catch (err: any) {
      replyText = `Browser command error: ${String(err?.message ?? err)}`;
    }

    const botMsg: StoredMessageDto = {
      chat_id: chatId,
      message_id: this.nextLocalMessageId(),
      sender_id: OFFICIAL_BOT_USER_ID,
      sender_username: 'hermes_browser_copilot',
      text: replyText,
      tool_steps: steps.length > 0 ? steps : undefined,
      media_data_url: mediaDataUrl,
      created_at_ms: Date.now() + 2,
    };
    await dbUpsertMessages([botMsg]);
    await this.emitChatMessages(chatId);
  }

  private async runProviderAgentLoop(opts: {
    chatId: number;
    promptText: string;
    assistantMsg: StoredMessageDto;
    providerCfg: Record<string, any>;
    signal: AbortSignal;
  }): Promise<void> {
    const { chatId, promptText, assistantMsg, providerCfg, signal } = opts;

    const providerId = String(
      providerCfg.provider_id ?? providerCfg.provider ?? providerCfg.api_mode ?? 'openai',
    )
      .trim()
      .toLowerCase();
    const baseUrl = String(providerCfg.base_url ?? providerCfg.baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    const apiKey = String(providerCfg.api_key ?? providerCfg.apiKey ?? '').trim();
    const model = String(providerCfg.model ?? providerCfg.default_model ?? 'gpt-4o').trim();

    const maxIterations = Math.min(
      25,
      Math.max(
        1,
        Number(
          providerCfg.max_iterations ??
            providerCfg.maxIterations ??
            providerCfg.max_tool_iterations ??
            10,
        ),
      ),
    );

    // Deterministic LocalHermes offline mode (zero external HTTP calls)
    if (providerId === 'local_hermes' || providerCfg.api_mode === 'local_hermes' || !baseUrl) {
      const snap = await this.controller
        .invokeTool('browser_list_tabs', {}, { bypassInteractiveApproval: true })
        .catch(() => ({ tabs: [] }));
      const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];
      assistantMsg.thinking = 'Running LocalHermes deterministic offline assistant...';
      assistantMsg.text = [
        `LocalHermes Offline Assistant ready (${tabs.length} open tab${tabs.length === 1 ? '' : 's'}).`,
        ...tabs.slice(0, 5).map((t: any) => `• [${t.tab_id}] ${t.title || '(Untitled)'} — ${t.url}`),
        `Prompt received: "${promptText}"`,
      ].join('\n');
      await dbUpsertMessages([assistantMsg]);
      await this.emitChatMessages(chatId);
      return;
    }

    const conversation: Array<Record<string, any>> = [
      {
        role: 'system',
        content:
          'You are Hermes Browser Copilot inside the GPUI Telegram Chrome Extension. ' +
          'Use the browser_* tools to inspect pages via browser_snapshot and interact accurately using [ref=eN] or CSS selectors.',
      },
      {
        role: 'user',
        content: promptText,
      },
    ];

    for (let iter = 0; iter < maxIterations; iter++) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const turn = await this.callModelTurn({
        providerId,
        baseUrl,
        apiKey,
        model,
        messages: conversation,
        signal,
        onStreamProgress: (partialThinking, partialText) => {
          if (signal.aborted) return;
          if (partialThinking) {
            assistantMsg.thinking = partialThinking;
          }
          if (partialText) {
            assistantMsg.text = partialText;
          }
          this.broadcast({
            type: 'bot_stream_delta',
            chat_id: chatId,
            message: { ...assistantMsg },
            streaming: true,
          });
        },
      });

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const parsedThink = splitThinkTags(turn.content);
      const combinedThinking = [turn.reasoning, parsedThink.thinking]
        .filter(Boolean)
        .join('\n')
        .trim();
      if (combinedThinking) {
        assistantMsg.thinking = combinedThinking;
      }

      if (turn.toolCalls.length === 0) {
        assistantMsg.text = parsedThink.visible || turn.content || 'Done.';
        await dbUpsertMessages([assistantMsg]);
        await this.emitChatMessages(chatId);
        return;
      }

      // Record assistant tool_calls turn in conversation history
      conversation.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.argumentsJson || '{}',
          },
        })),
      });

      // Execute each requested tool call sequentially and feed structured JSON result back
      for (const tc of turn.toolCalls) {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {};
        } catch {
          parsedArgs = {};
        }

        const stepDto: StoredToolStepDto = {
          id: tc.id,
          tool: tc.name,
          args: parsedArgs,
          status: 'running',
        };
        assistantMsg.tool_steps = [...(assistantMsg.tool_steps ?? []), stepDto];
        assistantMsg.text = `🔧 Running ${tc.name}…`;
        await dbUpsertMessages([assistantMsg]);
        this.broadcast({
          type: 'bot_stream_delta',
          chat_id: chatId,
          message: { ...assistantMsg },
          streaming: true,
        });

        let toolResultObj: Record<string, unknown>;
        try {
          toolResultObj = await this.controller.invokeTool(tc.name, parsedArgs, {
            botUserId: OFFICIAL_BOT_USER_ID,
            botUsername: 'hermes_browser_copilot',
            chatId,
          });
          stepDto.status = 'done';
          stepDto.result_summary = 'ok';
          if (
            tc.name === 'browser_screenshot' &&
            typeof toolResultObj.data_base64 === 'string' &&
            toolResultObj.data_base64
          ) {
            const dataUrl = `data:${toolResultObj.mime_type || 'image/png'};base64,${toolResultObj.data_base64}`;
            stepDto.screenshot_data_url = dataUrl;
            assistantMsg.media_data_url = dataUrl;
          }
        } catch (toolErr: any) {
          // Structured error feedback so LLM can self-recover on next turn (never crash runner!)
          stepDto.status = 'error';
          const errCode =
            toolErr instanceof BrowserRpcError ? toolErr.errorCode : 'TOOL_EXECUTION_ERROR';
          const errMsg = String(toolErr?.message ?? toolErr);
          stepDto.result_summary = `${errCode}: ${errMsg}`;
          toolResultObj = {
            ok: false,
            error: errMsg,
            error_code: errCode,
            code: toolErr instanceof BrowserRpcError ? toolErr.code : -32603,
          };
        }

        await dbUpsertMessages([assistantMsg]);
        this.broadcast({
          type: 'bot_stream_delta',
          chat_id: chatId,
          message: { ...assistantMsg },
          streaming: true,
        });

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(toolResultObj),
        });
      }
    }

    // Reached maxIterations cap cleanly without infinite looping
    assistantMsg.text = `Stopped after reaching maximum tool iterations (${maxIterations}).`;
    await dbUpsertMessages([assistantMsg]);
    await this.emitChatMessages(chatId);
  }

  private async fetchWithRateLimitRetry(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    let lastResp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch(url, { ...init, signal });
      if (resp.status !== 429) {
        return resp;
      }
      lastResp = resp;
      const retryHeader = resp.headers.get('retry-after');
      const retrySeconds = retryHeader ? Number(retryHeader) : 1;
      const waitMs = Math.min(
        2500,
        Math.max(250, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 800),
      );
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, waitMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }
    return lastResp!;
  }

  private async callModelTurn(params: {
    providerId: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: Array<Record<string, any>>;
    signal: AbortSignal;
    onStreamProgress: (thinking: string, content: string) => void;
  }): Promise<ParsedTurnOutput> {
    if (params.providerId === 'anthropic') {
      return this.callAnthropicTurn(params);
    }
    if (params.providerId === 'gemini') {
      return this.callGeminiTurn(params);
    }
    return this.callOpenAiCompatibleTurn(params);
  }

  private async callOpenAiCompatibleTurn(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: Array<Record<string, any>>;
    signal: AbortSignal;
    onStreamProgress: (thinking: string, content: string) => void;
  }): Promise<ParsedTurnOutput> {
    const endpoint = params.baseUrl.endsWith('/chat/completions')
      ? params.baseUrl
      : `${params.baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }

    const resp = await this.fetchWithRateLimitRetry(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          tools: BROWSER_TOOL_DEFINITIONS,
          tool_choice: 'auto',
          stream: true,
        }),
      },
      params.signal,
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      let parsedMsg = errBody;
      try {
        const j = JSON.parse(errBody);
        parsedMsg = j?.error?.message || j?.message || errBody;
      } catch {
        // keep raw
      }
      throw new Error(`HTTP ${resp.status}: ${parsedMsg || resp.statusText}`);
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream') || !resp.body) {
      const json = (await resp.json()) as Record<string, any>;
      const choice = json?.choices?.[0]?.message ?? {};
      const toolCalls = Array.isArray(choice.tool_calls)
        ? choice.tool_calls.map((tc: any, idx: number) => ({
            id: String(tc.id || `call_${idx}`),
            name: String(tc.function?.name ?? ''),
            argumentsJson:
              typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
          }))
        : [];
      return {
        reasoning: String(choice.reasoning_content ?? choice.reasoning ?? ''),
        content: String(choice.content ?? ''),
        toolCalls,
      };
    }

    // Parse SSE stream (assembling multi-chunk text, reasoning_content, and tool_calls arguments)
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let reasoningAcc = '';
    let contentAcc = '';
    const toolAcc = new Map<number, { id: string; name: string; argumentsJson: string }>();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!rawLine || !rawLine.startsWith('data:')) continue;

          const dataPayload = rawLine.slice(5).trim();
          if (!dataPayload || dataPayload === '[DONE]') continue;

          let chunk: Record<string, any>;
          try {
            chunk = JSON.parse(dataPayload);
          } catch {
            continue;
          }

          if (chunk.error) {
            throw new Error(String(chunk.error.message ?? JSON.stringify(chunk.error)));
          }

          const delta = chunk?.choices?.[0]?.delta;
          if (!delta || typeof delta !== 'object') continue;

          if (typeof delta.reasoning_content === 'string') {
            reasoningAcc += delta.reasoning_content;
          }
          if (typeof delta.content === 'string') {
            contentAcc += delta.content;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tcDelta of delta.tool_calls) {
              const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
              const existing = toolAcc.get(idx) ?? {
                id: String(tcDelta.id || `call_${idx}`),
                name: '',
                argumentsJson: '',
              };
              if (tcDelta.id) existing.id = String(tcDelta.id);
              if (tcDelta.function?.name) existing.name += String(tcDelta.function.name);
              if (typeof tcDelta.function?.arguments === 'string') {
                existing.argumentsJson += tcDelta.function.arguments;
              }
              toolAcc.set(idx, existing);
            }
          }

          params.onStreamProgress(reasoningAcc, contentAcc);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const orderedTools = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name.length > 0);

    return {
      reasoning: reasoningAcc,
      content: contentAcc,
      toolCalls: orderedTools,
    };
  }

  private async callAnthropicTurn(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: Array<Record<string, any>>;
    signal: AbortSignal;
  }): Promise<ParsedTurnOutput> {
    const endpoint = params.baseUrl.endsWith('/messages')
      ? params.baseUrl
      : `${params.baseUrl}/messages`;

    const systemMsg = params.messages.find((m) => m.role === 'system')?.content ?? '';
    const anthMessages = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.tool_call_id,
                content: m.content,
              },
            ],
          };
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          return {
            role: 'assistant',
            content: m.tool_calls.map((tc: any) => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            })),
          };
        }
        return { role: m.role, content: String(m.content ?? '') };
      });

    const resp = await this.fetchWithRateLimitRetry(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': params.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: 2048,
          system: systemMsg,
          messages: anthMessages,
          tools: BROWSER_TOOL_DEFINITIONS.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          })),
        }),
      },
      params.signal,
    );

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Anthropic HTTP ${resp.status}: ${txt}`);
    }

    const json = (await resp.json()) as Record<string, any>;
    const blocks: any[] = Array.isArray(json.content) ? json.content : [];
    let textOut = '';
    let thinkingOut = '';
    const toolCalls: ParsedTurnOutput['toolCalls'] = [];

    for (const blk of blocks) {
      if (blk.type === 'text') textOut += String(blk.text ?? '');
      else if (blk.type === 'thinking') thinkingOut += String(blk.thinking ?? '');
      else if (blk.type === 'tool_use') {
        toolCalls.push({
          id: String(blk.id || `anth_${toolCalls.length}`),
          name: String(blk.name ?? ''),
          argumentsJson: JSON.stringify(blk.input ?? {}),
        });
      }
    }

    return { reasoning: thinkingOut, content: textOut, toolCalls };
  }

  private async callGeminiTurn(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: Array<Record<string, any>>;
    signal: AbortSignal;
  }): Promise<ParsedTurnOutput> {
    const endpoint = `${params.baseUrl}/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
    const contents = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m) }],
      }));

    const resp = await this.fetchWithRateLimitRetry(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          tools: [
            {
              functionDeclarations: BROWSER_TOOL_DEFINITIONS.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
              })),
            },
          ],
        }),
      },
      params.signal,
    );

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Gemini HTTP ${resp.status}: ${txt}`);
    }

    const json = (await resp.json()) as Record<string, any>;
    const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
    let textOut = '';
    const toolCalls: ParsedTurnOutput['toolCalls'] = [];

    for (const p of parts) {
      if (typeof p.text === 'string') textOut += p.text;
      if (p.functionCall) {
        toolCalls.push({
          id: `gem_${toolCalls.length}`,
          name: String(p.functionCall.name ?? ''),
          argumentsJson: JSON.stringify(p.functionCall.args ?? {}),
        });
      }
    }

    return { reasoning: '', content: textOut, toolCalls };
  }
}
