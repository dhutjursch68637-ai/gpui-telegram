import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CANONICAL_BROWSER_TOOLS,
  CANONICAL_TEST_IDS,
  classifyBrowserToolRisk,
  type BrowserRunPolicy,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type PendingBrowserCommandDto,
} from '../../shared/rpc_types';
import { apiRequest } from '../api/server_api';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';
import { BridgeHeaderControls, PendingApprovalBannerList } from './ConversationStage';

export type StudioTabId =
  | 'tasks'
  | 'skills'
  | 'memory'
  | 'mcp'
  | 'cron'
  | 'sessions'
  | 'approvals';

function isValidCronExpression(expr: string): boolean {
  const s = expr.trim();
  if (!s) return false;
  if (/^@(hourly|daily|weekly|monthly|yearly|annually|midnight)$/i.test(s)) return true;
  if (/^@every\s+\d+(s|m|h)$/i.test(s)) return true;
  const parts = s.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  const cronFieldRe = /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?))*$/;
  return parts.every((p) => cronFieldRe.test(p));
}

export function HermesStudio({
  state,
  locale,
  pendingApprovals,
  initialTab = 'tasks',
  onPolicyChange,
  onEmergencyStop,
  onApprovalDecision,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  pendingApprovals: PendingBrowserCommandDto[];
  initialTab?: StudioTabId;
  onPolicyChange: (next: BrowserRunPolicy) => void;
  onEmergencyStop: () => void;
  onApprovalDecision: (cmdId: string, approved: boolean, remember: boolean) => void;
}) {
  const [tab, setTab] = useState<StudioTabId>(initialTab);

  // 1. Kanban state
  const [boards, setBoards] = useState<Array<Record<string, any>>>([]);
  const [cards, setCards] = useState<Array<Record<string, any>>>([]);
  const [newCardTitle, setNewCardTitle] = useState('');
  const kanbanInputRef = useRef<HTMLInputElement | null>(null);

  // 2. Skills state
  const [skills, setSkills] = useState<Array<Record<string, any>>>([]);
  const [skillName, setSkillName] = useState('');
  const [skillContent, setSkillContent] = useState('');
  const skillNameRef = useRef<HTMLInputElement | null>(null);
  const skillContentRef = useRef<HTMLTextAreaElement | null>(null);

  // 3. Memory & Soul state
  const [memoryText, setMemoryText] = useState('');
  const [soulText, setSoulText] = useState('');
  const [memoryStatus, setMemoryStatus] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const memoryTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const soulTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 4. MCP & Toolsets state
  const [toolsets, setToolsets] = useState<Record<string, any>>({});
  const [liveToolOutput, setLiveToolOutput] = useState<string>('');

  // 5. Cron state
  const [cronJobs, setCronJobs] = useState<Array<Record<string, any>>>([]);
  const [cronName, setCronName] = useState('');
  const [cronSchedule, setCronSchedule] = useState('*/15 * * * *');
  const [cronPrompt, setCronPrompt] = useState('');
  const [cronError, setCronError] = useState('');
  const cronNameRef = useRef<HTMLInputElement | null>(null);
  const cronScheduleRef = useRef<HTMLInputElement | null>(null);
  const cronPromptRef = useRef<HTMLInputElement | null>(null);

  // 6. Sessions state
  const [sessions, setSessions] = useState<Array<Record<string, any>>>([]);
  const [sessionSearch, setSessionSearch] = useState('');
  const [selectedSessionEvents, setSelectedSessionEvents] = useState<string>('');
  const sessionSearchRef = useRef<HTMLInputElement | null>(null);

  // 7. Server Hermes approvals
  const [hermesApprovals, setHermesApprovals] = useState<Array<Record<string, any>>>([]);

  const refreshActiveTab = useCallback(async () => {
    if (!state.authenticated) return;

    if (tab === 'tasks') {
      const bRes = await apiRequest<any>('/api/v1/hermes/kanban/boards');
      if (bRes.ok) {
        const bList = Array.isArray(bRes.data?.boards)
          ? bRes.data.boards
          : Array.isArray(bRes.data)
            ? bRes.data
            : [];
        setBoards(bList);
        const firstBoard = bList[0];
        if (firstBoard) {
          const bid = firstBoard.board_id ?? firstBoard.id;
          const detail = await apiRequest<any>(`/api/v1/hermes/kanban/boards/${encodeURIComponent(String(bid))}`);
          const cList = Array.isArray(detail.data?.cards)
            ? detail.data.cards
            : Array.isArray(firstBoard.cards)
              ? firstBoard.cards
              : [];
          setCards(cList);
        }
      }
    } else if (tab === 'skills') {
      const sRes = await apiRequest<any>('/api/v1/hermes/skills');
      if (sRes.ok) {
        setSkills(
          Array.isArray(sRes.data?.skills)
            ? sRes.data.skills
            : Array.isArray(sRes.data)
              ? sRes.data
              : [],
        );
      }
    } else if (tab === 'memory') {
      const [mRes, slRes] = await Promise.all([
        apiRequest<any>('/api/v1/hermes/memory'),
        apiRequest<any>('/api/v1/hermes/soul'),
      ]);
      if (mRes.ok) {
        setMemoryText(
          String(
            mRes.data?.memory_markdown ??
              mRes.data?.content ??
              mRes.data?.memory ??
              (Array.isArray(mRes.data?.entries) ? mRes.data.entries.join('\n') : ''),
          ),
        );
      }
      if (slRes.ok) {
        setSoulText(
          String(slRes.data?.soul_markdown ?? slRes.data?.content ?? slRes.data?.soul ?? ''),
        );
      }
    } else if (tab === 'mcp') {
      const tRes = await apiRequest<any>('/api/v1/hermes/toolsets');
      if (tRes.ok && tRes.data) setToolsets(tRes.data);
    } else if (tab === 'cron') {
      const cRes = await apiRequest<any>('/api/v1/hermes/cron');
      if (cRes.ok) {
        setCronJobs(
          Array.isArray(cRes.data?.jobs)
            ? cRes.data.jobs
            : Array.isArray(cRes.data?.cron)
              ? cRes.data.cron
              : Array.isArray(cRes.data)
                ? cRes.data
                : [],
        );
      }
    } else if (tab === 'sessions') {
      const sesRes = await apiRequest<any>('/api/v1/hermes/sessions');
      if (sesRes.ok) {
        setSessions(
          Array.isArray(sesRes.data?.sessions)
            ? sesRes.data.sessions
            : Array.isArray(sesRes.data)
              ? sesRes.data
              : [],
        );
      }
    } else if (tab === 'approvals') {
      const apRes = await apiRequest<any>('/api/v1/hermes/approvals');
      if (apRes.ok) {
        setHermesApprovals(
          Array.isArray(apRes.data?.approvals)
            ? apRes.data.approvals
            : Array.isArray(apRes.data)
              ? apRes.data
              : [],
        );
      }
    }
  }, [state.authenticated, tab]);

  useEffect(() => {
    void refreshActiveTab();
  }, [refreshActiveTab]);

  const handleAddKanbanCard = async (e: React.FormEvent) => {
    e.preventDefault();
    const cardTitleVal = (kanbanInputRef.current?.value ?? newCardTitle).trim();
    if (!cardTitleVal) return;
    let boardId = boards[0]?.board_id ?? boards[0]?.id;
    if (!boardId) {
      const createdBoard = await apiRequest<any>('/api/v1/hermes/kanban/boards', {
        method: 'POST',
        body: { title: 'Hermes Sprint Board', name: 'Hermes Sprint Board' },
      });
      boardId = createdBoard.data?.board_id ?? createdBoard.data?.id ?? 'default';
    }
    await apiRequest('/api/v1/hermes/kanban/cards', {
      method: 'POST',
      body: {
        board_id: boardId,
        title: cardTitleVal,
        column: 'todo',
        status: 'todo',
      },
    });
    setNewCardTitle('');
    if (kanbanInputRef.current) kanbanInputRef.current.value = '';
    await refreshActiveTab();
  };

  const handleMoveCard = async (cardId: string | number, nextStatus: string) => {
    await apiRequest(`/api/v1/hermes/kanban/cards/${encodeURIComponent(String(cardId))}`, {
      method: 'PATCH',
      body: { column: nextStatus, status: nextStatus },
    });
    await refreshActiveTab();
  };

  const handleCreateSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameVal = (skillNameRef.current?.value ?? skillName).trim();
    const contentVal = (skillContentRef.current?.value ?? skillContent).trim();
    if (!nameVal) return;
    await apiRequest('/api/v1/hermes/skills', {
      method: 'POST',
      body: {
        name: nameVal,
        description: `Procedural skill ${nameVal}`,
        content: contentVal || `# ${nameVal}\nFollow user instructions carefully.`,
      },
    });
    setSkillName('');
    setSkillContent('');
    if (skillNameRef.current) skillNameRef.current.value = '';
    if (skillContentRef.current) skillContentRef.current.value = '';
    await refreshActiveTab();
  };

  const handleSaveMemory = async () => {
    setMemoryError('');
    setMemoryStatus('');
    const val = memoryTextareaRef.current?.value ?? memoryText;
    if (val.length > 65536) {
      setMemoryError('MEMORY.md exceeds maximum 64 KB limit. Please compact entries first.');
      return;
    }
    setMemoryText(val);
    const res = await apiRequest('/api/v1/hermes/memory', {
      method: 'PUT',
      body: { memory_markdown: val, content: val, memory: val },
    });
    if (!res.ok) {
      setMemoryError(res.error || 'Failed to save MEMORY.md');
      return;
    }
    setMemoryStatus(`✓ ${tr(locale, 'studio.saved')} MEMORY.md`);
  };

  const handleSaveSoul = async () => {
    setMemoryError('');
    setMemoryStatus('');
    const val = soulTextareaRef.current?.value ?? soulText;
    if (val.length > 65536) {
      setMemoryError('SOUL.md exceeds maximum 64 KB limit.');
      return;
    }
    setSoulText(val);
    const res = await apiRequest('/api/v1/hermes/soul', {
      method: 'PUT',
      body: { soul_markdown: val, content: val, soul: val },
    });
    if (!res.ok) {
      setMemoryError(res.error || 'Failed to save SOUL.md');
      return;
    }
    setMemoryStatus(`✓ ${tr(locale, 'studio.saved')} SOUL.md`);
  };

  const handleCreateCron = async (e: React.FormEvent) => {
    e.preventDefault();
    setCronError('');
    const schedVal = cronScheduleRef.current?.value ?? cronSchedule;
    const nameVal = (cronNameRef.current?.value ?? cronName).trim();
    const promptVal = (cronPromptRef.current?.value ?? cronPrompt).trim();
    if (!isValidCronExpression(schedVal)) {
      setCronError(
        `Invalid cron schedule "${schedVal}". Expected 5-field cron syntax (e.g. "*/15 * * * *") or @hourly/@daily.`,
      );
      return;
    }
    if (!nameVal && !promptVal) {
      setCronError('Job name or prompt is required.');
      return;
    }
    const res = await apiRequest('/api/v1/hermes/cron', {
      method: 'POST',
      body: {
        name: nameVal || 'Scheduled Agent Routine',
        schedule: schedVal.trim(),
        cron_expr: schedVal.trim(),
        prompt: promptVal || 'Check daily updates',
        enabled: true,
      },
    });
    if (!res.ok) {
      setCronError(res.error || 'Server rejected cron job');
      return;
    }
    setCronName('');
    setCronPrompt('');
    if (cronNameRef.current) cronNameRef.current.value = '';
    if (cronPromptRef.current) cronPromptRef.current.value = '';
    await refreshActiveTab();
  };

  const handleSearchSessions = async (e: React.FormEvent) => {
    e.preventDefault();
    const qVal = (sessionSearchRef.current?.value ?? sessionSearch).trim();
    if (!qVal) {
      await refreshActiveTab();
      return;
    }
    const res = await apiRequest<any>('/api/v1/hermes/sessions/search', {
      method: 'POST',
      body: { query: qVal, q: qVal },
    });
    if (res.ok) {
      setSessions(
        Array.isArray(res.data?.sessions)
          ? res.data.sessions
          : Array.isArray(res.data?.results)
            ? res.data.results
            : [],
      );
    }
  };

  return (
    <section
      className="studio-workspace"
      data-testid={CANONICAL_TEST_IDS.hermesStudioWorkspace}
    >
      <header className="stage-topbar">
        <div>
          <h2 className="pane-heading">🧠 {tr(locale, 'studio.title')}</h2>
        </div>
        <BridgeHeaderControls
          state={state}
          locale={locale}
          onPolicyChange={onPolicyChange}
          onEmergencyStop={onEmergencyStop}
        />
      </header>

      <div className="studio-tabs-bar" role="tablist">
        {(
          [
            ['tasks', tr(locale, 'studio.tab.tasks')],
            ['skills', tr(locale, 'studio.tab.skills')],
            ['memory', tr(locale, 'studio.tab.memory')],
            ['mcp', tr(locale, 'studio.tab.mcp')],
            ['cron', tr(locale, 'studio.tab.cron')],
            ['sessions', tr(locale, 'studio.tab.sessions')],
            [
              'approvals',
              `${tr(locale, 'studio.tab.approvals')}${pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}`,
            ],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-tab={id}
            data-testid={`studio-tab-${id}`}
            className={`folder-tab-btn ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="studio-body-scroll">
        {/* TAB 1: KANBAN TASKS */}
        {tab === 'tasks' && (
          <div className="studio-section" data-testid="studio-panel-tasks">
            <form className="row-gap-8" onSubmit={(e) => void handleAddKanbanCard(e)}>
              <input
                ref={kanbanInputRef}
                className="input flex-1"
                data-testid="kanban-card-title-input"
                value={newCardTitle}
                onChange={(e) => setNewCardTitle(e.target.value)}
                placeholder="New Kanban task card…"
              />
              <button type="submit" className="btn primary" data-testid="kanban-add-card-btn">
                + Add Card
              </button>
            </form>

            <div className="kanban-columns-grid">
              {(['todo', 'in_progress', 'done'] as const).map((col) => {
                const colCards = cards.filter(
                  (c) => String(c.column ?? c.status ?? 'todo').toLowerCase() === col,
                );
                return (
                  <div key={col} className="kanban-col" data-column={col}>
                    <div className="kanban-col-header">
                      <strong>{col.replace('_', ' ').toUpperCase()}</strong>
                      <span className="badge-pill">{colCards.length}</span>
                    </div>
                    {colCards.map((c, idx) => {
                      const cid = c.card_id ?? c.id ?? idx;
                      return (
                        <div key={String(cid)} className="kanban-card" data-testid="kanban-card">
                          <div>{String(c.title ?? 'Task')}</div>
                          <div className="row-gap-6" style={{ marginTop: 6 }}>
                            {col !== 'in_progress' && (
                              <button
                                type="button"
                                className="btn ghost xs"
                                onClick={() => void handleMoveCard(cid, 'in_progress')}
                              >
                                → Doing
                              </button>
                            )}
                            {col !== 'done' && (
                              <button
                                type="button"
                                className="btn ghost xs"
                                onClick={() => void handleMoveCard(cid, 'done')}
                              >
                                ✓ Done
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 2: PROCEDURAL SKILLS */}
        {tab === 'skills' && (
          <div className="studio-section" data-testid="studio-panel-skills">
            <form className="card-sub-box auth-form-stack" onSubmit={(e) => void handleCreateSkill(e)}>
              <strong>Create Procedural SKILL.md</strong>
              <input
                ref={skillNameRef}
                className="input"
                data-testid="studio-skill-name-input"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                placeholder="web-research-workflow"
              />
              <textarea
                ref={skillContentRef}
                className="input"
                rows={3}
                data-testid="studio-skill-content-input"
                value={skillContent}
                onChange={(e) => setSkillContent(e.target.value)}
                placeholder="# Skill Instructions…"
              />
              <button type="submit" className="btn primary" data-testid="studio-skill-create-btn">
                Save Skill
              </button>
            </form>

            <div className="studio-list">
              {skills.map((sk, idx) => {
                const name = String(sk.name ?? sk.id ?? `skill_${idx}`);
                return (
                  <div key={name} className="studio-list-row" data-testid="studio-skill-item">
                    <div className="flex-1">
                      <strong>⚡ {name}</strong>
                      <div className="muted-xs">{String(sk.description ?? '')}</div>
                    </div>
                    <button
                      type="button"
                      className="btn sm success"
                      onClick={() =>
                        void apiRequest(`/api/v1/hermes/skills/${encodeURIComponent(name)}/approve`, {
                          method: 'POST',
                          body: {},
                        }).then(() => refreshActiveTab())
                      }
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() =>
                        void apiRequest(`/api/v1/hermes/skills/${encodeURIComponent(name)}`, {
                          method: 'DELETE',
                        }).then(() => refreshActiveTab())
                      }
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: MEMORY.MD & SOUL.MD */}
        {tab === 'memory' && (
          <div className="studio-section" data-testid="studio-panel-memory">
            {memoryError && (
              <div className="error-banner" role="alert" data-testid="studio-memory-error">
                {memoryError}
              </div>
            )}
            {memoryStatus && (
              <div className="info-banner" data-testid="studio-memory-saved">
                {memoryStatus}
              </div>
            )}

            <div className="studio-two-col">
              <div className="card-sub-box auth-form-stack">
                <strong>🧠 Persistent Memory (MEMORY.md)</strong>
                <textarea
                  ref={memoryTextareaRef}
                  className="input mono"
                  rows={8}
                  data-testid="studio-memory-textarea"
                  value={memoryText}
                  onChange={(e) => setMemoryText(e.target.value)}
                  placeholder="- User prefers concise Rust & TypeScript code…"
                />
                <button
                  type="button"
                  className="btn primary"
                  data-testid="studio-save-memory-btn"
                  onClick={() => void handleSaveMemory()}
                >
                  {tr(locale, 'studio.saveMemory')}
                </button>
              </div>

              <div className="card-sub-box auth-form-stack">
                <strong>✨ Persona Instructions (SOUL.md)</strong>
                <textarea
                  ref={soulTextareaRef}
                  className="input mono"
                  rows={8}
                  data-testid="studio-soul-textarea"
                  value={soulText}
                  onChange={(e) => setSoulText(e.target.value)}
                  placeholder="You are Hermes, an autonomous browser & coding companion…"
                />
                <button
                  type="button"
                  className="btn primary"
                  data-testid="studio-save-soul-btn"
                  onClick={() => void handleSaveSoul()}
                >
                  {tr(locale, 'studio.saveSoul')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: MCP & 24 BROWSER TOOLS */}
        {tab === 'mcp' && (
          <div className="studio-section" data-testid="studio-panel-mcp">
            <div className="card-sub-box">
              <div className="row-between">
                <strong>🌐 24 Canonical MV3 Browser Tools</strong>
                <button
                  type="button"
                  className="btn sm primary"
                  data-testid="studio-test-browser-status-btn"
                  onClick={async () => {
                    const res = await sendSwRpc({
                      type: 'ui.invoke_browser_tool',
                      tool: 'browser_status',
                      arguments: {},
                      bypass_approval: true,
                    });
                    setLiveToolOutput(JSON.stringify(res, null, 2));
                  }}
                >
                  ▶ Run browser_status
                </button>
              </div>
              {liveToolOutput && (
                <pre className="code-pre" data-testid="studio-live-tool-output">
                  {liveToolOutput}
                </pre>
              )}
              <div className="tools-badge-grid">
                {CANONICAL_BROWSER_TOOLS.map((tool) => {
                  const risk = classifyBrowserToolRisk(tool);
                  return (
                    <div key={tool} className="tool-chip-card" data-tool-name={tool}>
                      <code>{tool}</code>
                      <span className={`risk-pill ${risk}`}>{risk}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {Object.keys(toolsets).length > 0 && (
              <div className="muted-xs">Server Toolsets Loaded ✓</div>
            )}
          </div>
        )}

        {/* TAB 5: CRON & HEARTBEAT */}
        {tab === 'cron' && (
          <div className="studio-section" data-testid="studio-panel-cron">
            {cronError && (
              <div className="error-banner" role="alert" data-testid="studio-cron-error">
                {cronError}
              </div>
            )}

            <form className="card-sub-box auth-form-stack" onSubmit={(e) => void handleCreateCron(e)}>
              <strong>⏰ Schedule Autonomous Cron Routine</strong>
              <div className="row-gap-8">
                <input
                  ref={cronNameRef}
                  className="input flex-1"
                  data-testid="studio-cron-name-input"
                  value={cronName}
                  onChange={(e) => setCronName(e.target.value)}
                  placeholder="Morning Briefing"
                />
                <input
                  ref={cronScheduleRef}
                  className="input mono"
                  data-testid="studio-cron-schedule-input"
                  value={cronSchedule}
                  onChange={(e) => setCronSchedule(e.target.value)}
                  placeholder="*/15 * * * *"
                />
              </div>
              <input
                ref={cronPromptRef}
                className="input"
                data-testid="studio-cron-prompt-input"
                value={cronPrompt}
                onChange={(e) => setCronPrompt(e.target.value)}
                placeholder="Summarize unread messages and GitHub alerts"
              />
              <button type="submit" className="btn primary" data-testid="studio-cron-create-btn">
                Create Cron Job
              </button>
            </form>

            <div className="studio-list">
              {cronJobs.map((job, idx) => {
                const jid = String(job.id ?? job.cron_id ?? idx);
                return (
                  <div key={jid} className="studio-list-row" data-testid="studio-cron-item">
                    <div className="flex-1">
                      <strong>{String(job.name ?? 'Cron Job')}</strong>{' '}
                      <code>{String(job.schedule ?? job.cron_expr ?? '')}</code>
                      <div className="muted-xs">{String(job.prompt ?? '')}</div>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        void apiRequest(`/api/v1/hermes/cron/${encodeURIComponent(jid)}/run`, {
                          method: 'POST',
                          body: {},
                        }).then(() => refreshActiveTab())
                      }
                    >
                      ▶ Run
                    </button>
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() =>
                        void apiRequest(`/api/v1/hermes/cron/${encodeURIComponent(jid)}`, {
                          method: 'DELETE',
                        }).then(() => refreshActiveTab())
                      }
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 6: SESSIONS & TURN EVENTS */}
        {tab === 'sessions' && (
          <div className="studio-section" data-testid="studio-panel-sessions">
            <form className="row-gap-8" onSubmit={(e) => void handleSearchSessions(e)}>
              <input
                ref={sessionSearchRef}
                className="input flex-1"
                data-testid="studio-session-search-input"
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
                placeholder="FTS5 search past Hermes agent sessions…"
              />
              <button type="submit" className="btn primary">
                Search
              </button>
            </form>

            <div className="studio-list">
              {sessions.map((s, idx) => {
                const sid = String(s.session_id ?? s.id ?? idx);
                return (
                  <div key={sid} className="studio-list-row" data-testid="studio-session-item">
                    <div className="flex-1">
                      <strong>{String(s.title ?? `Session ${sid}`)}</strong>
                      <div className="muted-xs">ID: {sid}</div>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={async () => {
                        const res = await apiRequest(`/api/v1/hermes/sessions/${encodeURIComponent(sid)}`);
                        setSelectedSessionEvents(JSON.stringify(res.data, null, 2));
                      }}
                    >
                      Inspect
                    </button>
                  </div>
                );
              })}
            </div>
            {selectedSessionEvents && <pre className="code-pre">{selectedSessionEvents}</pre>}
          </div>
        )}

        {/* TAB 7: APPROVALS QUEUE */}
        {tab === 'approvals' && (
          <div className="studio-section" data-testid="studio-panel-approvals">
            <h3>🔒 Pending Browser & Agent Approvals</h3>
            {pendingApprovals.length === 0 && hermesApprovals.length === 0 ? (
              <p className="muted-sm">No pending browser or tool commands awaiting approval.</p>
            ) : (
              <>
                <PendingApprovalBannerList
                  items={pendingApprovals}
                  onDecision={onApprovalDecision}
                />
                {hermesApprovals.map((ap, idx) => {
                  const aid = String(ap.id ?? ap.approval_id ?? idx);
                  return (
                    <div key={aid} className="studio-list-row">
                      <div className="flex-1">
                        <strong>{String(ap.tool ?? ap.action ?? 'Agent Tool')}</strong>
                        <div className="muted-xs">{String(ap.reason ?? '')}</div>
                      </div>
                      <button
                        type="button"
                        className="btn sm success"
                        onClick={() =>
                          void apiRequest(`/api/v1/hermes/approvals/${encodeURIComponent(aid)}/decide`, {
                            method: 'POST',
                            body: { approved: true, decision: 'approve' },
                          }).then(() => refreshActiveTab())
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() =>
                          void apiRequest(`/api/v1/hermes/approvals/${encodeURIComponent(aid)}/decide`, {
                            method: 'POST',
                            body: { approved: false, decision: 'deny' },
                          }).then(() => refreshActiveTab())
                        }
                      >
                        Deny
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
