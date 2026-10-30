/**
 * ============================================================
 * 设计系统（iOS 风格 · Liquid Glass）
 * ============================================================
 * 设计语言参考 iOS 26/27：
 *   1. 分层材料 —— 背景 / 卡片 / 浮层三档明度，靠层次而非边框分隔
 *   2. 大圆角 —— 卡片 26px、按钮 14px、头像胶囊 999px
 *   3. 克制的边框 —— 用极低对比的 hairline，不用高饱和描边
 *   4. 强调色克制 —— 只有可点元素用 accent，其余全用灰阶
 *   5. 紧凑的字号阶梯 —— 11 / 12 / 13 / 15 / 17 / 20 / 22 / 28 / 34
 *
 * ------------------------------------------------------------
 * 明暗双主题
 * ------------------------------------------------------------
 * `colors` 是「响应式只读对象」：
 *   每个属性用 getter 读取当前调色板，
 *   切换主题后只要组件重新渲染就拿得到新值。
 *
 * 触发重渲染的方式见 App.tsx：
 *   根节点 <view key={mode}> 强制整棵子树重建，
 *   这样连模块级缓存的样式也会重新求值。
 *
 * 为什么不用 Proxy：
 *   Lynx 的 JS 引擎对 Proxy 支持不确定，用 Object.defineProperty
 *   显式定义 getter 更稳妥（也便于类型推导）。
 *
 * ------------------------------------------------------------
 * Lynx 布局铁律（保留历史教训，勿删）
 * ------------------------------------------------------------
 * 1. 所有长度必须带单位字符串：'16px' / '100vh' / '50%'
 *    数字形式（fontSize: 15）会报 `CSS length need units` 并中断渲染。
 * 2. flex:1 在本项目集成下极不可靠：
 *    - row 容器内 flex:1 子项宽度会算成 0（文字竖排、input 不可见）
 *    - 页面内容区 flex:1 拿不到剩余高度（子卡片被压扁重叠）
 *    宽度一律用百分比，高度用绝对定位。
 * 3. 卡片/列表项要加 flexShrink:0，避免被压扁。
 * ============================================================
 */

import { createStore, useStore } from './store/base.js';
import * as storage from './storage.js';

/* ------------------------------------------------------------------ */
/* 调色板                                                              */
/* ------------------------------------------------------------------ */

/** 一套完整调色板的结构 */
export interface Palette {
  /** 页面底色（最底层） */
  bg: string;
  /** 分组背景（列表页/设置的底） */
  bgGrouped: string;
  /** 顶栏 / 底栏材料 */
  surface: string;
  /** 次级表面（输入框、他人气泡） */
  surfaceAlt: string;
  /** 卡片材料 */
  card: string;
  /** 浮层 / 高亮卡片（选中态、抬升层） */
  cardElevated: string;
  /** 卡片边框（hairline） */
  cardBorder: string;
  /** 主强调色 */
  primary: string;
  /** 强调色按下态 */
  primaryDeep: string;
  /** 强调色浅底（选中背景、头像底） */
  primarySoft: string;
  /** 强调色上的文字 */
  onPrimary: string;
  /** 成功 */
  success: string;
  /** 成功浅底 */
  successSoft: string;
  /** 危险 */
  danger: string;
  /** 危险浅底 */
  dangerSoft: string;
  /** 警告 */
  warning: string;
  /** 主文本 */
  text: string;
  /** 次文本 */
  textMuted: string;
  /** 三级文本 / 占位符 */
  textFaint: string;
  /** 分割线 */
  border: string;
  /** 头像底 */
  avatarBg: string;
  /** 头像文字 */
  avatarText: string;
  /** 纯白（用于彩色底上的文字，两套主题都相同） */
  white: string;
  /** 遮罩（弹层背景） */
  overlay: string;
}

/**
 * 深色（默认）
 * 参考 iOS Dark：纯黑打底 + #1C1C1E 卡片 + #0A84FF 强调
 */
const dark: Palette = {
  bg: '#000000',
  bgGrouped: '#000000',
  surface: '#1C1C1E',
  surfaceAlt: '#2C2C2E',
  card: '#1C1C1E',
  cardElevated: '#2C2C2E',
  cardBorder: '#2E2E31',
  primary: '#0A84FF',
  primaryDeep: '#0066CC',
  primarySoft: '#0A2540',
  onPrimary: '#FFFFFF',
  success: '#30D158',
  successSoft: '#0E2A17',
  danger: '#FF453A',
  dangerSoft: '#2E1311',
  warning: '#FF9F0A',
  text: '#FFFFFF',
  textMuted: '#A1A1A6',
  textFaint: '#636366',
  border: '#2C2C2E',
  avatarBg: '#2C2C2E',
  avatarText: '#0A84FF',
  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.6)',
};

/**
 * 浅色
 * 参考 iOS Light：F2F2F7 分组底 + 纯白卡片 + 007AFF 强调
 */
const light: Palette = {
  bg: '#FFFFFF',
  bgGrouped: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceAlt: '#F2F2F7',
  card: '#FFFFFF',
  cardElevated: '#F2F2F7',
  cardBorder: '#E5E5EA',
  primary: '#007AFF',
  primaryDeep: '#0062CC',
  primarySoft: '#E8F1FF',
  onPrimary: '#FFFFFF',
  success: '#34C759',
  successSoft: '#E9F9EE',
  danger: '#FF3B30',
  dangerSoft: '#FFECEB',
  warning: '#FF9500',
  text: '#000000',
  textMuted: '#8A8A8E',
  textFaint: '#AEAEB2',
  border: '#E5E5EA',
  avatarBg: '#F2F2F7',
  avatarText: '#007AFF',
  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.35)',
};

/* ------------------------------------------------------------------ */
/* 主题模式状态                                                         */
/* ------------------------------------------------------------------ */

/** 用户可选的主题：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 实际生效的配色（system 会解析成 light 或 dark） */
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

const STORAGE_KEY = 'chat.theme-mode';

/**
 * 读取系统配色偏好
 * ------------------------------------------------------------
 * Lynx 各端暴露方式不同，这里做多路探测，全部失败则回落 dark
 * （聊天类应用深色更常见，且 OLED 省电）。
 */
function detectSystemTheme(): ResolvedTheme {
  try {
    const g = globalThis as unknown as {
      lynx?: {
        __globalProps?: { theme?: string; preferredColorScheme?: string };
      };
    };
    const props = g.lynx?.__globalProps;
    const t = (props?.theme ?? props?.preferredColorScheme ?? '').toLowerCase();
    if (t === 'light') return 'light';
    if (t === 'dark') return 'dark';
  } catch {
    // 忽略：探测失败走默认
  }
  return 'dark';
}

/** 把用户选择解析成实际配色 */
function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return detectSystemTheme();
  return mode;
}

/** 从存储里读初始模式 */
function initialMode(): ThemeMode {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'system';
}

const initialModeValue = initialMode();

const themeStore = createStore<ThemeState>({
  mode: initialModeValue,
  resolved: resolve(initialModeValue),
});

/** 当前生效的调色板（模块内用，切主题后更新） */
let currentPalette: Palette = themeStore.get().resolved === 'light' ? light : dark;

/* ------------------------------------------------------------------ */
/* 响应式 colors                                                        */
/* ------------------------------------------------------------------ */

/**
 * 响应式颜色表
 * ------------------------------------------------------------
 * 每个属性都是 getter，读取「当前调色板」的最新值。
 * 组件只要重新渲染就能拿到新颜色，不需要把 colors 传进 props。
 */
export const colors: Palette = (() => {
  const target = {} as Palette;
  const keys: Array<keyof Palette> = [
    'bg',
    'bgGrouped',
    'surface',
    'surfaceAlt',
    'card',
    'cardElevated',
    'cardBorder',
    'primary',
    'primaryDeep',
    'primarySoft',
    'onPrimary',
    'success',
    'successSoft',
    'danger',
    'dangerSoft',
    'warning',
    'text',
    'textMuted',
    'textFaint',
    'border',
    'avatarBg',
    'avatarText',
    'white',
    'overlay',
  ];

  for (const k of keys) {
    Object.defineProperty(target, k, {
      get: () => currentPalette[k],
      enumerable: true,
    });
  }
  return target;
})();

/* ------------------------------------------------------------------ */
/* 主题操作与订阅                                                       */
/* ------------------------------------------------------------------ */

/** 组件中订阅主题状态 */
export function useTheme(): ThemeState {
  return useStore(themeStore);
}

/** 切换主题并落盘 */
export function setThemeMode(mode: ThemeMode): void {
  const resolved = resolve(mode);
  currentPalette = resolved === 'light' ? light : dark;
  storage.setItem(STORAGE_KEY, mode);
  themeStore.set({ mode, resolved });
}

/** 在 light / dark 之间快速切换（system 视为 dark 的对立面） */
export function toggleTheme(): void {
  setThemeMode(themeStore.get().resolved === 'light' ? 'dark' : 'light');
}

/** 是否浅色（非组件代码用） */
export function isLightTheme(): boolean {
  return themeStore.get().resolved === 'light';
}

/** 取当前调色板快照（需要把颜色传出去的场景用） */
export function palette(): Palette {
  return currentPalette;
}

/* ------------------------------------------------------------------ */
/* 间距 / 圆角 / 尺寸 / 字号                                            */
/* ------------------------------------------------------------------ */

/**
 * 间距
 * ⚠ 必须带单位：Lynx 对 padding / margin 同样强制要求。
 *   写数字会报 `CSS length need units` 并中断整个渲染。
 */
export const spacing = {
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
} as const;

/**
 * 圆角
 * iOS 用「连续曲率圆角」，视觉上比普通圆角更饱满，
 * 这里取对应视觉半径。
 */
export const radius = {
  /** 小标签、勾选框 */
  xs: '6px',
  /** 输入框、小按钮 */
  sm: '10px',
  /** 常规按钮 */
  md: '14px',
  /** 卡片 */
  lg: '18px',
  /** 大卡片 / 弹层 */
  xl: '26px',
  /** 气泡 */
  bubble: '20px',
  /** 胶囊 */
  full: '999px',
} as const;

/** 固定尺寸：避免魔法数字散落各处 */
export const size = {
  /** 顶栏高度（页面绝对定位会引用这个值） */
  header: '56px',
  /** 底部导航高度 */
  tabbar: '56px',
  /** 主按钮 */
  button: '50px',
  /** 输入框 */
  input: '50px',
  /** 小按钮 */
  buttonSm: '38px',
  avatar: '44px',
  avatarLg: '72px',
  avatarXl: '88px',
  /** 列表行高 */
  row: '52px',
} as const;

/** 字号阶梯（iOS Type Scale） */
export const fontSize = {
  /** caption2 */
  xs: '11px',
  /** caption1 */
  sm: '13px',
  /** footnote */
  md: '15px',
  /** body */
  lg: '17px',
  /** title3 */
  xl: '20px',
  /** title2 */
  xxl: '22px',
  /** title1 */
  xxxl: '28px',
  /** largeTitle */
  hero: '34px',
} as const;

/* ------------------------------------------------------------------ */
/* 常用组合样式                                                         */
/* ------------------------------------------------------------------ */

/**
 * 常用样式
 * ------------------------------------------------------------
 * 同样用 getter 包装：每次访问都基于当前调色板生成新对象，
 * 所以切主题后无需各处手动刷新。
 *
 * 全站页面结构：
 *   <page>
 *     <view height:100vh column>
 *       <view height:56px>            顶部栏
 *       <view absolute top/bottom>    内容区（不用 flex:1）
 *       <view absolute bottom>        底部导航
 *     </view>
 *   </page>
 */
type CommonStyles = {
  page: Record<string, unknown>;
  header: Record<string, unknown>;
  headerSide: Record<string, unknown>;
  headerCenter: Record<string, unknown>;
  headerTitle: Record<string, unknown>;
  body: Record<string, unknown>;
  scroll: Record<string, unknown>;
  list: Record<string, unknown>;
  listItemContent: Record<string, unknown>;
  footer: Record<string, unknown>;
  buttonPrimary: Record<string, unknown>;
  buttonPrimaryText: Record<string, unknown>;
  buttonGhost: Record<string, unknown>;
  buttonGhostText: Record<string, unknown>;
  buttonDanger: Record<string, unknown>;
  buttonDangerText: Record<string, unknown>;
  input: Record<string, unknown>;
  card: Record<string, unknown>;
  center: Record<string, unknown>;
  label: Record<string, unknown>;
  errorText: Record<string, unknown>;
  hintText: Record<string, unknown>;
  divider: Record<string, unknown>;
};

function buildCommonStyles(): CommonStyles {
  const c = currentPalette;

  return {
    /** 页面根：占满整屏，不依赖父级解析 */
    page: {
      height: '100vh',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: c.bg,
    },

    /** 顶部栏：材料底 + 极淡 hairline */
    header: {
      width: '100%',
      height: size.header,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: spacing.lg,
      paddingRight: spacing.lg,
      backgroundColor: c.surface,
      borderBottomWidth: '1px',
      borderBottomColor: c.cardBorder,
    },

    headerSide: {
      zIndex: 1,
      width: '64px',
      height: '100%',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
    },

    headerCenter: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },

    headerTitle: {
      flexShrink: 0,
      color: c.text,
      fontSize: fontSize.lg,
      fontWeight: '600',
      textAlign: 'center',
    },

    /** 主体区：配合绝对定位使用 */
    body: {
      flex: 1,
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
    },

    scroll: {
      flex: 1,
      width: '100%',
    },

    /** 列表容器（本项目不用 list 组件，这是普通 view 的样式名） */
    list: {
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
    },

    listItemContent: {
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      paddingLeft: spacing.lg,
      paddingRight: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
    },

    footer: {
      width: '100%',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: c.surface,
      borderTopWidth: '1px',
      borderTopColor: c.cardBorder,
    },

    /** 主按钮：胶囊形强调色 */
    buttonPrimary: {
      width: '100%',
      height: size.button,
      flexShrink: 0,
      borderRadius: radius.md,
      backgroundColor: c.primary,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },

    buttonPrimaryText: {
      color: c.onPrimary,
      fontSize: fontSize.lg,
      fontWeight: '600',
    },

    /** 次级按钮：填充底，无描边（iOS 风格） */
    buttonGhost: {
      width: '100%',
      height: size.button,
      flexShrink: 0,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },

    buttonGhostText: {
      color: c.text,
      fontSize: fontSize.lg,
    },

    buttonDanger: {
      width: '100%',
      height: size.button,
      flexShrink: 0,
      borderRadius: radius.md,
      backgroundColor: c.dangerSoft,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },

    buttonDangerText: {
      color: c.danger,
      fontSize: fontSize.lg,
      fontWeight: '600',
    },

    /** 输入框：填充底 + 无边框 */
    input: {
      width: '100%',
      height: size.input,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
      paddingLeft: spacing.lg,
      paddingRight: spacing.lg,
      color: c.text,
      fontSize: fontSize.md,
    },

    /** 卡片：材料底 + hairline */
    card: {
      width: '100%',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: c.card,
      borderWidth: '1px',
      borderColor: c.cardBorder,
      borderRadius: radius.xl,
      padding: spacing.lg,
    },

    center: {
      flex: 1,
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    },

    label: {
      color: c.textMuted,
      fontSize: fontSize.sm,
      marginBottom: spacing.sm,
    },

    errorText: {
      color: c.danger,
      fontSize: fontSize.sm,
      textAlign: 'center',
    },

    hintText: {
      color: c.textFaint,
      fontSize: fontSize.xs,
      lineHeight: '18px',
    },

    divider: {
      width: '100%',
      height: '1px',
      backgroundColor: c.cardBorder,
    },
  };
}

/** 响应式 commonStyles（每次访问重新生成） */
export const commonStyles: CommonStyles = (() => {
  const target = {} as CommonStyles;
  const keys: Array<keyof CommonStyles> = [
    'page',
    'header',
    'headerSide',
    'headerCenter',
    'headerTitle',
    'body',
    'scroll',
    'list',
    'listItemContent',
    'footer',
    'buttonPrimary',
    'buttonPrimaryText',
    'buttonGhost',
    'buttonGhostText',
    'buttonDanger',
    'buttonDangerText',
    'input',
    'card',
    'center',
    'label',
    'errorText',
    'hintText',
    'divider',
  ];

  for (const k of keys) {
    Object.defineProperty(target, k, {
      get: () => buildCommonStyles()[k],
      enumerable: true,
    });
  }
  return target;
})();
