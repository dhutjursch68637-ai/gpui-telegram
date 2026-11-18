import {
  clampBubbleRadiusPx,
  clampFontSizePx,
  normalizeExtensionLocale,
  normalizeThemePreset,
  type DesktopThemePreset,
  type ExtensionLocale,
} from '../../shared/rpc_types';

export interface ThemePaletteTokens {
  id: DesktopThemePreset;
  labelEn: string;
  labelZh: string;
  isDark: boolean;
  appBg: string;
  railBg: string;
  dialogsBg: string;
  stageBg: string;
  inspectorBg: string;
  surface: string;
  surfaceElevated: string;
  surfaceHover: string;
  msgInBg: string;
  msgOutBg: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  borderSubtle: string;
  defaultAccent: string;
}

export const THEME_CYCLE_ORDER: readonly DesktopThemePreset[] = [
  'night',
  'tinted',
  'day',
  'classic',
] as const;

export const ACCENT_SWATCHES: readonly string[] = [
  '#40A7E3',
  '#2481CC',
  '#10B981',
  '#8B5CF6',
  '#F59E0B',
  '#EC4899',
  '#EF4444',
  '#14B8A6',
] as const;

export const DESKTOP_THEME_PALETTES: Record<DesktopThemePreset, ThemePaletteTokens> = {
  night: {
    id: 'night',
    labelEn: 'Night',
    labelZh: '夜间黑',
    isDark: true,
    appBg: '#0B0B0B',
    railBg: '#09090B',
    dialogsBg: '#111111',
    stageBg: '#070707',
    inspectorBg: '#111111',
    surface: '#151517',
    surfaceElevated: '#1C1C1F',
    surfaceHover: '#232327',
    msgInBg: '#1A1A1A',
    msgOutBg: '#2C2C2C',
    textPrimary: '#FAFAFA',
    textSecondary: '#A1A1AA',
    textMuted: '#71717A',
    borderSubtle: '#232326',
    defaultAccent: '#40A7E3',
  },
  tinted: {
    id: 'tinted',
    labelEn: 'Tinted',
    labelZh: '深邃蓝',
    isDark: true,
    appBg: '#101215',
    railBg: '#0C0E11',
    dialogsBg: '#15181C',
    stageBg: '#0E1013',
    inspectorBg: '#15181C',
    surface: '#181C22',
    surfaceElevated: '#1F252E',
    surfaceHover: '#262E3A',
    msgInBg: '#1A1E24',
    msgOutBg: '#273240',
    textPrimary: '#F2F5F8',
    textSecondary: '#98A6B8',
    textMuted: '#6C7B8E',
    borderSubtle: '#242C37',
    defaultAccent: '#55B3F3',
  },
  day: {
    id: 'day',
    labelEn: 'Day',
    labelZh: '日间白',
    isDark: false,
    appBg: '#FCFCFC',
    railBg: '#F3F4F6',
    dialogsBg: '#F7F7F7',
    stageBg: '#F0F2F5',
    inspectorBg: '#F8F9FA',
    surface: '#FFFFFF',
    surfaceElevated: '#F3F4F6',
    surfaceHover: '#EAECEF',
    msgInBg: '#FFFFFF',
    msgOutBg: '#E7EDF5',
    textPrimary: '#141414',
    textSecondary: '#52525B',
    textMuted: '#71717A',
    borderSubtle: '#E4E4E7',
    defaultAccent: '#2481CC',
  },
  classic: {
    id: 'classic',
    labelEn: 'Classic',
    labelZh: '经典绿',
    isDark: false,
    appBg: '#FFFFFF',
    railBg: '#F1F5F9',
    dialogsBg: '#FFFFFF',
    stageBg: '#D5E8C8',
    inspectorBg: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceElevated: '#F4F7FA',
    surfaceHover: '#EBF1F6',
    msgInBg: '#FFFFFF',
    msgOutBg: '#EFFDDE',
    textPrimary: '#111827',
    textSecondary: '#4B5563',
    textMuted: '#6B7280',
    borderSubtle: '#DCE3EA',
    defaultAccent: '#40A7E3',
  },
};

export function getNextThemePreset(current: unknown): DesktopThemePreset {
  const norm = normalizeThemePreset(current);
  const idx = THEME_CYCLE_ORDER.indexOf(norm);
  return THEME_CYCLE_ORDER[(idx + 1) % THEME_CYCLE_ORDER.length]!;
}

export function sanitizeHexColor(raw: unknown, fallback = '#40A7E3'): string {
  const s = String(raw ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return fallback;
}

export function applyAppearanceToDocument(opts: {
  themePreset?: unknown;
  themeMode?: unknown;
  fontSize?: unknown;
  bubbleRadius?: unknown;
  accentColor?: unknown;
  locale?: unknown;
}): {
  preset: DesktopThemePreset;
  fontSize: number;
  bubbleRadius: number;
  accentColor: string;
  locale: ExtensionLocale;
} {
  const preset = normalizeThemePreset(opts.themePreset, opts.themeMode);
  const palette = DESKTOP_THEME_PALETTES[preset];
  const fontSize = clampFontSizePx(opts.fontSize, 13);
  const bubbleRadius = clampBubbleRadiusPx(opts.bubbleRadius, 17);
  const accentColor = sanitizeHexColor(opts.accentColor, palette.defaultAccent);
  const locale = normalizeExtensionLocale(opts.locale);

  if (typeof document !== 'undefined') {
    const html = document.documentElement;
    html.lang = locale;
    html.classList.add('tdesktop-theme');
    html.setAttribute('data-theme', preset);
    html.setAttribute('data-color-scheme', palette.isDark ? 'dark' : 'light');

    const vars: Record<string, string> = {
      '--app-bg': palette.appBg,
      '--rail-bg': palette.railBg,
      '--dialogs-bg': palette.dialogsBg,
      '--stage-bg': palette.stageBg,
      '--inspector-bg': palette.inspectorBg,
      '--surface': palette.surface,
      '--surface-elevated': palette.surfaceElevated,
      '--surface-hover': palette.surfaceHover,
      '--msg-in-bg': palette.msgInBg,
      '--msg-out-bg': palette.msgOutBg,
      '--text-primary': palette.textPrimary,
      '--text-secondary': palette.textSecondary,
      '--text-muted': palette.textMuted,
      '--border-subtle': palette.borderSubtle,
      '--accent': accentColor,
      '--accent-soft': `${accentColor}24`,
      '--msg-font-size': `${fontSize}px`,
      '--font-size': `${fontSize}px`,
      '--bubble-radius': `${bubbleRadius}px`,
      '--msg-radius': `${bubbleRadius}px`,
    };
    for (const [k, v] of Object.entries(vars)) {
      html.style.setProperty(k, v);
      if (document.body) {
        document.body.style.setProperty(k, v);
      }
    }
    if (document.body) {
      document.body.classList.add('tdesktop-theme');
      document.body.setAttribute('data-theme', preset);
      document.body.style.backgroundColor = palette.appBg;
      document.body.style.color = palette.textPrimary;
    }
  }

  return { preset, fontSize, bubbleRadius, accentColor, locale };
}
