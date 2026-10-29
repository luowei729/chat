/**
 * ============================================================
 * 新建会话页
 * ------------------------------------------------------------
 * 两种方式：
 * 1. 搜索用户（邮箱精确 / 昵称模糊）→ 发起私聊；
 * 2. 创建群聊（勾选多个用户 + 群名）。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import type { UserPublic } from '@chat/shared';
import { createDirect, createGroup, searchUsers } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { pop, push } from '../router.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function NewChatPage() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<UserPublic[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 群聊模式 */
  const [groupMode, setGroupMode] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /** 搜索用户 */
  const handleSearch = async () => {
    const q = keyword.trim();
    if (q.length < 2) {
      setError('请输入至少 2 个字符');
      return;
    }

    setSearching(true);
    setError(null);
    try {
      const list = await searchUsers(q);
      setResults(list);
      if (list.length === 0) setError('没有找到匹配的用户');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  };

  /** 发起私聊 */
  const startDirect = async (peer: UserPublic) => {
    try {
      const r = await createDirect(peer.id);
      push({
        name: 'chat',
        params: { conversationId: r.conversationId, title: peer.nickname },
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建会话失败');
    }
  };

  /** 切换选中（群聊模式） */
  const toggleSelect = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  /** 创建群聊 */
  const handleCreateGroup = async () => {
    if (!groupTitle.trim()) {
      setError('请输入群名称');
      return;
    }
    if (selected.size === 0) {
      setError('请至少选择一位成员');
      return;
    }

    try {
      const r = await createGroup({
        title: groupTitle.trim(),
        memberIds: [...selected],
      });
      push({
        name: 'chat',
        params: { conversationId: r.conversationId, title: groupTitle.trim() },
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建群聊失败');
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏：三段式居中 */}
      <view style={commonStyles.header}>
        <view style={commonStyles.headerSide}>
          <text style={{ color: colors.primary, fontSize: fontSize.md }} bindtap={pop}>
            返回
          </text>
        </view>
        <view style={commonStyles.headerCenter}>
          <text style={commonStyles.headerTitle}>{groupMode ? '创建群聊' : '发起聊天'}</text>
        </view>
        <view style={{ ...commonStyles.headerSide, justifyContent: 'flex-end' }}>
          <text
            style={{ color: colors.primary, fontSize: fontSize.sm }}
            bindtap={() => {
              setGroupMode(!groupMode);
              setSelected(new Set());
              setError(null);
            }}
          >
            {groupMode ? '私聊' : '群聊'}
          </text>
        </view>
      </view>

      <view style={{ padding: spacing.md }}>
        {/* 群名输入（仅群聊模式） */}
        {groupMode ? (
          <view style={{ marginBottom: spacing.sm }}>
            <input
              style={commonStyles.input}
              default-value={groupTitle}
              placeholder="群名称"
              bindinput={(e: { detail: { value: string } }) => setGroupTitle(e.detail.value)}
            />
          </view>
        ) : null}

        {/* 搜索框 */}
        <view style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <view style={{ flex: 1, marginRight: spacing.sm }}>
            <input
              style={commonStyles.input}
              default-value={keyword}
              placeholder="邮箱或昵称"
              bindinput={(e: { detail: { value: string } }) => setKeyword(e.detail.value)}
              bindconfirm={handleSearch}
            />
          </view>
          <view
            style={{
              width: 72,
              height: 50,
              borderRadius: radius.md,
              backgroundColor: colors.primary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={handleSearch}
          >
            <text style={{ color: '#fff', fontSize: fontSize.sm }}>
              {searching ? '搜索中' : '搜索'}
            </text>
          </view>
        </view>

        {error ? (
          <text style={{ color: colors.danger, fontSize: fontSize.xs }}>{error}</text>
        ) : null}

        {/* 群聊模式：创建按钮 */}
        {groupMode && selected.size > 0 ? (
          <view
            style={{ ...commonStyles.buttonPrimary, marginTop: spacing.sm }}
            bindtap={handleCreateGroup}
          >
            <text style={commonStyles.buttonPrimaryText}>
              创建群聊（已选 {selected.size} 人）
            </text>
          </view>
        ) : null}
      </view>

      {/* 搜索结果 */}
      <scroll-view scroll-orientation="vertical" style={commonStyles.scroll}>
        {results.map((user) => (
          <view
            key={user.id}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              padding: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              backgroundColor: selected.has(user.id) ? colors.primarySoft : 'transparent',
            }}
            bindtap={() => (groupMode ? toggleSelect(user.id) : startDirect(user))}
          >
            {/* 头像 */}
            <view
              style={{
                width: 42,
                height: 42,
                borderRadius: radius.full,
                backgroundColor: colors.primarySoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: spacing.md,
              }}
            >
              <text style={{ color: colors.primary, fontSize: fontSize.md, fontWeight: '600' }}>
                {user.nickname.slice(0, 1)}
              </text>
            </view>

            <view style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0 }}>
              <text style={{ color: colors.text, fontSize: fontSize.md }} text-maxline="1">
                {user.nickname}
              </text>
              <text style={{ color: colors.textFaint, fontSize: fontSize.xs }} text-maxline="1">
                {user.email}
              </text>
            </view>

            {/* 群聊模式的勾选标记 */}
            {groupMode ? (
              <view
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: radius.full,
                  backgroundColor: selected.has(user.id) ? colors.primary : 'transparent',
                  borderWidth: selected.has(user.id) ? 0 : 1,
                  borderColor: colors.border,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected.has(user.id) ? (
                  <text style={{ color: '#fff', fontSize: 12 }}>✓</text>
                ) : null}
              </view>
            ) : null}
          </view>
        ))}
      </scroll-view>
    </view>
  );
}
