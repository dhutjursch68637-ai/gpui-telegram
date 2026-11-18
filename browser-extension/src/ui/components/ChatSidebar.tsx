import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CANONICAL_TEST_IDS,
  LOCAL_COPILOT_CHAT_ID,
  OFFICIAL_BOT_USER_ID,
  type ExtensionLocale,
  type StoredDialogDto,
} from '../../shared/rpc_types';
import { apiRequest } from '../api/server_api';
import { tr } from '../i18n/translations';
import { sendSwRpc } from '../sw_client';

export interface FolderDto {
  folder_id: string | number;
  title: string;
  icon?: string;
  included_chat_ids: number[];
  pinned_chat_ids?: number[];
  include_bots?: boolean;
  include_groups?: boolean;
  include_channels?: boolean;
}

export interface ForumTopicDto {
  topic_id: number;
  chat_id: number;
  title: string;
  icon_emoji?: string;
  unread_count?: number;
}

type CreateModalKind =
  | null
  | 'group'
  | 'channel'
  | 'forum'
  | 'fabushi'
  | 'botfather'
  | 'contact'
  | 'folder'
  | 'story'
  | 'topic';

const SEARCH_FILTER_TAGS = ['Contacts', 'Groups', 'Channels', 'Bots', 'Unread', 'Media'] as const;
const SEARCH_CATEGORIES = [
  'All',
  'Chats',
  'Messages',
  'Media',
  'Links',
  'Files',
  'Music',
  'Voice',
  'Bots',
  'Global',
] as const;

export function ChatSidebar({
  surface,
  locale,
  authenticated,
  dialogs,
  selectedChatId,
  selectedTopicId,
  sidebarWidth,
  collapsed,
  searchInputRef,
  showArchivedDrawer,
  onToggleArchivedDrawer,
  onResizeWidth,
  onSelectDialog,
  onSelectTopic,
  onDialogsChanged,
}: {
  surface: 'workspace' | 'sidepanel';
  locale: ExtensionLocale;
  authenticated: boolean;
  dialogs: StoredDialogDto[];
  selectedChatId: number;
  selectedTopicId: number | null;
  sidebarWidth: number;
  collapsed: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  showArchivedDrawer: boolean;
  onToggleArchivedDrawer: (open: boolean) => void;
  onResizeWidth: (nextWidth: number) => void;
  onSelectDialog: (dlg: StoredDialogDto) => void;
  onSelectTopic: (topicId: number | null) => void;
  onDialogsChanged: () => Promise<void> | void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilterTag, setActiveFilterTag] = useState<string>('');
  const [activeSearchCat, setActiveSearchCat] = useState<string>('All');
  const [remoteMessageHits, setRemoteMessageHits] = useState<Array<Record<string, any>>>([]);
  const [remoteGlobalChats, setRemoteGlobalChats] = useState<Array<Record<string, any>>>([]);
  const [searchingRemote, setSearchingRemote] = useState(false);

  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string>('all');

  const [stories, setStories] = useState<Array<Record<string, any>>>([]);
  const [activeStoryModal, setActiveStoryModal] = useState<Record<string, any> | null>(null);

  const [topics, setTopics] = useState<ForumTopicDto[]>([]);

  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createModal, setCreateModal] = useState<CreateModalKind>(null);
  const [modalError, setModalError] = useState('');
  const [modalBusy, setModalBusy] = useState(false);

  // Creation form fields
  const [newChatTitle, setNewChatTitle] = useState('');
  const [newChatAbout, setNewChatAbout] = useState('');
  const [botName, setBotName] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [botPersona, setBotPersona] = useState('');
  const [botFatherPrompt, setBotFatherPrompt] = useState('');
  const [contactTarget, setContactTarget] = useState('');
  const [folderTitle, setFolderTitle] = useState('');
  const [folderSelectedChats, setFolderSelectedChats] = useState<number[]>([]);
  const [storyCaption, setStoryCaption] = useState('');
  const [topicTitle, setTopicTitle] = useState('');

  // Context menu & delete confirmation state
  const [ctxMenu, setCtxMenu] = useState<{
    dlg: StoredDialogDto;
    x: number;
    y: number;
  } | null>(null);
  const [pendingDeleteDlg, setPendingDeleteDlg] = useState<StoredDialogDto | null>(null);
  const [sidepanelListExpanded, setSidepanelListExpanded] = useState(false);

  const searchSeqRef = useRef(0);

  const copilotDialog: StoredDialogDto = useMemo(
    () => ({
      chat_id: LOCAL_COPILOT_CHAT_ID,
      chat_type: 'bot',
      title: tr(locale, 'sidebar.localCopilot'),
      peer_user_id: OFFICIAL_BOT_USER_ID,
      peer_username: 'hermes_browser_copilot',
      is_bot: true,
      is_pinned: true,
      unread_count: 0,
      pts: 0,
      last_message_preview: tr(locale, 'sidebar.localCopilotSub'),
      updated_at_ms: 0,
    }),
    [locale],
  );

  const loadFoldersAndStories = useCallback(async () => {
    if (!authenticated) return;
    const [fRes, sRes] = await Promise.all([
      apiRequest<any>('/api/v1/folders'),
      apiRequest<any>('/api/v1/stories'),
    ]);
    if (fRes.ok) {
      const list = Array.isArray(fRes.data?.folders)
        ? fRes.data.folders
        : Array.isArray(fRes.data)
          ? fRes.data
          : [];
      setFolders(
        list.map((f: any) => ({
          folder_id: f.folder_id ?? f.id ?? String(f.title),
          title: String(f.title ?? f.name ?? 'Folder'),
          icon: typeof f.icon === 'string' ? f.icon : typeof f.emoticon === 'string' ? f.emoticon : undefined,
          included_chat_ids: Array.isArray(f.included_chat_ids)
            ? f.included_chat_ids.map(Number)
            : Array.isArray(f.include_chats)
              ? f.include_chats.map(Number)
              : Array.isArray(f.chat_ids)
                ? f.chat_ids.map(Number)
                : [],
          pinned_chat_ids: Array.isArray(f.pinned_chat_ids)
            ? f.pinned_chat_ids.map(Number)
            : Array.isArray(f.pinned_chats)
              ? f.pinned_chats.map(Number)
              : [],
          include_bots: Boolean(f.include_bots),
          include_groups: Boolean(f.include_groups),
          include_channels: Boolean(f.include_channels),
        })),
      );
    }
    if (sRes.ok) {
      const stList = Array.isArray(sRes.data?.stories)
        ? sRes.data.stories
        : Array.isArray(sRes.data)
          ? sRes.data
          : [];
      setStories(stList);
    }
  }, [authenticated]);

  useEffect(() => {
    void loadFoldersAndStories();
  }, [loadFoldersAndStories]);

  const activeSelectedDialog = useMemo(
    () => dialogs.find((d) => d.chat_id === selectedChatId) ?? null,
    [dialogs, selectedChatId],
  );

  // Load Forum Topics when selected dialog is a forum
  useEffect(() => {
    if (!authenticated || !activeSelectedDialog?.is_forum || activeSelectedDialog.chat_id <= 0) {
      setTopics([]);
      return;
    }
    void apiRequest<any>(`/api/v1/chats/${activeSelectedDialog.chat_id}/topics`).then((res) => {
      if (res.ok) {
        const list = Array.isArray(res.data?.topics)
          ? res.data.topics
          : Array.isArray(res.data)
            ? res.data
            : [];
        const mapped: ForumTopicDto[] = list.map((t: any) => ({
          topic_id: Number(t.topic_id ?? t.id ?? 1),
          chat_id: activeSelectedDialog.chat_id,
          title: String(t.title ?? 'General'),
          icon_emoji: typeof t.icon_emoji === 'string' ? t.icon_emoji : '💬',
          unread_count: Number(t.unread_count ?? 0),
        }));
        if (!mapped.some((t) => t.topic_id === 1 || /^general$/i.test(t.title))) {
          mapped.unshift({
            topic_id: 1,
            chat_id: activeSelectedDialog.chat_id,
            title: 'General',
            icon_emoji: '💬',
            unread_count: 0,
          });
        }
        setTopics(mapped);
      }
    });
  }, [authenticated, activeSelectedDialog?.chat_id, activeSelectedDialog?.is_forum]);

  // Universal Search remote query
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !authenticated) {
      setRemoteMessageHits([]);
      setRemoteGlobalChats([]);
      setSearchingRemote(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchingRemote(true);
    const timer = window.setTimeout(async () => {
      const catLower = activeSearchCat.toLowerCase();
      const filterParam =
        activeFilterTag === 'Bots'
          ? 'bots'
          : activeFilterTag
            ? activeFilterTag.toLowerCase()
            : catLower;
      const res = await apiRequest<any>(
        `/api/v1/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filterParam)}&category=${encodeURIComponent(catLower)}`,
      );
      if (seq !== searchSeqRef.current) return;
      setSearchingRemote(false);
      if (res.ok && res.data) {
        const msgs = Array.isArray(res.data.messages)
          ? res.data.messages
          : Array.isArray(res.data.results)
            ? res.data.results
            : [];
        const chats = Array.isArray(res.data.chats)
          ? res.data.chats
          : Array.isArray(res.data.users)
            ? res.data.users
            : [];
        setRemoteMessageHits(msgs);
        setRemoteGlobalChats(chats);
      } else {
        setRemoteMessageHits([]);
        setRemoteGlobalChats([]);
      }
    }, 140);

    return () => window.clearTimeout(timer);
  }, [searchQuery, activeSearchCat, activeFilterTag, authenticated]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu && !createMenuOpen) return;
    const closeMenus = () => {
      setCtxMenu(null);
      setCreateMenuOpen(false);
    };
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, [ctxMenu, createMenuOpen]);

  const allMergedDialogs = useMemo(() => {
    const serverList = dialogs.filter((d) => d.chat_id !== LOCAL_COPILOT_CHAT_ID);
    const sorted = [...serverList].sort((a, b) => {
      if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) {
        return a.is_pinned ? -1 : 1;
      }
      return (b.updated_at_ms || 0) - (a.updated_at_ms || 0);
    });
    return [copilotDialog, ...sorted];
  }, [copilotDialog, dialogs]);

  const archivedDialogs = useMemo(
    () => allMergedDialogs.filter((d) => d.is_archived && d.chat_id !== LOCAL_COPILOT_CHAT_ID),
    [allMergedDialogs],
  );

  const visibleDialogs = useMemo(() => {
    let base = showArchivedDrawer
      ? archivedDialogs
      : allMergedDialogs.filter((d) => !d.is_archived);

    if (!showArchivedDrawer && activeFolderId !== 'all') {
      const folder = folders.find((f) => String(f.folder_id) === activeFolderId);
      if (folder) {
        base = base.filter((d) => {
          if (folder.included_chat_ids.includes(d.chat_id)) return true;
          if ((folder.pinned_chat_ids ?? []).includes(d.chat_id)) return true;
          if (folder.include_bots && (d.is_bot || d.chat_type === 'bot')) return true;
          if (
            folder.include_groups &&
            (d.chat_type === 'group' || d.chat_type === 'supergroup')
          ) {
            return true;
          }
          if (folder.include_channels && d.chat_type === 'channel') return true;
          return false;
        });
      }
    }

    if (activeFilterTag) {
      base = base.filter((d) => {
        if (activeFilterTag === 'Bots') return Boolean(d.is_bot || d.chat_type === 'bot');
        if (activeFilterTag === 'Groups') {
          return d.chat_type === 'group' || d.chat_type === 'supergroup';
        }
        if (activeFilterTag === 'Channels') return d.chat_type === 'channel';
        if (activeFilterTag === 'Contacts') return d.chat_type === 'private' && !d.is_bot;
        if (activeFilterTag === 'Unread') return d.unread_count > 0;
        return true;
      });
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;

    // Safe literal substring match (never unescaped RegExp — T2-F12-01)
    return base.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.peer_username ?? '').toLowerCase().includes(q) ||
        (d.last_message_preview ?? '').toLowerCase().includes(q),
    );
  }, [
    activeFilterTag,
    activeFolderId,
    allMergedDialogs,
    archivedDialogs,
    folders,
    searchQuery,
    showArchivedDrawer,
  ]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const clamped = Math.min(360, Math.max(240, Math.round(startW + delta)));
      onResizeWidth(clamped);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleCreateGroupOrChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');
    const cleanTitle = newChatTitle.trim();
    if (!cleanTitle) {
      setModalError('Title is required and cannot be empty.');
      return;
    }
    setModalBusy(true);
    const chatType =
      createModal === 'channel'
        ? 'channel'
        : createModal === 'forum'
          ? 'supergroup'
          : 'group';
    const res = await apiRequest<any>('/api/v1/chats', {
      method: 'POST',
      body: {
        title: cleanTitle,
        chat_type: chatType,
        type: chatType,
        is_forum: createModal === 'forum',
        about: newChatAbout.trim() || undefined,
      },
    });
    setModalBusy(false);
    if (!res.ok) {
      setModalError(res.error || 'Failed to create conversation');
      return;
    }
    setCreateModal(null);
    setNewChatTitle('');
    setNewChatAbout('');
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
    const newId = Number(res.data?.chat_id ?? res.data?.chat?.chat_id ?? res.data?.id ?? 0);
    if (newId > 0) {
      onSelectDialog({
        chat_id: newId,
        chat_type: chatType,
        title: cleanTitle,
        is_forum: createModal === 'forum',
        unread_count: 0,
        pts: 0,
        updated_at_ms: Date.now(),
      });
    }
  };

  const handleCreateFabushiBot = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');
    const cleanName = botName.trim();
    const rawHandle = botUsername.trim();
    if (!cleanName) {
      setModalError('Bot display name is required.');
      return;
    }

    // Auto-derive valid bot username if omitted (T1-F12-02), but strictly validate if entered (T2-F12-03)
    let cleanHandle = '';
    if (rawHandle === '') {
      const slug = cleanName
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const base = /^[a-z]/.test(slug) ? slug : `bot_${slug || 'agent'}`;
      const trimmedBase = base.slice(0, 24).replace(/_+$/, '');
      cleanHandle = trimmedBase.endsWith('_bot') ? trimmedBase : `${trimmedBase}_bot`;
      if (cleanHandle.length < 5) {
        cleanHandle = `${cleanHandle}_${Date.now().toString(36).slice(-4)}_bot`;
      }
    } else {
      cleanHandle = rawHandle.replace(/^@/, '');
      if (!/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(cleanHandle)) {
        setModalError(
          'Invalid bot username: must be 3-32 characters starting with a letter and containing only letters, digits, or underscores (no spaces or special symbols).',
        );
        return;
      }
    }

    setModalBusy(true);
    const res = await apiRequest<any>('/api/v1/fabushi-bots', {
      method: 'POST',
      body: {
        name: cleanName,
        title: cleanName,
        display_name: cleanName,
        username: cleanHandle,
        description: botPersona.trim() || `AI Companion ${cleanName}`,
        system_prompt: botPersona.trim() || `You are ${cleanName}.`,
      },
    });
    setModalBusy(false);
    if (!res.ok) {
      setModalError(res.error || 'Failed to create Fabushi AI Bot');
      return;
    }
    setCreateModal(null);
    setBotName('');
    setBotUsername('');
    setBotPersona('');
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
    const companionChatId = Number(
      res.data?.companion_chat_id ?? res.data?.chat_id ?? res.data?.bot?.companion_chat_id ?? 0,
    );
    if (companionChatId > 0) {
      onSelectDialog({
        chat_id: companionChatId,
        chat_type: 'bot',
        title: cleanName,
        peer_username: cleanHandle,
        is_bot: true,
        unread_count: 0,
        pts: 0,
        updated_at_ms: Date.now(),
      });
    }
  };

  const handleCreateBotFatherNl = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');
    if (!botFatherPrompt.trim()) {
      setModalError('Please describe the bot you want @BotFather to build.');
      return;
    }
    setModalBusy(true);
    const res = await apiRequest<any>('/api/v1/botfather/nl-create', {
      method: 'POST',
      body: {
        prompt: botFatherPrompt.trim(),
        description: botFatherPrompt.trim(),
      },
    });
    setModalBusy(false);
    if (!res.ok) {
      setModalError(res.error || '@BotFather creation failed');
      return;
    }
    setCreateModal(null);
    setBotFatherPrompt('');
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
    const cid = Number(res.data?.companion_chat_id ?? res.data?.chat_id ?? 0);
    if (cid > 0) {
      onSelectDialog({
        chat_id: cid,
        chat_type: 'bot',
        title: String(res.data?.bot?.name ?? res.data?.name ?? 'Created Bot'),
        peer_username: res.data?.bot?.username ?? res.data?.username,
        is_bot: true,
        unread_count: 0,
        pts: 0,
        updated_at_ms: Date.now(),
      });
    }
  };

  const handleAddContactOrDm = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');
    const target = contactTarget.trim().replace(/^@/, '');
    if (!target) {
      setModalError('Enter a username, phone, or user ID.');
      return;
    }
    setModalBusy(true);
    let peerUserId: number | null = Number.isFinite(Number(target)) ? Number(target) : null;
    if (!peerUserId) {
      const resolved = await apiRequest<any>(
        `/api/v1/peers/resolve?username=${encodeURIComponent(target)}`,
      );
      if (resolved.ok) {
        peerUserId = Number(resolved.data?.user_id ?? resolved.data?.user?.id ?? 0) || null;
      }
    }
    await apiRequest('/api/v1/contacts', {
      method: 'POST',
      body: {
        username: target,
        ...(peerUserId ? { user_id: peerUserId } : {}),
      },
    });
    const dmRes = await apiRequest<any>('/api/v1/chats', {
      method: 'POST',
      body: {
        chat_type: 'private',
        type: 'private',
        title: target,
        ...(peerUserId ? { peer_user_id: peerUserId, member_ids: [peerUserId] } : { username: target }),
      },
    });
    setModalBusy(false);
    if (!dmRes.ok) {
      setModalError(dmRes.error || 'Could not start direct chat with user.');
      return;
    }
    setCreateModal(null);
    setContactTarget('');
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
    const cid = Number(dmRes.data?.chat_id ?? dmRes.data?.chat?.chat_id ?? dmRes.data?.id ?? 0);
    if (cid > 0) {
      onSelectDialog({
        chat_id: cid,
        chat_type: 'private',
        title: String(dmRes.data?.title ?? target),
        peer_username: target,
        unread_count: 0,
        pts: 0,
        updated_at_ms: Date.now(),
      });
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');
    if (!folderTitle.trim()) {
      setModalError('Folder name is required.');
      return;
    }
    setModalBusy(true);
    const res = await apiRequest<any>('/api/v1/folders', {
      method: 'POST',
      body: {
        title: folderTitle.trim(),
        include_chats: folderSelectedChats,
        included_chat_ids: folderSelectedChats,
        chat_ids: folderSelectedChats,
      },
    });
    setModalBusy(false);
    if (!res.ok) {
      setModalError(res.error || 'Failed to create folder');
      return;
    }
    setCreateModal(null);
    setFolderTitle('');
    setFolderSelectedChats([]);
    await loadFoldersAndStories();
  };

  const handleDeleteFolder = async (folderId: string | number, e: React.MouseEvent) => {
    e.stopPropagation();
    // Immediately fall back to 'all' if deleting active folder (T2-F12-04)
    if (String(activeFolderId) === String(folderId)) {
      setActiveFolderId('all');
    }
    setFolders((prev) => prev.filter((f) => String(f.folder_id) !== String(folderId)));
    await apiRequest(`/api/v1/folders/${encodeURIComponent(String(folderId))}`, {
      method: 'DELETE',
    });
  };

  const handleCreateStory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storyCaption.trim()) return;
    setModalBusy(true);
    await apiRequest('/api/v1/stories', {
      method: 'POST',
      body: { caption: storyCaption.trim(), text: storyCaption.trim() },
    });
    setModalBusy(false);
    setStoryCaption('');
    setCreateModal(null);
    await loadFoldersAndStories();
  };

  const handleCreateTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicTitle.trim() || !activeSelectedDialog) return;
    setModalBusy(true);
    const res = await apiRequest<any>(`/api/v1/chats/${activeSelectedDialog.chat_id}/topics`, {
      method: 'POST',
      body: { title: topicTitle.trim(), icon_emoji: '📌' },
    });
    setModalBusy(false);
    if (res.ok) {
      const tid = Number(res.data?.topic_id ?? res.data?.id ?? 0);
      setTopicTitle('');
      setCreateModal(null);
      const listRes = await apiRequest<any>(`/api/v1/chats/${activeSelectedDialog.chat_id}/topics`);
      if (listRes.ok) {
        const list = Array.isArray(listRes.data?.topics) ? listRes.data.topics : [];
        const mapped: ForumTopicDto[] = list.map((t: any) => ({
          topic_id: Number(t.topic_id ?? t.id),
          chat_id: activeSelectedDialog.chat_id,
          title: String(t.title ?? 'Topic'),
          icon_emoji: t.icon_emoji ?? '📌',
        }));
        if (!mapped.some((t) => t.topic_id === 1 || /^general$/i.test(t.title))) {
          mapped.unshift({
            topic_id: 1,
            chat_id: activeSelectedDialog.chat_id,
            title: 'General',
            icon_emoji: '💬',
            unread_count: 0,
          });
        }
        setTopics(mapped);
      }
      if (tid > 0) onSelectTopic(tid);
    }
  };

  const handleDialogAction = async (
    action: 'pin' | 'mute' | 'read' | 'unread' | 'archive' | 'clear' | 'delete',
    dlg: StoredDialogDto,
  ) => {
    setCtxMenu(null);
    if (action === 'delete') {
      setPendingDeleteDlg(dlg);
      return;
    }
    if (dlg.chat_id <= 0) {
      if (action === 'clear') {
        await sendSwRpc({ type: 'ui.clear_chat', chat_id: dlg.chat_id });
      }
      return;
    }
    if (action === 'unread') {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/unread`, {
        method: 'POST',
        body: { unread: true },
      });
      await sendSwRpc({ type: 'ui.mark_unread', chat_id: dlg.chat_id });
      await onDialogsChanged();
      return;
    }
    if (action === 'pin') {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/pin`, {
        method: 'POST',
        body: { pinned: !dlg.is_pinned, is_pinned: !dlg.is_pinned },
      });
    } else if (action === 'mute') {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/mute`, {
        method: 'POST',
        body: { muted: !dlg.is_muted },
      });
    } else if (action === 'read') {
      await sendSwRpc({
        type: 'ui.mark_read',
        chat_id: dlg.chat_id,
        max_message_id: dlg.last_message_id,
      });
    } else if (action === 'archive') {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/archive`, {
        method: 'POST',
        body: { archived: !dlg.is_archived },
      });
    } else if (action === 'clear') {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/clear`, { method: 'POST', body: {} });
      await sendSwRpc({ type: 'ui.clear_chat', chat_id: dlg.chat_id });
    }
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
  };

  const confirmDeleteDialog = async () => {
    const dlg = pendingDeleteDlg;
    if (!dlg) return;
    setPendingDeleteDlg(null);
    if (dlg.chat_id > 0) {
      await apiRequest(`/api/v1/chats/${dlg.chat_id}/leave`, { method: 'POST', body: {} });
      await apiRequest(`/api/v1/chats/${dlg.chat_id}`, { method: 'DELETE' });
    }
    await sendSwRpc({ type: 'ui.delete_dialog', chat_id: dlg.chat_id });
    await sendSwRpc({ type: 'ui.sync_dialogs' });
    await onDialogsChanged();
  };

  const isSearching = searchQuery.trim().length > 0;
  const noSearchHits =
    isSearching &&
    visibleDialogs.length === 0 &&
    remoteMessageHits.length === 0 &&
    remoteGlobalChats.length === 0 &&
    !searchingRemote;

  const bindSearchInputRef = useCallback(
    (el: HTMLInputElement | null) => {
      (searchInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    },
    [searchInputRef],
  );

  const createMenuPopoverNode = createMenuOpen ? (
    <div
      className="floating-popover create-menu-popover"
      role="menu"
      data-testid="create-menu-popover"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        data-action="create-group"
        data-testid="menu-create-group"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('group');
        }}
      >
        👥 {tr(locale, 'sidebar.createGroup')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="create-channel"
        data-testid="menu-create-channel"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('channel');
        }}
      >
        📢 {tr(locale, 'sidebar.createChannel')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="create-forum"
        data-testid="menu-create-forum"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('forum');
        }}
      >
        🏛️ {tr(locale, 'sidebar.createForum')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="create-fabushi-bot"
        data-testid="menu-create-fabushi-bot"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('fabushi');
        }}
      >
        🤖 {tr(locale, 'sidebar.createBot')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="create-botfather"
        data-testid="menu-create-botfather"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('botfather');
        }}
      >
        ✨ {tr(locale, 'sidebar.createBotFather')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="add-contact"
        data-testid="menu-add-contact"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('contact');
        }}
      >
        👤 {tr(locale, 'sidebar.addContact')}
      </button>
      <div className="popover-divider" />
      <button
        type="button"
        role="menuitem"
        data-action="create-folder"
        data-testid="menu-create-folder"
        className="menu-item-btn"
        onClick={() => {
          setCreateMenuOpen(false);
          setModalError('');
          setCreateModal('folder');
        }}
      >
        📁 {tr(locale, 'sidebar.newFolder')}
      </button>
    </div>
  ) : null;

  const effectiveWidth = collapsed ? 64 : Math.min(360, Math.max(240, sidebarWidth));

  return (
    <>
      {surface === 'sidepanel' ? (
        <aside className="sidepanel-chat-strip" data-testid={CANONICAL_TEST_IDS.chatSidebar}>
          <div className="sidepanel-search-row">
            <input
              ref={bindSearchInputRef}
              className="input sm flex-1"
              data-testid={CANONICAL_TEST_IDS.chatSearchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tr(locale, 'sidebar.searchPlaceholder')}
            />
            <button
              type="button"
              className="btn sm"
              data-testid="sidepanel-toggle-chats-btn"
              onClick={() => setSidepanelListExpanded((v) => !v)}
              title={tr(locale, 'nav.chats')}
            >
              {sidepanelListExpanded ? '▲' : `💬 ${allMergedDialogs.length}`}
            </button>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn sm primary"
                data-testid={CANONICAL_TEST_IDS.createMenuBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setCreateMenuOpen((v) => !v);
                }}
                title="Create"
              >
                +
              </button>
              {createMenuPopoverNode}
            </div>
          </div>

          <div className="sidepanel-pills-scroll" role="listbox" aria-label={tr(locale, 'nav.chats')}>
            {visibleDialogs.map((dlg) => (
              <button
                key={dlg.chat_id}
                type="button"
                role="option"
                aria-selected={selectedChatId === dlg.chat_id}
                data-chat-id={dlg.chat_id}
                data-dialog-id={dlg.chat_id}
                className={`sidepanel-chat-pill ${selectedChatId === dlg.chat_id ? 'selected' : ''}`}
                onClick={() => onSelectDialog(dlg)}
              >
                <span className="pill-title">{dlg.title}</span>
                {dlg.unread_count > 0 && <span className="unread-badge">{dlg.unread_count}</span>}
              </button>
            ))}
          </div>

          {noSearchHits && (
            <div className="empty-search-box compact" data-testid="search-empty-state">
              {tr(locale, 'sidebar.noResults')}
            </div>
          )}

          {sidepanelListExpanded && (
            <div className="sidepanel-expanded-list">
              {visibleDialogs.map((dlg) => (
                <button
                  key={`exp-${dlg.chat_id}`}
                  type="button"
                  className={`dialog-row compact ${selectedChatId === dlg.chat_id ? 'selected' : ''}`}
                  data-chat-id={dlg.chat_id}
                  onClick={() => {
                    onSelectDialog(dlg);
                    setSidepanelListExpanded(false);
                  }}
                >
                  <div className="dialog-avatar">{dlg.title.slice(0, 2).toUpperCase()}</div>
                  <div className="dialog-body">
                    <div className="dialog-title-row">
                      <span className="dialog-title">{dlg.title}</span>
                    </div>
                    <div className="dialog-preview">
                      {dlg.last_message_preview || (dlg.peer_username ? `@${dlg.peer_username}` : '')}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      ) : (
        <>
          <aside
            className={`chat-sidebar ${collapsed ? 'collapsed' : ''}`}
            data-testid={CANONICAL_TEST_IDS.chatSidebar}
            style={{
              width: effectiveWidth,
              minWidth: effectiveWidth,
              maxWidth: effectiveWidth,
            }}
          >
            {/* Search & `+` Creation Header */}
            <div className="sidebar-header">
              {showArchivedDrawer ? (
                <button
                  type="button"
                  className="btn sm"
                  data-testid="archived-back-btn"
                  onClick={() => onToggleArchivedDrawer(false)}
                >
                  ← {tr(locale, 'sidebar.allChats')}
                </button>
              ) : null}

              {!collapsed && (
                <div className="search-input-wrap">
                  <input
                    ref={bindSearchInputRef}
                    className="input search-input"
                    data-testid={CANONICAL_TEST_IDS.chatSearchInput}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={tr(locale, 'sidebar.searchPlaceholder')}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="search-clear-btn"
                      aria-label="Clear search"
                      onClick={() => setSearchQuery('')}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn icon-btn primary"
                  data-testid={CANONICAL_TEST_IDS.createMenuBtn}
                  aria-label="Create chat, group, channel, or AI bot"
                  title="Create (+)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreateMenuOpen((v) => !v);
                  }}
                >
                  +
                </button>
                {createMenuPopoverNode}
              </div>
            </div>

        {/* Stories & Top Peers Horizontal Strip */}
        {!collapsed && !isSearching && !showArchivedDrawer && (
          <div className="stories-strip" data-testid="stories-strip">
            <button
              type="button"
              className="story-ring-btn add"
              data-testid="add-story-btn"
              onClick={() => {
                setModalError('');
                setCreateModal('story');
              }}
              title="Post Story"
            >
              <span className="story-avatar">＋</span>
              <span className="story-label">Story</span>
            </button>
            {stories.map((st, idx) => (
              <button
                key={String(st.story_id ?? st.id ?? idx)}
                type="button"
                className="story-ring-btn"
                data-testid="story-ring-item"
                onClick={() => setActiveStoryModal(st)}
              >
                <span className="story-avatar active">
                  {String(st.username ?? st.author_name ?? 'ST').slice(0, 2).toUpperCase()}
                </span>
                <span className="story-label">
                  {String(st.username ?? st.caption ?? 'Story').slice(0, 8)}
                </span>
              </button>
            ))}
            {allMergedDialogs.slice(0, 4).map((peer) => (
              <button
                key={`peer-${peer.chat_id}`}
                type="button"
                className="story-ring-btn peer"
                onClick={() => onSelectDialog(peer)}
                title={peer.title}
              >
                <span className="story-avatar">{peer.title.slice(0, 2).toUpperCase()}</span>
                <span className="story-label">{peer.title.slice(0, 7)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Search Filter Tags & 10 Category Tabs when Universal Search active */}
        {!collapsed && (isSearching || activeFilterTag !== '') && (
          <div className="search-filters-panel" data-testid="search-filters-panel">
            <div className="filter-chips-row">
              {SEARCH_FILTER_TAGS.map((tag) => {
                const normTag = tag === 'Bots' ? 'bot' : tag.toLowerCase();
                return (
                  <button
                    key={tag}
                    type="button"
                    data-filter-tag={tag.toLowerCase()}
                    data-tag={normTag}
                    data-filter={normTag}
                    className={`chip-btn xs ${activeFilterTag === tag ? 'active' : ''}`}
                    onClick={() => setActiveFilterTag((prev) => (prev === tag ? '' : tag))}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
            <div className="search-cat-tabs" role="tablist">
              {SEARCH_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={activeSearchCat === cat}
                  data-search-tab={cat.toLowerCase()}
                  data-category={cat.toLowerCase()}
                  data-tab={cat.toLowerCase()}
                  className={`folder-tab-btn xs ${activeSearchCat === cat ? 'active' : ''}`}
                  onClick={() => setActiveSearchCat(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Folder Tabs Bar */}
        {!collapsed && !isSearching && !showArchivedDrawer && (
          <div className="folder-tabs-bar" role="tablist" data-testid="folder-tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeFolderId === 'all'}
              data-folder-id="all"
              className={`folder-tab-btn ${activeFolderId === 'all' ? 'active' : ''}`}
              onClick={() => setActiveFolderId('all')}
            >
              {tr(locale, 'sidebar.allChats')}
            </button>
            {folders.map((f) => {
              const fid = String(f.folder_id);
              const folderUnread = allMergedDialogs
                .filter(
                  (d) =>
                    !d.is_archived &&
                    (f.included_chat_ids.includes(d.chat_id) ||
                      (f.pinned_chat_ids ?? []).includes(d.chat_id)),
                )
                .reduce((acc, d) => acc + (d.unread_count || 0), 0);
              return (
                <div key={fid} className={`folder-tab-chip ${activeFolderId === fid ? 'active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFolderId === fid}
                    data-folder-id={fid}
                    data-unread={folderUnread}
                    className="folder-tab-inner"
                    onClick={() => setActiveFolderId(fid)}
                  >
                    <span>{f.title}</span>
                    {folderUnread > 0 && <span className="unread-badge xs">{folderUnread}</span>}
                  </button>
                  <button
                    type="button"
                    className="folder-del-btn"
                    data-testid={`delete-folder-${fid}`}
                    aria-label={`Delete folder ${f.title}`}
                    onClick={(e) => void handleDeleteFolder(f.folder_id, e)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="folder-tab-btn ghost"
              data-testid="create-folder-btn"
              title={tr(locale, 'sidebar.newFolder')}
              onClick={() => {
                setModalError('');
                setCreateModal('folder');
              }}
            >
              ＋
            </button>
            {archivedDialogs.length > 0 && (
              <button
                type="button"
                className="folder-tab-btn ghost"
                data-testid="archived-chats-btn"
                onClick={() => onToggleArchivedDrawer(true)}
              >
                📦 {tr(locale, 'sidebar.archived')} ({archivedDialogs.length})
              </button>
            )}
          </div>
        )}

        {/* Forum Topics Sub-Strip when active dialog is a Forum */}
        {!collapsed && activeSelectedDialog?.is_forum && (
          <div className="forum-topics-bar" data-testid="forum-topics-bar">
            <div className="forum-topics-header">
              <span>🏛️ {tr(locale, 'sidebar.topics')}</span>
              <button
                type="button"
                className="btn ghost xs"
                data-testid="create-topic-btn"
                onClick={() => {
                  setModalError('');
                  setCreateModal('topic');
                }}
              >
                + {tr(locale, 'sidebar.newTopic')}
              </button>
            </div>
            <div className="forum-topics-pills">
              <button
                type="button"
                data-topic-id="all"
                className={`chip-btn xs ${selectedTopicId === null ? 'active' : ''}`}
                onClick={() => onSelectTopic(null)}
              >
                All
              </button>
              {topics.map((t) => (
                <button
                  key={t.topic_id}
                  type="button"
                  data-topic-id={t.topic_id}
                  data-testid={`topic-pill-${t.topic_id}`}
                  className={`chip-btn xs ${selectedTopicId === t.topic_id ? 'active' : ''}`}
                  onClick={() => onSelectTopic(t.topic_id)}
                >
                  {t.icon_emoji || '💬'} {t.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Dialog List / Search Results */}
        <div className="dialog-list" role="listbox" aria-label={tr(locale, 'nav.chats')}>
          {noSearchHits ? (
            <div className="empty-search-box" data-testid="search-empty-state">
              <div className="empty-icon">🔍</div>
              <div>{tr(locale, 'sidebar.noResults')}</div>
            </div>
          ) : (
            <>
              {visibleDialogs.map((dlg) => (
                <button
                  key={dlg.chat_id}
                  type="button"
                  role="option"
                  aria-selected={selectedChatId === dlg.chat_id}
                  className={`dialog-row ${selectedChatId === dlg.chat_id ? 'selected' : ''}`}
                  data-chat-id={dlg.chat_id}
                  data-dialog-id={dlg.chat_id}
                  onClick={() => onSelectDialog(dlg)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({ dlg, x: e.clientX, y: e.clientY });
                  }}
                >
                  <div className={`dialog-avatar ${dlg.is_bot ? 'bot' : ''}`}>
                    {dlg.chat_id === LOCAL_COPILOT_CHAT_ID
                      ? '🤖'
                      : dlg.title.slice(0, 2).toUpperCase()}
                  </div>
                  {!collapsed && (
                    <div className="dialog-body">
                      <div className="dialog-title-row">
                        <span className="dialog-title">
                          {dlg.is_pinned ? '📌 ' : ''}
                          {dlg.is_forum ? '🏛️ ' : ''}
                          {dlg.title}
                          {dlg.is_muted ? ' 🔕' : ''}
                        </span>
                        {dlg.unread_count > 0 && (
                          <span className="unread-badge" data-testid="dialog-unread-badge">
                            {dlg.unread_count}
                          </span>
                        )}
                      </div>
                      <div className="dialog-preview">
                        {dlg.last_message_preview ||
                          (dlg.peer_username ? `@${dlg.peer_username}` : dlg.chat_type)}
                      </div>
                    </div>
                  )}
                </button>
              ))}

              {/* Remote Unified Search Message Hits */}
              {isSearching && remoteMessageHits.length > 0 && (
                <div className="search-section-group" data-testid="search-messages-section">
                  <div className="search-section-label">Messages ({remoteMessageHits.length})</div>
                  {remoteMessageHits.map((hit, idx) => {
                    const cid = Number(hit.chat_id ?? hit.chat?.chat_id ?? 0);
                    return (
                      <button
                        key={`hit-${cid}-${hit.message_id ?? idx}`}
                        type="button"
                        className="dialog-row search-hit"
                        data-testid="search-message-hit"
                        data-chat-id={cid}
                        onClick={() => {
                          if (cid > 0) {
                            const existing = dialogs.find((d) => d.chat_id === cid);
                            onSelectDialog(
                              existing ?? {
                                chat_id: cid,
                                chat_type: 'group',
                                title: String(hit.chat_title ?? `Chat #${cid}`),
                                unread_count: 0,
                                pts: 0,
                                updated_at_ms: Date.now(),
                              },
                            );
                          }
                        }}
                      >
                        <div className="dialog-avatar">💬</div>
                        <div className="dialog-body">
                          <div className="dialog-title">
                            {String(hit.chat_title ?? hit.sender_username ?? `Chat #${cid}`)}
                          </div>
                          <div className="dialog-preview">{String(hit.text ?? '')}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

          {/* Drag Resizer Handle strictly clamped to [240, 360] px */}
          {!collapsed && (
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat sidebar"
              data-testid="sidebar-resizer"
              onMouseDown={startResize}
            />
          )}
        </>
      )}

      {/* Right-Click Dialog Context Menu */}
      {ctxMenu && (
        <div
          className="floating-popover context-menu"
          role="menu"
          data-testid="dialog-context-menu"
          style={{
            position: 'fixed',
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 240),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item-btn"
            data-testid={ctxMenu.dlg.is_pinned ? 'unpin-chat' : 'pin'}
            onClick={() => void handleDialogAction('pin', ctxMenu.dlg)}
          >
            📌 {ctxMenu.dlg.is_pinned ? tr(locale, 'ctx.unpin') : tr(locale, 'ctx.pin')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item-btn"
            data-testid={ctxMenu.dlg.is_muted ? 'unmute-chat' : 'mute'}
            onClick={() => void handleDialogAction('mute', ctxMenu.dlg)}
          >
            🔕 {ctxMenu.dlg.is_muted ? tr(locale, 'ctx.unmute') : tr(locale, 'ctx.mute')}
          </button>
          {ctxMenu.dlg.unread_count > 0 ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="mark-read"
              onClick={() => void handleDialogAction('read', ctxMenu.dlg)}
            >
              ✓✓ {tr(locale, 'ctx.markRead')}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid="mark-unread"
              onClick={() => void handleDialogAction('unread', ctxMenu.dlg)}
            >
              ● {tr(locale, 'ctx.markUnread')}
            </button>
          )}
          {ctxMenu.dlg.chat_id > 0 && (
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn"
              data-testid={ctxMenu.dlg.is_archived ? 'unarchive' : 'archive'}
              onClick={() => void handleDialogAction('archive', ctxMenu.dlg)}
            >
              📦 {ctxMenu.dlg.is_archived ? tr(locale, 'ctx.unarchive') : tr(locale, 'ctx.archive')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="menu-item-btn"
            data-testid="clear-history"
            onClick={() => void handleDialogAction('clear', ctxMenu.dlg)}
          >
            🧹 {tr(locale, 'ctx.clearHistory')}
          </button>
          {ctxMenu.dlg.chat_id > 0 && (
            <button
              type="button"
              role="menuitem"
              className="menu-item-btn danger-text"
              data-testid="delete-chat"
              onClick={() => void handleDialogAction('delete', ctxMenu.dlg)}
            >
              🗑️ {tr(locale, 'ctx.deleteChat')}
            </button>
          )}
        </div>
      )}

      {/* Delete / Leave Confirmation Modal (Cancel preserves chat per T2-F12-05) */}
      {pendingDeleteDlg && (
        <div className="modal-backdrop" onClick={() => setPendingDeleteDlg(null)}>
          <div
            className="modal-card sm"
            role="dialog"
            aria-modal="true"
            data-testid="confirm-delete-chat-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{tr(locale, 'ctx.confirmDeleteTitle')}</h3>
            <p className="muted-sm">
              <strong>{pendingDeleteDlg.title}</strong> — {tr(locale, 'ctx.confirmDeleteBody')}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                data-testid="cancel-delete-chat-btn"
                onClick={() => setPendingDeleteDlg(null)}
              >
                {tr(locale, 'ctx.cancel')}
              </button>
              <button
                type="button"
                className="btn danger"
                data-testid="confirm-delete-chat-btn"
                onClick={() => void confirmDeleteDialog()}
              >
                {tr(locale, 'ctx.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Creation Modals (Group, Channel, Forum, Fabushi Bot, BotFather NL, Contact, Folder, Story, Topic) */}
      {createModal && (
        <div className="modal-backdrop" onClick={() => setCreateModal(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            data-testid={`create-modal-${createModal}`}
            onClick={(e) => e.stopPropagation()}
          >
            {(createModal === 'group' || createModal === 'channel' || createModal === 'forum') && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateGroupOrChannel(e)}>
                <h3>
                  {createModal === 'channel'
                    ? tr(locale, 'sidebar.createChannel')
                    : createModal === 'forum'
                      ? tr(locale, 'sidebar.createForum')
                      : tr(locale, 'sidebar.createGroup')}
                </h3>
                {modalError && (
                  <div className="error-banner" role="alert" data-testid="create-modal-error">
                    {modalError}
                  </div>
                )}
                <label className="field-stack">
                  <span className="field-label">Title</span>
                  <input
                    className="input"
                    autoFocus
                    data-testid="create-chat-title-input"
                    value={newChatTitle}
                    onChange={(e) => setNewChatTitle(e.target.value)}
                    placeholder="Engineering Core"
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Description (optional)</span>
                  <input
                    className="input"
                    data-testid="create-chat-about-input"
                    value={newChatAbout}
                    onChange={(e) => setNewChatAbout(e.target.value)}
                    placeholder="Purpose of this space…"
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="create-chat-submit-btn"
                    disabled={modalBusy}
                  >
                    Create
                  </button>
                </div>
              </form>
            )}

            {createModal === 'fabushi' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateFabushiBot(e)}>
                <h3>🤖 {tr(locale, 'sidebar.createBot')}</h3>
                {modalError && (
                  <div className="error-banner" role="alert" data-testid="create-modal-error">
                    {modalError}
                  </div>
                )}
                <label className="field-stack">
                  <span className="field-label">Bot Display Name</span>
                  <input
                    className="input"
                    autoFocus
                    data-testid="fabushi-bot-name-input"
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="Research Companion"
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Bot Username (@handle)</span>
                  <input
                    className="input"
                    data-testid="fabushi-bot-username-input"
                    value={botUsername}
                    onChange={(e) => setBotUsername(e.target.value)}
                    placeholder="research_companion_bot"
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Persona & System Instructions</span>
                  <textarea
                    className="input"
                    rows={3}
                    data-testid="fabushi-bot-persona-input"
                    value={botPersona}
                    onChange={(e) => setBotPersona(e.target.value)}
                    placeholder="Helpful browser & coding specialist…"
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="fabushi-bot-submit-btn"
                    disabled={modalBusy}
                  >
                    Create Bot
                  </button>
                </div>
              </form>
            )}

            {createModal === 'botfather' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateBotFatherNl(e)}>
                <h3>✨ {tr(locale, 'sidebar.createBotFather')}</h3>
                {modalError && (
                  <div className="error-banner" role="alert">
                    {modalError}
                  </div>
                )}
                <label className="field-stack">
                  <span className="field-label">Describe your Bot & Mini App in natural language</span>
                  <textarea
                    className="input"
                    rows={4}
                    autoFocus
                    data-testid="botfather-nl-input"
                    value={botFatherPrompt}
                    onChange={(e) => setBotFatherPrompt(e.target.value)}
                    placeholder="Create a daily standup tracker bot with an interactive Kanban mini app…"
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="botfather-nl-submit-btn"
                    disabled={modalBusy}
                  >
                    Generate via @BotFather
                  </button>
                </div>
              </form>
            )}

            {createModal === 'contact' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleAddContactOrDm(e)}>
                <h3>👤 {tr(locale, 'sidebar.addContact')}</h3>
                {modalError && (
                  <div className="error-banner" role="alert">
                    {modalError}
                  </div>
                )}
                <label className="field-stack">
                  <span className="field-label">Username or User ID</span>
                  <input
                    className="input"
                    autoFocus
                    data-testid="contact-target-input"
                    value={contactTarget}
                    onChange={(e) => setContactTarget(e.target.value)}
                    placeholder="@bob"
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="contact-submit-btn"
                    disabled={modalBusy}
                  >
                    Open Direct Chat
                  </button>
                </div>
              </form>
            )}

            {createModal === 'folder' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateFolder(e)}>
                <h3>📁 {tr(locale, 'sidebar.newFolder')}</h3>
                {modalError && (
                  <div className="error-banner" role="alert">
                    {modalError}
                  </div>
                )}
                <label className="field-stack">
                  <span className="field-label">Folder Name</span>
                  <input
                    className="input"
                    autoFocus
                    data-testid="folder-title-input"
                    value={folderTitle}
                    onChange={(e) => setFolderTitle(e.target.value)}
                    placeholder={tr(locale, 'sidebar.folderNamePlaceholder')}
                  />
                </label>
                <div className="folder-chat-checklist">
                  {allMergedDialogs.map((d) => (
                    <label key={d.chat_id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={folderSelectedChats.includes(d.chat_id)}
                        onChange={(e) =>
                          setFolderSelectedChats((prev) =>
                            e.target.checked
                              ? [...prev, d.chat_id]
                              : prev.filter((id) => id !== d.chat_id),
                          )
                        }
                      />
                      <span>{d.title}</span>
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    data-testid="folder-submit-btn"
                    disabled={modalBusy}
                  >
                    Save Folder
                  </button>
                </div>
              </form>
            )}

            {createModal === 'story' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateStory(e)}>
                <h3>✨ Post Story</h3>
                <input
                  className="input"
                  autoFocus
                  data-testid="story-caption-input"
                  value={storyCaption}
                  onChange={(e) => setStoryCaption(e.target.value)}
                  placeholder="Share an update…"
                />
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button type="submit" className="btn primary" data-testid="story-submit-btn">
                    Publish
                  </button>
                </div>
              </form>
            )}

            {createModal === 'topic' && (
              <form className="auth-form-stack" onSubmit={(e) => void handleCreateTopic(e)}>
                <h3>🏛️ {tr(locale, 'sidebar.newTopic')}</h3>
                <input
                  className="input"
                  autoFocus
                  data-testid="topic-title-input"
                  value={topicTitle}
                  onChange={(e) => setTopicTitle(e.target.value)}
                  placeholder="Announcements"
                />
                <div className="modal-actions">
                  <button type="button" className="btn" onClick={() => setCreateModal(null)}>
                    {tr(locale, 'ctx.cancel')}
                  </button>
                  <button type="submit" className="btn primary" data-testid="topic-submit-btn">
                    Create Topic
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Active Story Viewer Modal */}
      {activeStoryModal && (
        <div className="modal-backdrop" onClick={() => setActiveStoryModal(null)}>
          <div
            className="modal-card sm"
            data-testid="story-viewer-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>✨ {String(activeStoryModal.username ?? 'Story')}</h3>
            <p>{String(activeStoryModal.caption ?? activeStoryModal.text ?? '')}</p>
            <button type="button" className="btn primary" onClick={() => setActiveStoryModal(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
