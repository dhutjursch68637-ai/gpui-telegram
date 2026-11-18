/**
 * Browser Security Policy Engine, Domain Allowlist/Blocklist Enforcer,
 * Prompt-Injection Escalation Tracker, Pending Approval Queue, and Emergency Kill-Switch.
 */

import {
  BRIDGE_ERROR_CODES,
  BrowserRpcError,
  OFFICIAL_BOT_USER_ID,
  classifyBrowserToolRisk,
  isUrlAllowedByDomains,
  normalizeBrowserToolName,
  normalizeRunPolicy,
  type BrowserInjectionScanDto,
  type BrowserRunPolicy,
  type PendingBrowserCommandDto,
  type SwToUiEvent,
} from '../shared/rpc_types';
import { readNormalizedStorageConfig } from './db';

interface LocalApprovalWaiter {
  dto: PendingBrowserCommandDto;
  resolve: (decision: { approved: boolean; rememberForSession: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

type BroadcastFn = (event: SwToUiEvent) => void;

export class BrowserPolicyEngine {
  private runPolicy: BrowserRunPolicy = 'always_allow_authorized';
  private emergencyStopped = false;
  private allowedDomains: string[] = [];
  private blockedDomains: string[] = [];
  private serverUrl = '';
  private token = '';

  /** Per-tab prompt-injection memory populated by `browser_snapshot` / `browser_extract_markdown`. */
  private flaggedTabs = new Map<number, { url: string; scan: BrowserInjectionScanDto }>();

  /** Session-scoped approvals granted via `remember_for_session: true`. */
  private sessionApprovedBots = new Set<number>();

  /** Local SW pending approval queue (for prompt-injection escalations, Desktop Bridge, or direct invoke). */
  private localPending = new Map<string, LocalApprovalWaiter>();

  /** Cached server-side `/api/v1/browser/commands/pending` items. */
  private serverPendingCache: PendingBrowserCommandDto[] = [];
  private serverPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback invoked on emergency stop to abort active BrowserController/Bot/Debugger work. */
  private emergencyStopHooks = new Set<(reason: string) => Promise<void> | void>();

  private readonly broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
    this.startServerPendingPoll();
  }

  public onEmergencyStop(fn: (reason: string) => Promise<void> | void): void {
    this.emergencyStopHooks.add(fn);
  }

  public getRunPolicy(): BrowserRunPolicy {
    return this.emergencyStopped ? 'disabled' : this.runPolicy;
  }

  public isEmergencyStopped(): boolean {
    return this.emergencyStopped;
  }

  public getAllowedDomains(): string[] {
    return [...this.allowedDomains];
  }

  public getBlockedDomains(): string[] {
    return [...this.blockedDomains];
  }

  public async reloadFromStorage(): Promise<void> {
    const cfg = await readNormalizedStorageConfig();
    this.emergencyStopped = cfg.emergencyStopped;
    this.runPolicy = cfg.runPolicy;
    this.allowedDomains = cfg.allowedDomains;
    this.blockedDomains = cfg.blockedDomains;
    this.serverUrl = cfg.serverUrl;
    this.token = cfg.token;
    void this.refreshServerPendingCommands();
  }

  public async setPolicy(
    nextPolicy: BrowserRunPolicy,
    options?: {
      allowedDomains?: string[];
      blockedDomains?: string[];
      syncServerBotProfile?: boolean;
    },
  ): Promise<void> {
    const normalized = normalizeRunPolicy(nextPolicy);
    this.runPolicy = normalized;
    if (normalized !== 'disabled') {
      this.emergencyStopped = false;
      this.sessionApprovedBots.clear();
    }
    if (options?.allowedDomains) {
      this.allowedDomains = options.allowedDomains.map(String);
    }
    if (options?.blockedDomains) {
      this.blockedDomains = options.blockedDomains.map(String);
    }

    const raw = (await chrome.storage.local.get(['bridge_config', 'browser_bridge'])) as Record<string, any>;
    const nextStorage: Record<string, unknown> = {
      run_policy: normalized,
      browser_run_policy: normalized,
      emergency_stopped: normalized === 'disabled' ? this.emergencyStopped : false,
      allowed_domains: this.allowedDomains,
      blocked_domains: this.blockedDomains,
    };
    if (raw.bridge_config && typeof raw.bridge_config === 'object') {
      nextStorage.bridge_config = {
        ...raw.bridge_config,
        run_policy: normalized,
        allowed_domains: this.allowedDomains,
        blocked_domains: this.blockedDomains,
      };
    }
    if (raw.browser_bridge && typeof raw.browser_bridge === 'object') {
      nextStorage.browser_bridge = {
        ...raw.browser_bridge,
        run_policy: normalized,
      };
    }
    await chrome.storage.local.set(nextStorage);

    if (options?.syncServerBotProfile !== false && this.serverUrl && this.token) {
      try {
        await fetch(`${this.serverUrl}/api/v1/bots/${OFFICIAL_BOT_USER_ID}/browser`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: normalized !== 'disabled',
            run_policy: normalized,
            allowed_domains: this.allowedDomains,
            blocked_domains: this.blockedDomains,
            preferred_target: 'extension',
          }),
        });
      } catch {
        // best-effort sync
      }
    }
  }

  public recordTabInjectionScan(tabId: number, url: string, scan: BrowserInjectionScanDto): void {
    if (scan.flagged) {
      this.flaggedTabs.set(tabId, { url, scan });
    } else {
      this.flaggedTabs.delete(tabId);
    }
  }

  public clearTabState(tabId: number, newUrl?: string): void {
    const existing = this.flaggedTabs.get(tabId);
    if (!newUrl || (existing && existing.url !== newUrl)) {
      this.flaggedTabs.delete(tabId);
    }
  }

  public isTabInjectionFlagged(tabId: number | undefined): boolean {
    if (typeof tabId !== 'number') return false;
    return this.flaggedTabs.has(tabId);
  }

  public assertDomainAllowed(targetUrl: string | undefined | null): void {
    if (!targetUrl) return;
    const check = isUrlAllowedByDomains(targetUrl, this.allowedDomains, this.blockedDomains);
    if (!check.allowed) {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.POLICY_DISABLED,
        'POLICY_DISABLED',
        check.reason ?? `Domain blocked by policy: ${targetUrl}`,
      );
    }
  }

  public async authorizeExecution(params: {
    tool: string;
    args: Record<string, unknown>;
    targetUrl?: string | null;
    targetTabId?: number;
    botUserId?: number;
    botUsername?: string;
    chatId?: number | null;
    preApprovedByCaller?: boolean;
    timeoutMs?: number;
    bypassInteractiveApproval?: boolean;
  }): Promise<void> {
    const canonicalTool = normalizeBrowserToolName(params.tool);
    const activePolicy = this.getRunPolicy();

    // 1. Emergency stop or Disabled policy rejects ALL tools immediately (-32003)
    if (this.emergencyStopped || activePolicy === 'disabled') {
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.POLICY_DISABLED,
        'POLICY_DISABLED',
        this.emergencyStopped
          ? 'Browser control halted by emergency stop (Alt+Shift+S)'
          : 'Browser control is disabled by BrowserRunPolicy::Disabled',
      );
    }

    // 2. Enforce domain allowlist & blocklist on target URL
    if (params.targetUrl) {
      this.assertDomainAllowed(params.targetUrl);
    }
    if (typeof params.args.url === 'string' && params.args.url.trim()) {
      this.assertDomainAllowed(params.args.url.trim());
    }

    // Local user slash commands inside sidepanel (/browser ...) bypass bot approval prompts
    if (params.bypassInteractiveApproval) {
      return;
    }

    const risk = classifyBrowserToolRisk(canonicalTool, params.args);
    const injectionFlagged = this.isTabInjectionFlagged(params.targetTabId);
    const botId = params.botUserId ?? OFFICIAL_BOT_USER_ID;

    // 3. Evaluate BrowserRunPolicy
    if (activePolicy === 'allow_read_only') {
      if (risk === 'read_only') {
        return;
      }
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.POLICY_DISABLED,
        'POLICY_DISABLED',
        `Tool "${canonicalTool}" (${risk}) is blocked under allow_read_only policy`,
      );
    }

    if (activePolicy === 'ask_every_time') {
      if (risk === 'read_only') {
        return;
      }
      if (params.preApprovedByCaller || this.sessionApprovedBots.has(botId)) {
        return;
      }
      await this.awaitUserApproval({
        botUserId: botId,
        botUsername: params.botUsername,
        chatId: params.chatId ?? null,
        tool: canonicalTool,
        risk,
        args: params.args,
        targetUrl: params.targetUrl ?? (typeof params.args.url === 'string' ? params.args.url : null),
        reason: `BrowserRunPolicy::AskEveryTime requires confirmation for ${canonicalTool}`,
        injectionFlagged,
        timeoutMs: params.timeoutMs,
      });
      return;
    }

    // activePolicy === 'always_allow_authorized'
    if (injectionFlagged && risk !== 'read_only' && !params.preApprovedByCaller) {
      await this.awaitUserApproval({
        botUserId: botId,
        botUsername: params.botUsername,
        chatId: params.chatId ?? null,
        tool: canonicalTool,
        risk,
        args: params.args,
        targetUrl: params.targetUrl ?? null,
        reason: `Prompt-injection detected on page; mutating tool "${canonicalTool}" escalated for user approval`,
        injectionFlagged: true,
        timeoutMs: params.timeoutMs,
      });
    }
  }

  private async awaitUserApproval(req: {
    botUserId: number;
    botUsername?: string;
    chatId: number | null;
    tool: string;
    risk: 'read_only' | 'mutating' | 'high_risk';
    args: Record<string, unknown>;
    targetUrl: string | null;
    reason: string;
    injectionFlagged: boolean;
    timeoutMs?: number;
  }): Promise<void> {
    const now = Date.now();
    const waitBudgetMs = Math.min(Math.max(Number(req.timeoutMs ?? 15_000) - 250, 1200), 45_000);
    const commandId = `ext-cmd-${now}-${Math.random().toString(36).slice(2, 8)}`;

    const dto: PendingBrowserCommandDto = {
      command_id: commandId,
      bot_user_id: req.botUserId,
      bot_username: req.botUsername ?? 'telegram_official_bot',
      chat_id: req.chatId,
      tool: req.tool,
      risk: req.risk,
      arguments: req.args,
      target_url: req.targetUrl,
      reason: req.reason,
      injection_flagged: req.injectionFlagged,
      created_at_ms: now,
      expires_at_ms: now + waitBudgetMs,
      source: 'local',
    };

    const decision = await new Promise<{ approved: boolean; rememberForSession: boolean }>(
      (resolve) => {
        const timer = setTimeout(() => {
          this.localPending.delete(commandId);
          this.emitPendingApprovals();
          resolve({ approved: false, rememberForSession: false });
        }, waitBudgetMs);

        this.localPending.set(commandId, { dto, resolve, timer });
        this.emitPendingApprovals();
      },
    );

    if (!decision.approved) {
      if (this.emergencyStopped || this.getRunPolicy() === 'disabled') {
        throw new BrowserRpcError(
          BRIDGE_ERROR_CODES.POLICY_DISABLED,
          'POLICY_DISABLED',
          'Browser command aborted because policy was disabled',
        );
      }
      throw new BrowserRpcError(
        BRIDGE_ERROR_CODES.USER_DENIED_APPROVAL,
        'USER_DENIED_APPROVAL',
        `User denied browser command "${req.tool}"`,
      );
    }

    if (decision.rememberForSession && !req.injectionFlagged) {
      this.sessionApprovedBots.add(req.botUserId);
    }
  }

  public getCombinedPendingApprovals(): PendingBrowserCommandDto[] {
    const localItems = [...this.localPending.values()].map((w) => w.dto);
    const merged: PendingBrowserCommandDto[] = [...this.serverPendingCache];

    for (const loc of localItems) {
      // Avoid rendering duplicate cards if server already queued the exact same tool/bot invocation
      const dup = merged.some(
        (srv) =>
          srv.command_id === loc.command_id ||
          (srv.tool === loc.tool &&
            srv.bot_user_id === loc.bot_user_id &&
            Math.abs(srv.created_at_ms - loc.created_at_ms) < 2500),
      );
      if (!dup) {
        merged.push(loc);
      }
    }

    return merged.sort((a, b) => b.created_at_ms - a.created_at_ms);
  }

  public async resolvePendingCommand(params: {
    commandId: string;
    approved: boolean;
    rememberForSession?: boolean;
  }): Promise<{ ok: boolean }> {
    const remember = Boolean(params.rememberForSession);
    const localWaiter = this.localPending.get(params.commandId);

    if (localWaiter) {
      clearTimeout(localWaiter.timer);
      this.localPending.delete(params.commandId);
      localWaiter.resolve({ approved: params.approved, rememberForSession: remember });
    }

    // Also resolve any matching co-queued local waiter if commandId came from server pending queue
    for (const [cid, waiter] of this.localPending.entries()) {
      const serverMatch = this.serverPendingCache.find((s) => s.command_id === params.commandId);
      if (serverMatch && waiter.dto.tool === serverMatch.tool) {
        clearTimeout(waiter.timer);
        this.localPending.delete(cid);
        waiter.resolve({ approved: params.approved, rememberForSession: remember });
      }
    }

    if (params.approved && remember) {
      this.sessionApprovedBots.add(OFFICIAL_BOT_USER_ID);
    }

    // Forward approval/denial to server REST endpoint if command exists on server (or non-local id)
    const isServerCmd =
      !params.commandId.startsWith('ext-cmd-') ||
      this.serverPendingCache.some((s) => s.command_id === params.commandId);

    if (isServerCmd && this.serverUrl && this.token) {
      try {
        await fetch(
          `${this.serverUrl}/api/v1/browser/commands/${encodeURIComponent(params.commandId)}/approve`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              approved: params.approved,
              remember_for_session: remember,
            }),
          },
        );
      } catch {
        // ignore network errors
      }
      this.serverPendingCache = this.serverPendingCache.filter(
        (c) => c.command_id !== params.commandId,
      );
    }

    this.emitPendingApprovals();
    void this.refreshServerPendingCommands();
    return { ok: true };
  }

  private startServerPendingPoll(): void {
    if (this.serverPollTimer) clearInterval(this.serverPollTimer);
    this.serverPollTimer = setInterval(() => {
      if (this.serverUrl && this.token && !this.emergencyStopped) {
        void this.refreshServerPendingCommands();
      }
    }, 450);
  }

  public async refreshServerPendingCommands(): Promise<PendingBrowserCommandDto[]> {
    if (!this.serverUrl || !this.token) {
      this.serverPendingCache = [];
      return this.getCombinedPendingApprovals();
    }

    try {
      const resp = await fetch(`${this.serverUrl}/api/v1/browser/commands/pending`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
      });
      if (resp.ok) {
        const body = (await resp.json().catch(() => null)) as any;
        const rawItems: any[] = Array.isArray(body)
          ? body
          : Array.isArray(body?.items)
            ? body.items
            : Array.isArray(body?.commands)
              ? body.commands
              : [];

        const mapped: PendingBrowserCommandDto[] = rawItems
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            command_id: String(item.command_id ?? item.id ?? ''),
            bot_user_id: Number(item.bot_user_id ?? item.bot_id ?? OFFICIAL_BOT_USER_ID),
            bot_username: String(item.bot_username ?? 'telegram_official_bot'),
            chat_id: typeof item.chat_id === 'number' ? item.chat_id : null,
            tool: String(item.tool ?? ''),
            risk: classifyBrowserToolRisk(String(item.tool ?? '')),
            arguments:
              item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
            target_url: typeof item.target_url === 'string' ? item.target_url : null,
            reason: String(item.reason ?? 'User confirmation required by BrowserRunPolicy'),
            injection_flagged: Boolean(item.injection_flagged),
            created_at_ms: Number(item.created_at_ms ?? Date.now()),
            expires_at_ms: Number(item.expires_at_ms ?? Date.now() + 30_000),
            source: 'server' as const,
          }))
          .filter((item) => item.command_id.length > 0);

        const prevKey = JSON.stringify(this.serverPendingCache.map((c) => c.command_id));
        const nextKey = JSON.stringify(mapped.map((c) => c.command_id));
        this.serverPendingCache = mapped;
        if (prevKey !== nextKey) {
          this.emitPendingApprovals();
        }
      }
    } catch {
      // ignore transient poll failure
    }

    return this.getCombinedPendingApprovals();
  }

  private emitPendingApprovals(): void {
    this.broadcast({
      type: 'pending_approvals_updated',
      pending_approvals: this.getCombinedPendingApprovals(),
    });
  }

  public async triggerEmergencyStop(reason = 'Emergency stop triggered'): Promise<void> {
    this.emergencyStopped = true;
    this.runPolicy = 'disabled';
    this.sessionApprovedBots.clear();

    // 1. Reject all local pending approvals immediately
    for (const [cid, waiter] of this.localPending.entries()) {
      clearTimeout(waiter.timer);
      this.localPending.delete(cid);
      waiter.resolve({ approved: false, rememberForSession: false });
    }

    const pendingServerSnapshot = [...this.serverPendingCache];
    this.serverPendingCache = [];
    this.emitPendingApprovals();

    // 2. Immediately abort active BrowserController ops, detach chrome.debugger, and cancel LLM streams
    for (const hook of this.emergencyStopHooks) {
      try {
        await hook(reason);
      } catch {
        // continue executing all kill-switch hooks
      }
    }

    // 3. Persist disabled + emergency_stopped state to chrome.storage.local
    await this.setPolicy('disabled', { syncServerBotProfile: false });
    await chrome.storage.local.set({ emergency_stopped: true });

    // 4. Best-effort non-blocking server sync (never blocks local kill-switch latency)
    if (this.serverUrl && this.token) {
      fetch(`${this.serverUrl}/api/v1/bots/${OFFICIAL_BOT_USER_ID}/browser`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabled: false,
          run_policy: 'disabled',
          allowed_domains: this.allowedDomains,
          blocked_domains: this.blockedDomains,
          preferred_target: 'extension',
        }),
      }).catch(() => {});

      for (const cmd of pendingServerSnapshot) {
        fetch(
          `${this.serverUrl}/api/v1/browser/commands/${encodeURIComponent(cmd.command_id)}/approve`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ approved: false, remember_for_session: false }),
          },
        ).catch(() => {});
      }
    }

    this.broadcast({ type: 'emergency_stopped', reason });
  }
}
