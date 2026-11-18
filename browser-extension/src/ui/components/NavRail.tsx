import React, { useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  type DesktopThemePreset,
  type ExtensionLocale,
  type ExtensionRuntimeStateSummary,
  type StoredAccountEntryDto,
} from '../../shared/rpc_types';
import { DESKTOP_THEME_PALETTES, THEME_CYCLE_ORDER } from '../theme/palettes';
import { tr } from '../i18n/translations';

export type WorkspacePrimaryTab = 'chats' | 'studio' | 'settings';

export function NavRail({
  state,
  locale,
  themePreset,
  activeTab,
  pendingApprovalsCount,
  accountMenuOpen,
  onToggleAccountMenu,
  onSelectTab,
  onOpenMainMenu,
  onOpenBrowserWorkbench,
  onOpenMiniAppLauncher,
  onCycleTheme,
  onSelectTheme,
  onToggleLocale,
  onLockApp,
  onSwitchAccount,
  onAddAccount,
  onLogoutAccount,
}: {
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  themePreset: DesktopThemePreset;
  activeTab: WorkspacePrimaryTab;
  pendingApprovalsCount: number;
  accountMenuOpen: boolean;
  onToggleAccountMenu: () => void;
  onSelectTab: (tab: WorkspacePrimaryTab) => void;
  onOpenMainMenu: () => void;
  onOpenBrowserWorkbench: () => void;
  onOpenMiniAppLauncher: () => void;
  onCycleTheme: () => void;
  onSelectTheme: (preset: DesktopThemePreset) => void;
  onToggleLocale: () => void;
  onLockApp: () => void;
  onSwitchAccount: (accountId: number | string) => void;
  onAddAccount: () => void;
  onLogoutAccount: (accountId?: number | string) => void;
}) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const accounts: StoredAccountEntryDto[] = Array.isArray(state.accounts) ? state.accounts : [];
  const activeInitial = (state.username || 'U').slice(0, 2).toUpperCase();

  return (
    <nav
      className="nav-rail"
      data-testid={CANONICAL_TEST_IDS.navRail}
      aria-label="Primary Navigation Rail"
    >
      <div className="nav-rail-top">
        <button
          type="button"
          className="rail-icon-btn"
          data-testid="main-menu-btn"
          aria-label={tr(locale, 'nav.menu')}
          title={tr(locale, 'nav.menu')}
          onClick={onOpenMainMenu}
        >
          ☰
        </button>

        <button
          type="button"
          className="rail-avatar-btn"
          data-testid="account-switcher-btn"
          aria-label={`${tr(locale, 'nav.accounts')}${state.username ? ` (@${state.username})` : ''}`}
          title={`${state.username ? `@${state.username}` : tr(locale, 'nav.accounts')} (Ctrl+E)`}
          onClick={onToggleAccountMenu}
        >
          <span>{activeInitial}</span>
          {accounts.length > 1 && <span className="rail-mini-dot">{accounts.length}</span>}
        </button>

        <button
          type="button"
          className={`rail-icon-btn ${activeTab === 'chats' ? 'active' : ''}`}
          data-testid="nav-chats-btn"
          data-nav="chats"
          aria-label={tr(locale, 'nav.chats')}
          title={tr(locale, 'nav.chats')}
          onClick={() => onSelectTab('chats')}
        >
          💬
          {state.unread_total > 0 && (
            <span className="rail-badge" data-testid="nav-unread-badge">
              {state.unread_total > 99 ? '99+' : state.unread_total}
            </span>
          )}
        </button>

        <button
          type="button"
          className={`rail-icon-btn ${activeTab === 'studio' ? 'active' : ''}`}
          data-testid="nav-studio-btn"
          data-nav="studio"
          aria-label="Hermes Studio & Approvals"
          title={tr(locale, 'nav.studio')}
          onClick={() => onSelectTab('studio')}
        >
          🧠
          {pendingApprovalsCount > 0 && (
            <span className="rail-badge warn">{pendingApprovalsCount}</span>
          )}
        </button>

        <button
          type="button"
          className="rail-icon-btn"
          data-testid="nav-browser-workbench-btn"
          data-nav="browser"
          aria-label={tr(locale, 'nav.browser')}
          title={tr(locale, 'nav.browser')}
          onClick={onOpenBrowserWorkbench}
        >
          🌐
        </button>

        <button
          type="button"
          className="rail-icon-btn"
          data-testid="nav-miniapps-btn"
          data-nav="miniapps"
          aria-label={tr(locale, 'nav.miniapps')}
          title={tr(locale, 'nav.miniapps')}
          onClick={onOpenMiniAppLauncher}
        >
          🧩
        </button>

        <button
          type="button"
          className={`rail-icon-btn ${activeTab === 'settings' ? 'active' : ''}`}
          data-testid="nav-settings-btn"
          data-nav="settings"
          aria-label={tr(locale, 'nav.settings')}
          title={`${tr(locale, 'nav.settings')} (Ctrl+,)`}
          onClick={() => onSelectTab('settings')}
        >
          ⚙️
        </button>
      </div>

      <div className="nav-rail-bottom">
        <button
          type="button"
          className="rail-icon-btn"
          data-testid="passcode-lock-btn"
          aria-label={tr(locale, 'nav.lock')}
          title={tr(locale, 'nav.lock')}
          onClick={onLockApp}
        >
          🔒
        </button>

        <button
          type="button"
          className="rail-icon-btn"
          data-testid={CANONICAL_TEST_IDS.themeToggleBtn}
          aria-label={`${tr(locale, 'nav.theme')} (${themePreset})`}
          title={`${tr(locale, 'nav.theme')}: ${themePreset}`}
          onClick={onCycleTheme}
          onContextMenu={(e) => {
            e.preventDefault();
            setThemeMenuOpen((v) => !v);
          }}
        >
          {themePreset === 'night'
            ? '🌙'
            : themePreset === 'tinted'
              ? '🌌'
              : themePreset === 'day'
                ? '☀️'
                : '🌿'}
        </button>

        <button
          type="button"
          className="rail-icon-btn lang-pill"
          data-testid={CANONICAL_TEST_IDS.langToggleBtn}
          aria-label={tr(locale, 'nav.language')}
          title={tr(locale, 'nav.language')}
          onClick={onToggleLocale}
        >
          {locale === 'zh-CN' ? '中' : 'EN'}
        </button>
      </div>

      {themeMenuOpen && (
        <div
          className="floating-popover rail-theme-popover"
          role="menu"
          data-testid="theme-picker-menu"
        >
          {THEME_CYCLE_ORDER.map((preset) => {
            const p = DESKTOP_THEME_PALETTES[preset];
            return (
              <button
                key={preset}
                type="button"
                role="menuitem"
                data-theme={preset}
                data-value={preset}
                className={`menu-item-btn ${themePreset === preset ? 'active' : ''}`}
                onClick={() => {
                  onSelectTheme(preset);
                  setThemeMenuOpen(false);
                }}
              >
                <span>{locale === 'zh-CN' ? p.labelZh : p.labelEn}</span>
                <span className="muted-xs">{preset}</span>
              </button>
            );
          })}
        </div>
      )}

      {accountMenuOpen && (
        <div
          className="floating-popover rail-account-popover"
          role="dialog"
          aria-label={tr(locale, 'nav.accounts')}
          data-testid="account-switcher-menu"
        >
          <div className="popover-header">{tr(locale, 'nav.accounts')}</div>
          {accounts.length === 0 && state.username && (
            <div className="account-item active" data-account-username={state.username}>
              <div>
                <strong>@{state.username}</strong>
                <div className="muted-xs">ID: {state.user_id ?? '-'}</div>
              </div>
              <span className="status-dot ok" />
            </div>
          )}
          {accounts.map((acc) => {
            const isActive =
              (state.user_id !== null && acc.user_id === state.user_id) ||
              (state.username && acc.username === state.username);
            return (
              <div
                key={`${acc.user_id}:${acc.username}:${acc.server_url}`}
                className={`account-item ${isActive ? 'active' : ''}`}
                data-testid={`account-option-${acc.username}`}
                data-account-id={acc.user_id || acc.username}
              >
                <button
                  type="button"
                  className="account-select-btn"
                  onClick={() => onSwitchAccount(acc.user_id || acc.username)}
                >
                  <span className="avatar-sm">{acc.username.slice(0, 2).toUpperCase()}</span>
                  <span className="account-meta">
                    <strong>@{acc.username}</strong>
                    <span className="muted-xs">{acc.server_url}</span>
                  </span>
                  {isActive && <span className="badge-pill">Active</span>}
                </button>
                <button
                  type="button"
                  className="btn ghost xs danger-text"
                  data-testid={`logout-account-${acc.username}`}
                  title="Log Out Account"
                  onClick={() => onLogoutAccount(acc.user_id || acc.username)}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <div className="popover-divider" />
          <button
            type="button"
            className="menu-item-btn"
            data-testid="add-account-btn"
            onClick={onAddAccount}
          >
            ＋ Add Another Account
          </button>
          <button
            type="button"
            className="menu-item-btn danger-text"
            data-testid="logout-active-btn"
            onClick={() => onLogoutAccount()}
          >
            ⎋ Log Out Current Account
          </button>
        </div>
      )}
    </nav>
  );
}

export function MainMenuDrawer({
  open,
  state,
  locale,
  themePreset,
  onClose,
  onOpenSavedMessages,
  onOpenArchivedChats,
  onOpenStudio,
  onOpenSettings,
  onOpenShortcuts,
  onCycleTheme,
  onSelectTheme,
  onToggleLocale,
  onAddAccount,
  onLogout,
}: {
  open: boolean;
  state: ExtensionRuntimeStateSummary;
  locale: ExtensionLocale;
  themePreset: DesktopThemePreset;
  onClose: () => void;
  onOpenSavedMessages: () => void;
  onOpenArchivedChats: () => void;
  onOpenStudio: () => void;
  onOpenSettings: (section?: string) => void;
  onOpenShortcuts: () => void;
  onCycleTheme: () => void;
  onSelectTheme: (preset: DesktopThemePreset) => void;
  onToggleLocale: () => void;
  onAddAccount: () => void;
  onLogout: () => void;
}) {
  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose} data-testid="main-menu-backdrop">
      <aside
        className="main-menu-drawer"
        data-testid="main-menu-drawer"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-profile-card">
          <div className="avatar-lg">{(state.username || 'TG').slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="drawer-user-name">@{state.username || 'guest'}</div>
            <div className="muted-xs">{state.server_url}</div>
          </div>
        </div>

        <div className="drawer-menu-list">
          <button type="button" className="menu-item-btn" onClick={() => { onOpenSavedMessages(); onClose(); }}>
            🔖 Saved Messages & Copilot
          </button>
          <button type="button" className="menu-item-btn" onClick={() => { onOpenArchivedChats(); onClose(); }}>
            📦 {tr(locale, 'sidebar.archived')}
          </button>
          <button type="button" className="menu-item-btn" onClick={() => { onOpenStudio(); onClose(); }}>
            🧠 {tr(locale, 'nav.studio')}
          </button>
          <button type="button" className="menu-item-btn" onClick={() => { onOpenSettings('Overview'); onClose(); }}>
            ⚙️ {tr(locale, 'nav.settings')}
          </button>
          <button type="button" className="menu-item-btn" onClick={() => { onOpenSettings('Chat'); onClose(); }}>
            🎨 {tr(locale, 'settings.Chat')}
          </button>
          <button type="button" className="menu-item-btn" onClick={() => { onOpenShortcuts(); onClose(); }}>
            ⌨️ Keyboard Shortcuts (Ctrl+/)
          </button>
          <button type="button" className="menu-item-btn" onClick={onToggleLocale}>
            🌐 {tr(locale, 'nav.language')}: {locale}
          </button>
          <button type="button" className="menu-item-btn" onClick={onCycleTheme}>
            🌓 {tr(locale, 'nav.theme')}: {themePreset}
          </button>

          <div className="drawer-theme-chips">
            {THEME_CYCLE_ORDER.map((preset) => (
              <button
                key={preset}
                type="button"
                data-theme={preset}
                data-value={preset}
                className={`chip-btn ${themePreset === preset ? 'active' : ''}`}
                onClick={() => onSelectTheme(preset)}
              >
                {DESKTOP_THEME_PALETTES[preset][locale === 'zh-CN' ? 'labelZh' : 'labelEn']}
              </button>
            ))}
          </div>

          <div className="popover-divider" />
          <button type="button" className="menu-item-btn" onClick={() => { onAddAccount(); onClose(); }}>
            ＋ Add Account
          </button>
          <button
            type="button"
            className="menu-item-btn danger-text"
            data-testid="drawer-logout-btn"
            onClick={() => { onLogout(); onClose(); }}
          >
            ⎋ Log Out
          </button>
        </div>
      </aside>
    </div>
  );
}
