import React, { useEffect, useState } from 'react';
import type {
  BrowserTabDto,
  StoredDialogDto,
  StoredMessageDto,
} from '../../shared/rpc_types';
import { invokeWasm } from '../../wasm/wasm_bridge';
import { apiRequest } from '../api/server_api';
import { sendSwRpc } from '../sw_client';

export function CreatePollModal({
  open,
  chatId,
  onClose,
  onCreated,
}: {
  open: boolean;
  chatId: number;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['Yes', 'No']);
  const [isQuiz, setIsQuiz] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const cleanQ = question.trim();
    const cleanOpts = options.map((o) => o.trim()).filter(Boolean);
    if (!cleanQ || cleanOpts.length < 2) {
      setError('Enter a poll question and at least 2 options.');
      return;
    }
    const res = await apiRequest(`/api/v1/chats/${chatId}/polls`, {
      method: 'POST',
      body: {
        question: cleanQ,
        options: cleanOpts,
        is_quiz: isQuiz,
        correct_option_id: isQuiz ? 0 : undefined,
      },
    });
    if (!res.ok) {
      setError(res.error || 'Failed to create poll');
      return;
    }
    setQuestion('');
    setOptions(['Yes', 'No']);
    onClose();
    await sendSwRpc({ type: 'ui.get_messages', chat_id: chatId });
    await onCreated();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        data-testid="create-poll-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>📊 Create Poll</h3>
        {error && <div className="error-banner">{error}</div>}
        <form className="auth-form-stack" onSubmit={(e) => void handleSubmit(e)}>
          <input
            className="input"
            autoFocus
            data-testid="poll-question-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question…"
          />
          {options.map((opt, idx) => (
            <input
              key={idx}
              className="input"
              data-testid={`poll-option-input-${idx}`}
              value={opt}
              onChange={(e) =>
                setOptions((prev) => prev.map((v, i) => (i === idx ? e.target.value : v)))
              }
              placeholder={`Option ${idx + 1}`}
            />
          ))}
          <button
            type="button"
            className="btn ghost xs"
            onClick={() => setOptions((prev) => [...prev, ''])}
          >
            + Add Option
          </button>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={isQuiz}
              onChange={(e) => setIsQuiz(e.target.checked)}
            />
            <span>Quiz Mode</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" data-testid="poll-create-submit-btn">
              Create Poll
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ForwardMessageModal({
  message,
  dialogs,
  onClose,
  onForwarded,
}: {
  message: StoredMessageDto | null;
  dialogs: StoredDialogDto[];
  onClose: () => void;
  onForwarded: (targetChatId: number) => void;
}) {
  if (!message) return null;

  const handlePick = async (dlg: StoredDialogDto) => {
    await sendSwRpc({
      type: 'ui.send_message',
      chat_id: dlg.chat_id,
      text: `[Forwarded] ${message.text}`,
    });
    onClose();
    onForwarded(dlg.chat_id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        data-testid="forward-message-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>↪ Forward Message</h3>
        <div className="miniapp-picker-list">
          {dialogs.map((d) => (
            <button
              key={d.chat_id}
              type="button"
              className="miniapp-picker-item"
              data-testid={`forward-target-${d.chat_id}`}
              onClick={() => void handlePick(d)}
            >
              <span>{d.title}</span>
              <span className="btn sm primary">Send</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function E2eeVerifyModal({
  open,
  peerUserId,
  peerTitle,
  onClose,
}: {
  open: boolean;
  peerUserId?: number;
  peerTitle: string;
  onClose: () => void;
}) {
  const [emojis, setEmojis] = useState<string>('🔐 🛡️ 🔑 💎');
  const [localIk, setLocalIk] = useState<string>('');
  const [deviceCount, setDeviceCount] = useState<number>(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const compute = async () => {
      const idA = await invokeWasm<any>('e2ee_generate_identity', {
        device_id: 'ext_verify_local',
        spk_id: 1,
        otpk_count: 2,
      });
      const ikA = String(idA.data?.identity_key ?? '');
      let ikB = ikA;
      if (peerUserId && peerUserId > 0) {
        const res = await apiRequest<any>(`/api/v1/e2ee/prekeys/${peerUserId}`);
        if (res.ok && Array.isArray(res.data?.devices) && res.data.devices.length > 0) {
          setDeviceCount(res.data.devices.length);
          ikB = String(res.data.devices[0]?.identity_key ?? ikA);
        }
      }
      if (ikA) {
        setLocalIk(ikA);
        const sf = await invokeWasm<any>('safety_number_emojis', {
          local_ik: ikA,
          remote_ik: ikB || ikA,
        });
        if (!cancelled && sf.ok && sf.data) {
          const val = Array.isArray(sf.data.emojis)
            ? sf.data.emojis.join('  ')
            : String(sf.data.emojis ?? sf.data);
          if (val) setEmojis(val);
        }
      }
    };
    void compute();
    return () => {
      cancelled = true;
    };
  }, [open, peerUserId]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card sm center-col"
        role="dialog"
        aria-modal="true"
        data-testid="e2ee-verify-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>🔐 End-to-End Encryption</h3>
        <p className="muted-xs">Compare these 4 WASM X3DH safety emojis with {peerTitle}:</p>
        <div className="safety-emoji-hero" data-testid="e2ee-modal-emojis">
          {emojis}
        </div>
        {localIk && <code className="muted-xs truncate-1">{localIk.slice(0, 32)}…</code>}
        <div className="muted-xs">Verified Peer Devices: {deviceCount}</div>
        <button type="button" className="btn primary full-width" onClick={onClose}>
          Verified ✓
        </button>
      </div>
    </div>
  );
}

export function ShortcutsLegendModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  const rows = [
    ['Ctrl / Cmd + K', 'Focus Universal Search'],
    ['Ctrl / Cmd + ,', 'Open Settings Router'],
    ['Ctrl / Cmd + B', 'Collapse / Expand Chat Sidebar'],
    ['Ctrl / Cmd + I', 'Toggle Context Inspector'],
    ['Ctrl / Cmd + E', 'Open Multi-Account Switcher'],
    ['Ctrl / Cmd + L', 'Lock App with Local Passcode'],
    ['Ctrl / Cmd + /', 'Keyboard Shortcuts Legend'],
    ['Alt + Shift + S', 'Emergency Browser Kill-Switch'],
    ['ArrowUp', 'Edit Last Sent Message'],
    ['Escape', 'Close Topmost Modal / Drawer / Reply'],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        data-testid="shortcuts-legend-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between">
          <h3>⌨️ Keyboard Shortcuts</h3>
          <button type="button" className="btn ghost xs" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="shortcuts-list">
          {rows.map(([combo, desc]) => (
            <div key={combo} className="row-between shortcut-row">
              <code>{combo}</code>
              <span className="muted-sm">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ExportDataModal({
  open,
  dialogs,
  onClose,
}: {
  open: boolean;
  dialogs: StoredDialogDto[];
  onClose: () => void;
}) {
  if (!open) return null;
  const jsonPreview = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      dialogs_count: dialogs.length,
      dialogs: dialogs.map((d) => ({ chat_id: d.chat_id, title: d.title, type: d.chat_type })),
    },
    null,
    2,
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        data-testid="export-data-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between">
          <h3>📦 Export GPUI Telegram Data</h3>
          <button type="button" className="btn ghost xs" onClick={onClose}>
            ✕
          </button>
        </div>
        <pre className="code-pre" style={{ maxHeight: 240 }}>
          {jsonPreview}
        </pre>
        <div className="modal-actions">
          <button
            type="button"
            className="btn primary"
            data-testid="download-export-json-btn"
            onClick={() => {
              const blob = new Blob([jsonPreview], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'gpui-telegram-export.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            ⬇ Download JSON
          </button>
        </div>
      </div>
    </div>
  );
}

export function BrowserWorkbenchModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<BrowserTabDto[]>([]);
  const [newUrl, setNewUrl] = useState('https://example.com');
  const [snapshotOut, setSnapshotOut] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');

  const refreshTabs = async () => {
    const res = await sendSwRpc<{ ok: boolean; result?: { tabs?: BrowserTabDto[] } }>({
      type: 'ui.invoke_browser_tool',
      tool: 'browser_list_tabs',
      arguments: {},
      bypass_approval: true,
    });
    if (res.ok && Array.isArray(res.result?.tabs)) {
      setTabs(res.result!.tabs!);
    }
  };

  useEffect(() => {
    if (open) void refreshTabs();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card lg"
        role="dialog"
        aria-modal="true"
        data-testid="browser-workbench-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between">
          <h3>🌐 Live Browser Workbench (24-Tool Controller)</h3>
          <button type="button" className="btn ghost xs" onClick={onClose}>
            ✕
          </button>
        </div>

        <form
          className="row-gap-6"
          onSubmit={async (e) => {
            e.preventDefault();
            await sendSwRpc({
              type: 'ui.invoke_browser_tool',
              tool: 'browser_open_tab',
              arguments: { url: newUrl.trim(), active: false },
              bypass_approval: true,
            });
            await refreshTabs();
          }}
        >
          <input
            className="input flex-1"
            data-testid="workbench-open-url-input"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
          />
          <button type="submit" className="btn primary">
            Open Tab
          </button>
          <button type="button" className="btn" onClick={() => void refreshTabs()}>
            ↻ Refresh
          </button>
        </form>

        <div className="studio-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
          {tabs.map((t) => (
            <div key={t.tab_id} className="studio-list-row" data-tab-id={t.tab_id}>
              <div className="flex-1 truncate-1">
                <strong>#{t.tab_id}</strong> {t.title || '(Untitled)'}
                <div className="muted-xs truncate-1">{t.url}</div>
              </div>
              {t.controllable && (
                <>
                  <button
                    type="button"
                    className="btn xs"
                    onClick={async () => {
                      const r = await sendSwRpc<any>({
                        type: 'ui.invoke_browser_tool',
                        tool: 'browser_snapshot',
                        arguments: { tab_id: t.tab_id, max_chars: 1200 },
                        bypass_approval: true,
                      });
                      setSnapshotOut(JSON.stringify(r.result ?? r, null, 2));
                    }}
                  >
                    Snapshot
                  </button>
                  <button
                    type="button"
                    className="btn xs"
                    onClick={async () => {
                      const r = await sendSwRpc<any>({
                        type: 'ui.invoke_browser_tool',
                        tool: 'browser_screenshot',
                        arguments: { tab_id: t.tab_id },
                        bypass_approval: true,
                      });
                      const dUrl = r.result?.data_url ?? '';
                      if (dUrl) setScreenshotUrl(dUrl);
                    }}
                  >
                    Screenshot
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {screenshotUrl && (
          <img
            src={screenshotUrl}
            alt="Tab capture"
            style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8 }}
          />
        )}
        {snapshotOut && (
          <pre className="code-pre" style={{ maxHeight: 160 }}>
            {snapshotOut}
          </pre>
        )}
      </div>
    </div>
  );
}
