/**
 * ============================================================
 * 底部导航栏（Telegram 风格三栏）
 * ------------------------------------------------------------
 * 聊天 / 联系人 / 设置
 *
 * 【为什么自己实现而不引入导航库】
 * 本项目的 Lynx 集成下 scroll-view / list 都不可靠，
 * 第三方 Tab 组件普遍依赖这些容器，容易踩同一个坑。
 * 这里只有 30 行布局逻辑，自己写更可控。
 *
 * 【布局关键点（全部实测）】
 * 1. 容器必须 width:'100%' + flexDirection:'row'，否则子项宽度塌陷；
 * 2. 每个 Tab 用百分比宽度（33.33%），不用 flex:1
 *    —— 本父级链下 flex:1 会被算成 0；
 * 3. 高度必须带单位字符串 '56px'，数字 56 会触发 CSS length 错误；
 * 4. flexShrink:0 保证底部栏不被内容挤压。
 * ============================================================
 */

import { colors, fontSize, radius } from '../theme.js';

export type TabKey = 'chats' | 'contacts' | 'settings';

interface TabBarProps {
  /** 当前选中的 Tab */
  active: TabKey;
  /** 切换回调；不传则该 Tab 不可点（如已在当前页） */
  onChange: (key: TabKey) => void;
  /** 聊天 Tab 上的未读总数，0 表示不显示 */
  chatBadge?: number;
  /** 联系人的新好友请求数 */
  contactBadge?: number;
}

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'chats', label: '聊天', icon: '💬' },
  { key: 'contacts', label: '联系人', icon: '👥' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

export function TabBar(props: TabBarProps) {
  const { active, onChange, chatBadge = 0, contactBadge = 0 } = props;

  return (
    <view
      style={{
        /**
         * 绝对定位到底部，而不是当普通 flex 子项。
         * ------------------------------------------------------------
         * 原因：实测发现放在 flex 列末尾时，某些页面的内容区
         * flex:1 会被算成 0 高，导致 TabBar 顶到标题栏下面、
         * 内容压在它上面（排版全乱）。
         * 绝对定位后 TabBar 脱离文档流，永远贴底，
         * 不受任何父级 flex 计算影响；页面内容自行留 paddingBottom。
         */
        position: 'absolute',
        left: 0,
        bottom: 0,
        zIndex: 10,
        width: '100%',
        height: '56px',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderTopWidth: '1px',
        borderTopColor: colors.border,
      }}
    >
      {TABS.map((t) => {
        const isActive = t.key === active;
        const badge = t.key === 'chats' ? chatBadge : t.key === 'contacts' ? contactBadge : 0;

        return (
          <view
            key={t.key}
            style={{
              width: '33.33%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => {
              if (!isActive) onChange(t.key);
            }}
          >
            {/* 图标 + 红点 */}
            <view
              style={{
                width: '28px',
                height: '22px',
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
              }}
            >
              <text style={{ fontSize: '17px' }}>{t.icon}</text>

              {badge > 0 ? (
                <view
                  style={{
                    position: 'absolute',
                    left: '18px',
                    top: '-4px',
                    minWidth: '16px',
                    height: '16px',
                    borderRadius: radius.full,
                    backgroundColor: colors.danger,
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingLeft: '4px',
                    paddingRight: '4px',
                  }}
                >
                  <text style={{ color: '#FFFFFF', fontSize: '10px', fontWeight: '600' }}>
                    {badge > 99 ? '99+' : String(badge)}
                  </text>
                </view>
              ) : null}
            </view>

            {/* 文字 */}
            <text
              style={{
                fontSize: fontSize.xs,
                color: isActive ? colors.primary : colors.textFaint,
                fontWeight: isActive ? '600' : '400',
                marginTop: '2px',
              }}
            >
              {t.label}
            </text>
          </view>
        );
      })}
    </view>
  );
}
