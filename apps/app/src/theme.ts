/**
 * ============================================================
 * 主题与样式常量
 * ------------------------------------------------------------
 * 为什么集中定义：
 * 1. Lynx 不支持 CSS 类名继承（无 DOM），样式必须内联或通过对象传；
 * 2. 颜色/间距集中管理，改主题只改一处；
 * 3. 深色为主：聊天 App 长时间使用，深色更护眼省电。
 * ============================================================
 */

/** 颜色 */
export const colors = {
  /** 页面背景 */
  bg: '#0b0d12',
  /** 卡片/气泡背景 */
  surface: '#151922',
  /** 次级背景（输入框、列表分隔） */
  surfaceAlt: '#1c2130',
  /** 主色（发送按钮、自己气泡） */
  primary: '#4f8cff',
  /** 主色浅（选中态） */
  primarySoft: '#1e2d4d',
  /** 危险色（挂断、删除） */
  danger: '#ff4d4f',
  /** 成功色（接听） */
  success: '#2ecc71',
  /** 主文本 */
  text: '#e8ecf4',
  /** 次文本 */
  textMuted: '#8b95a8',
  /** 更弱的文本（时间戳） */
  textFaint: '#5b6577',
  /** 边框 */
  border: '#242a38',
  /** 遮罩 */
  overlay: 'rgba(0,0,0,0.6)',
} as const;

/** 间距（4 的倍数，保证视觉节奏一致） */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 圆角 */
export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  /** 气泡用大圆角 */
  bubble: 18,
  full: 999,
} as const;

/** 字号 */
export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 28,
} as const;

/** 常用组合样式 */
export const commonStyles = {
  /** 页面容器：全屏 + 深色背景 */
  page: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.bg,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  /** 顶部导航栏 */
  header: {
    height: 52,
    display: 'flex',
    flexDirection: 'row' as const,
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /** 导航栏标题 */
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600' as const,
    textAlign: 'center' as const,
  },
  /** 可滚动区域 */
  scroll: {
    flex: 1,
    width: '100%',
  },
  /** 主按钮 */
  buttonPrimary: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 主按钮文字 */
  buttonPrimaryText: {
    color: '#ffffff',
    fontSize: fontSize.md,
    fontWeight: '600' as const,
  },
  /** 次要按钮（描边） */
  buttonGhost: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 次要按钮文字 */
  buttonGhostText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  },
  /** 输入框 */
  input: {
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
  },
  /** 卡片 */
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  /** 居中容器 */
  center: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
} as const;
