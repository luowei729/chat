/**
 * ============================================================
 * 高级深色主题（v2）
 * ------------------------------------------------------------
 * 设计语言：深海蓝 + 电光蓝点缀，大圆角 + 强对比，
 * 目标是「第一眼就贵」。
 *
 * Lynx 布局铁律（排查黑屏/塌陷总结）：
 * 1. 伸缩一律用 flex:1 简写，不要拆 flexGrow/flexBasis
 *    （Yoga 对简写支持最稳，拆开在 text 上容易塌陷）；
 * 2. text 不要直接加 flex，用外层 view 包一层再 flex；
 * 3. 不要用 gap（老版本 Lynx 不支持），用 margin 代替；
 * 4. scroll-view 必须加 scroll-orientation + flex:1，
 *    否则高度为 0 整页空白；
 * 5. input 只有 default-value（非受控），靠 bindinput 同步 state。
 * ============================================================
 */

/** 颜色：深海高级感 */
export const colors = {
  /** 页面背景：近黑深蓝 */
  bg: '#070B14',
  /** 顶栏/底栏背景 */
  surface: '#0D1424',
  /** 输入框/气泡（他人） */
  surfaceAlt: '#141D33',
  /** 卡片 */
  card: '#111A2E',
  /** 卡片边框 */
  cardBorder: '#21304F',
  /** 主色：电光蓝 */
  primary: '#4C7DFF',
  /** 主色深（按钮按压/渐变底） */
  primaryDeep: '#2B5CE6',
  /** 主色浅底（选中态/头像底） */
  primarySoft: '#16264D',
  /** 成功 */
  success: '#34D399',
  /** 危险 */
  danger: '#FF5C5C',
  /** 警告（邀请码提示） */
  warning: '#FFB020',
  /** 主文本 */
  text: '#EDF1F7',
  /** 次文本 */
  textMuted: '#9AA5BB',
  /** 更弱文本 */
  textFaint: '#5F6B84',
  /** 分割线 */
  border: '#1B2540',
  /** 头像底 */
  avatarBg: '#1B2A4D',
} as const;

/** 间距 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** 圆角 */
export const radius = {
  sm: 6,
  md: 12,
  lg: 18,
  xl: 24,
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
  xxl: 32,
  hero: 44,
} as const;

/** 常用组合样式 */
export const commonStyles = {
  /**
   * 页面容器
   *
   * 用 flex:1 而不是 height:'100%'：
   * 所有页面都是根容器的直接子元素（根容器 flex column + 100vh），
   * flex:1 能稳定撑满；而 height:'100%' 在父级高度未定
   * 或处于 scroll 容器内时会塌成 0，表现为整页空白。
   */
  page: {
    width: '100%',
    flex: 1,
    backgroundColor: colors.bg,
    display: 'flex',
    flexDirection: 'column',
  },
  /** 顶部导航栏：左右固定宽，中间用 view 包裹居中 */
  header: {
    height: 56,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /** 导航栏左右按钮区（固定宽，保证标题真正居中） */
  headerSide: {
    width: 64,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },
  /** 导航栏中间标题区（用 view 包 text，避免 text 直接 flex 塌陷） */
  headerCenter: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 导航栏标题文字 */
  headerTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  /** 可滚动区域：必须配合 scroll-orientation="vertical" 使用 */
  scroll: {
    flex: 1,
    width: '100%',
  },
  /** 主按钮 */
  buttonPrimary: {
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimaryText: {
    color: '#ffffff',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  /** 次要按钮 */
  buttonGhost: {
    height: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGhostText: {
    color: colors.textMuted,
    fontSize: fontSize.md,
  },
  /** 输入框 */
  input: {
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    color: colors.text,
    fontSize: fontSize.md,
  },
  /** 卡片 */
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.lg,
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
