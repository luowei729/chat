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
import { IconChat, IconContacts, IconSettings } from './Icons.js';

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

/**
 * Tab 定义
 * ------------------------------------------------------------
 * 用线性矢量图标而不是 emoji：
 * emoji 是拟物彩色字形，与扁平设计语言冲突且各端渲染差异大；
 * 图标统一 22px、描边 2px，选中时切换为填充态 + 强调色。
 */
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'chats', label: '聊天' },
  { key: 'contacts', label: '联系人' },
  { key: 'settings', label: '设置' },
];

/** 按 Tab 与选中态渲染对应图标 */
function TabIcon(props: { tab: TabKey; active: boolean }) {
  const { tab, active } = props;
  // 纯白图标：选中态用纯白 + 填充，未选中用灰白描边
  const color = active ? colors.text : colors.textFaint;

  if (tab === 'chats') return <IconChat size={23} color={color} filled={active} />;
  if (tab === 'contacts') return <IconContacts size={23} color={color} filled={active} />;
  return <IconSettings size={23} color={color} filled={active} />;
}

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
      {/*
        三等分：每个 Tab 用绝对定位 + 明确的 left 值
        ------------------------------------------------------------
        之前用 width:'33.33%' 靠 flex 排列，理论上是等分，但
        Lynx 在行向容器里做百分比累加时会因浮点舍入产生 1~2px
        偏差，三个叠起来就出现「第三个比前两个窄」，点击区也随之
        偏移。改成绝对定位后每个 Tab 的 left 都是硬值，
        位置与点击区完全确定，任何屏宽都严格三等分。
      */}
      {TABS.map((t, i) => {
        const isActive = t.key === active;
        const badge = t.key === 'chats' ? chatBadge : t.key === 'contacts' ? contactBadge : 0;

        return (
          <view
            key={t.key}
            style={{
              position: 'absolute',
              left: `${(i * 100) / 3}%`,
              top: 0,
              width: `${100 / 3}%`,
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
              <TabIcon tab={t.key} active={isActive} />

              {badge > 0 ? (
                <view
                  style={{
                    position: 'absolute',
                    left: '18px',
                    top: '-4px',
                    minWidth: '16px',
                    height: '16px',
                    borderRadius: '8px',
                    backgroundColor: colors.danger,
                    display: 'flex',
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

            <text
              style={{
                fontSize: fontSize.xs,
                color: isActive ? colors.text : colors.textFaint,
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
