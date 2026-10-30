/**
 * ============================================================
 * 主题与基础样式
 * ============================================================
 * 设计语言：深海蓝底 + 电光蓝点缀，大圆角、强对比。
 *
 * ------------------------------------------------------------
 * Lynx 布局铁律（每一条都在 Android 模拟器上实测过）
 * ------------------------------------------------------------
 * 1. 根节点必须是 <page>，且 page 上不写任何样式；
 *    内容容器用 height:'100vh' + flex column。
 *    ⚠ 不要用 min-height —— 高度不确定会让整条 flex 链塔陷成 0，
 *      表现为「onFirstScreen 成功但整屏空白」。
 *
 * 2. 所有长度必须带单位字符串：'56px' / '100vh' / '50%'。
 *    数字形式（fontSize: 15 / height: 56）会报
 *    `CSS length need units (except 0)` 并中断渲染。
 *    例外：0 和 padding/margin 可写数字。
 *
 * 3. text 不要直接设 flex —— 会塔成 1 字符宽，中文变成竖排。
 *    需要弹性布局时用 view 包一层。
 *
 * 4. scroll-view 的父级必须有确定高度，否则内容不可见。
 *    推荐 scroll-view 自身 flex:1，父级也是 flex:1（高度链完整）。
 *
 * 5. 不要用 gap（旧版本不支持），用 margin 代替。
 *
 * 6. flex 用简写 `flex: 1`，不要拆成 flexGrow / flexBasis。
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
  /** 白色 */
  white: '#FFFFFF',
} as const;

/**
 * 间距
 * ⚠ 必须带单位：Lynx 对 padding / margin 同样强制要求（'16px'）。
 *   写数字 16 会报 `CSS length need units` 并中断整个渲染，
 *   表现为整页空白且 onFirstScreen 照常成功。
 */
export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
} as const;

/** 圆角（必须带单位） */
export const radius = {
  sm: '6px',
  md: '12px',
  lg: '18px',
  xl: '24px',
  bubble: '18px',
  full: '999px',
} as const;

/** 固定尺寸常量：避免魔法数字散落各处 */
export const size = {
  header: '56px',
  button: '50px',
  input: '50px',
  tabbar: '60px',
  avatar: '44px',
  avatarLg: '72px',
} as const;

/** 字号 */
export const fontSize = {
  xs: '11px',
  sm: '13px',
  md: '15px',
  lg: '17px',
  xl: '22px',
  xxl: '32px',
  hero: '44px',
} as const;

/**
 * 常用组合样式
 * ------------------------------------------------------------
 * 全站页面统一结构：
 *
 *   <page>
 *     <view style={commonStyles.page}>        ← flex:1 + column
 *       <view style={commonStyles.header}>    ← 固定高
 *       <view style={commonStyles.body}>      ← flex:1，内部放 scroll-view
 *       <view style={commonStyles.footer}>    ← 固定高（可选）
 *     </view>
 *   </page>
 */
export const commonStyles = {
  /**
   * 页面根
   *
   * 用 height:'100vh' 而不是 flex:1 或 100%：
   * - flex:1 依赖父级是确定的 flex 容器，某些渲染时机下会塌成 0，
   *   子内容溢出不报错（表现为「内容跑到 TabBar 上面」这种错位）；
   * - '100%' 需要父级高度可解析，Lynx 里不一定成立；
   * - '100vh' 是视口绝对高度，不依赖任何父级，最稳。
   *
   * 全站页面都是 App 根容器的直接子元素（占据整屏），
   * 所以 100vh 在语义上也是正确的。
   */
  page: {
    height: '100vh',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.bg,
  },

  /** 顶部导航栏：标题绝对定位居中，避开 row 容器 flex:1 塌陷 */
  header: {
    position: 'relative',
    width: '100%',
    height: size.header,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    // 标题是绝对定位不占位，用 space-between 让左右按钮分居两端
    justifyContent: 'space-between',
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomColor: colors.border,
  },

  /** 导航栏左右按钮区（固定宽 + zIndex 保证可点击） */
  headerSide: {
    zIndex: 1,
    width: '64px',
    height: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
  },

  /**
   * 导航栏中间标题区
   *
   * ⚠ 必须绝对定位，不能用 flex:1。
   * 实测：Lynx 的 row 容器里 flex:1 子项宽度会算成 0，
   * 里面的 text 就只能一行放一个字，中文标题直接竖排。
   * 绝对定位 + width:100% + justifyContent:center 可稳定居中。
   */
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

  /**
   * 导航栏标题文字
   * ⚠ flexShrink:0 必须加。
   * 否则在 row 容器里 text 会被压成最小内容宽，
   * 中文就会竖排（“注 册”变成两行各一个字）。
   */
  headerTitle: {
    flexShrink: 0,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },

  /**
   * 可滚动区
   *
   * ⚠ 使用条件（实测）：scroll-view 的直接父级必须是 flex:1，
   * 且该父级之上只能有一层 flex:1（也就是页面根自己）。
   * 中间再套 flex:1 会让 scroll-view 高度算成 0，内容全部不可见。
   */
  scroll: {
    flex: 1,
    width: '100%',
  },

  /** 主体区：flex:1，内部放 scroll-view */
  body: {
    flex: 1,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },

  /**
   * 可滚动区域 —— ⚠ 用 list，不要用 scroll-view
   *
   * 实测（Android 14 / Lynx 4.2）：scroll-view 在 flex:1 的父级里
   * 高度会塌成 0，内容完全不可见，且不报任何错误。
   * list 是 Lynx 官方推荐的滚动容器，稳定可用。
   *
   * 用法：
   *   <view style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column' }}>
   *     <view style={{ width: '100%' }}>…</view>
   *   </view>
   *
   * ⚠ list-item 必须带 item-key，否则报 220201 错误且整块空白。
   */
  list: {
    flex: 1,
    width: '100%',
  },

  /** list-item 内部内容容器（统一内边距） */
  listItemContent: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },

  /** 底部固定栏 */
  footer: {
    width: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.surface,
    borderTopWidth: '1px',
    borderTopColor: colors.border,
  },

  /** 主按钮 */
  buttonPrimary: {
    width: '100%',
    height: size.button,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  buttonPrimaryText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '600',
  },

  /** 次要按钮 */
  buttonGhost: {
    width: '100%',
    height: size.button,
    borderRadius: radius.md,
    borderWidth: '1px',
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

  /** 危险按钮 */
  buttonDanger: {
    width: '100%',
    height: size.button,
    borderRadius: radius.md,
    backgroundColor: colors.danger,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  buttonDangerText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '600',
  },

  /** 输入框 */
  input: {
    width: '100%',
    height: size.input,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderColor: colors.border,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    color: colors.text,
    fontSize: fontSize.md,
  },

  /**
   * 卡片
   * ⚠ 必须显式写 display:'flex' + flexDirection:'column'。
   * Lynx 的 view 默认是 flex 行向布局，漏写会把所有子元素横排，
   * 表现为「边框还在，但内容全部错位溢出」。
   */
  card: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.card,
    borderWidth: '1px',
    borderColor: colors.cardBorder,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },

  /** 居中容器：父级必须有确定高度才能撑开 */
  center: {
    flex: 1,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /** 表单字段标签 */
  label: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginBottom: spacing.sm,
  },

  /** 错误提示文字 */
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
  },

  /** 提示文字 */
  hintText: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    lineHeight: '18px',
  },

  /** 横向分隔线 */
  divider: {
    width: '100%',
    height: '1px',
    backgroundColor: colors.border,
  },
} as const;
