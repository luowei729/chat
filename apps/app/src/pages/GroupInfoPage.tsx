/**
 * ============================================================
 * 群信息 / 成员管理
 * ------------------------------------------------------------
 * 功能：
 * 1. 展示群名与成员列表（群主 / 管理员 / 成员分组标识）；
 * 2. 邀请好友入群；
 * 3. 群主：设/取消管理员、移除成员、转让群主、改群名；
 * 4. 全员：退出群聊（群主需先转让）。
 *
 * 【布局约束】本项目 Lynx 集成下 scroll-view / list 会把内容渲染成
 * 空白且不报错，所以全部用纯 view，成员过多时用「显示更多」分页。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import type { GroupMemberItem } from '@chat/shared';
import {
  inviteGroupMembers,
  leaveGroup,
  listGroupMembers,
  transferGroupOwner,
  updateGroupInfo,
  updateGroupMember,
} from '../api/index.js';
import { pop, reset } from '../router.js';
import { useAuth } from '../store/auth.js';
import { refreshFriends, useFriends } from '../store/friends.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { IconBack, IconChevron } from './Icons.js';

/** 成员每页展示数 */
const MEMBER_PAGE = 10;

export function GroupInfoPage(props: { conversationId: string; title?: string }) {
  const { conversationId } = props;
  const auth = useAuth();
  const { friends } = useFriends();

  const [members, setMembers] = useState<GroupMemberItem[]>([]);
  const [title, setTitle] = useState(props.title ?? '群聊');
  const [titleDraft, setTitleDraft] = useState(props.title ?? '');
  const [editingTitle, setEditingTitle] = useState(false);

  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 底部弹出的操作面板：选中成员后显示 */
  const [activeMember, setActiveMember] = useState<GroupMemberItem | null>(null);
  /** 邀请面板 */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSelected, setInviteSelected] = useState<string[]>([]);

  /* ---------------- 加载 ---------------- */
  const load = async () => {
    try {
      const list = await listGroupMembers(conversationId);
      setMembers(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载成员失败');
    }
  };

  useEffect(() => {
    void load();
    void refreshFriends();
  }, [conversationId]);

  /* ---------------- 当前用户身份 ---------------- */
  const myId = auth.user?.id ?? '';
  const me = members.find((m) => m.userId === myId);
  const myRole = me?.role ?? 'member';
  const isOwner = myRole === 'owner';
  const isAdmin = isOwner || myRole === 'admin';

  /* ---------------- 操作 ---------------- */
  const run = async (fn: () => Promise<void>, failText: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : failText);
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = () =>
    run(async () => {
      const t = titleDraft.trim();
      if (!t) throw new Error('群名不能为空');
      await updateGroupInfo(conversationId, { title: t });
      setTitle(t);
      setEditingTitle(false);
    }, '修改群名失败');

  const doInvite = () =>
    run(async () => {
      if (inviteSelected.length === 0) return;
      await inviteGroupMembers(conversationId, inviteSelected);
      setInviteSelected([]);
      setInviteOpen(false);
      await load();
    }, '邀请失败');

  const toggleSelect = (userId: string) => {
    setInviteSelected((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId],
    );
  };

  const memberAction = (action: 'promote' | 'demote' | 'remove') =>
    run(async () => {
      if (!activeMember) return;
      await updateGroupMember(conversationId, activeMember.userId, action);
      setActiveMember(null);
      await load();
    }, '操作失败');

  const doTransfer = () =>
    run(async () => {
      if (!activeMember) return;
      await transferGroupOwner(conversationId, activeMember.userId);
      setActiveMember(null);
      await load();
    }, '转让失败');

  const doLeave = () =>
    run(async () => {
      await leaveGroup(conversationId);
      // 退群后会话已不可访问，回到会话列表
      reset({ name: 'conversations' });
    }, '退出群聊失败');

  /* ---------------- 视图 ---------------- */
  const visibleMembers = members.slice(0, page * MEMBER_PAGE);
  const hasMore = visibleMembers.length < members.length;

  /** 已在群内的好友 id，用于邀请时过滤 */
  const joinedIds = new Set(members.map((m) => m.userId));
  const invitable = friends.filter((f) => !joinedIds.has(f.userId));

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <view
          style={{ ...commonStyles.headerSide, justifyContent: 'center' }}
          bindtap={pop}
        >
          <IconBack size={22} color={colors.text} />
        </view>
        <view style={commonStyles.headerCenter}>
          <text style={commonStyles.headerTitle}>群信息</text>
        </view>
        <view style={commonStyles.headerSide} />
      </view>

      <view
        style={{
          position: 'absolute',
          left: 0,
          top: '56px',
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          paddingTop: spacing.md,
        }}
      >
        {error ? (
          <text style={{ color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm }}>
            {error}
          </text>
        ) : null}

        {/* 群名 */}
        <view style={infoCardStyle()}>
          <text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginBottom: '6px' }}>
            群名称
          </text>
          {editingTitle ? (
            <view style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
              <input
                style={inputStyle()}
                default-value={titleDraft}
                placeholder="输入群名称"
                bindinput={(e: { detail: { value: string } }) => setTitleDraft(e.detail.value)}
              />
              <view style={{ width: '100%', display: 'flex', flexDirection: 'row', marginTop: spacing.sm }}>
                <view
                  style={{ ...smallBtnStyle(), backgroundColor: colors.primary, marginRight: spacing.sm }}
                  bindtap={() => void saveTitle()}
                >
                  <text style={{ color: '#FFFFFF', fontSize: fontSize.sm }}>保存</text>
                </view>
                <view
                  style={{ ...smallBtnStyle(), borderWidth: '1px', borderColor: colors.cardBorder }}
                  bindtap={() => {
                    setEditingTitle(false);
                    setTitleDraft(title);
                  }}
                >
                  <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>取消</text>
                </view>
              </view>
            </view>
          ) : (
            <view
              style={{
                width: '100%',
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
              bindtap={isAdmin ? () => setEditingTitle(true) : undefined}
            >
              <text style={{ color: colors.text, fontSize: fontSize.md }}>{title}</text>
              {isAdmin ? (
                <text style={{ color: colors.primary, fontSize: fontSize.sm }}>修改</text>
              ) : null}
            </view>
          )}
        </view>

        {/* 成员统计 + 邀请入口 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: spacing.sm,
            marginBottom: spacing.sm,
          }}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            群成员 {String(members.length)} 人
          </text>
          {invitable.length > 0 ? (
            <text
              style={{ color: colors.primary, fontSize: fontSize.sm }}
              bindtap={() => setInviteOpen(!inviteOpen)}
            >
              {inviteOpen ? '收起' : '邀请好友'}
            </text>
          ) : null}
        </view>

        {/* 邀请面板 */}
        {inviteOpen ? (
          <view style={{ ...infoCardStyle(), marginBottom: spacing.md }}>
            {invitable.map((f) => {
              const checked = inviteSelected.includes(f.userId);
              return (
                <view
                  key={f.userId}
                  style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingTop: spacing.sm,
                    paddingBottom: spacing.sm,
                    borderBottomWidth: '1px',
                    borderBottomColor: colors.border,
                    backgroundColor: checked ? colors.primarySoft : 'transparent',
                  }}
                  bindtap={() => toggleSelect(f.userId)}
                >
                  <view
                    style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: radius.sm,
                      borderWidth: '1px',
                      borderColor: checked ? colors.primary : colors.cardBorder,
                      backgroundColor: checked ? colors.primary : 'transparent',
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: spacing.sm,
                    }}
                  >
                    {checked ? (
                      <text style={{ color: '#FFFFFF', fontSize: '11px' }}>✓</text>
                    ) : null}
                  </view>
                  <text style={{ color: colors.text, fontSize: fontSize.sm }}>{f.displayName}</text>
                </view>
              );
            })}
            <view
              style={{
                ...smallBtnStyle(),
                backgroundColor: colors.primary,
                marginTop: spacing.sm,
              }}
              bindtap={() => void doInvite()}
            >
              <text style={{ color: '#FFFFFF', fontSize: fontSize.sm }}>
                {busy ? '邀请中…' : `邀请 ${String(inviteSelected.length)} 位好友`}
              </text>
            </view>
          </view>
        ) : null}

        {/* 成员列表 */}
        {visibleMembers.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            isSelf={m.userId === myId}
            canManage={isAdmin && m.role !== 'owner' && m.userId !== myId}
            onTap={() => {
              if (isAdmin && m.role !== 'owner' && m.userId !== myId) {
                setActiveMember(m);
              }
            }}
          />
        ))}

        {hasMore ? (
          <view
            style={{
              width: '100%',
              height: '40px',
              borderRadius: radius.md,
              borderWidth: '1px',
              borderColor: colors.cardBorder,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: spacing.sm,
            }}
            bindtap={() => setPage((p) => p + 1)}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
              显示更多（还有 {String(members.length - visibleMembers.length)} 人）
            </text>
          </view>
        ) : null}

        {/* 成员操作面板 */}
        {activeMember ? (
          <view style={{ ...infoCardStyle(), marginTop: spacing.md }}>
            <text style={{ color: colors.text, fontSize: fontSize.md, marginBottom: spacing.sm }}>
              {activeMember.displayName}
            </text>
            <view style={{ width: '100%', display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
              {activeMember.role === 'member' ? (
                <view
                  style={{ ...smallBtnStyle(), backgroundColor: colors.primary, marginRight: spacing.sm, marginBottom: spacing.sm }}
                  bindtap={() => void memberAction('promote')}
                >
                  <text style={{ color: '#FFFFFF', fontSize: fontSize.sm }}>设为管理员</text>
                </view>
              ) : (
                <view
                  style={{ ...smallBtnStyle(), borderWidth: '1px', borderColor: colors.cardBorder, marginRight: spacing.sm, marginBottom: spacing.sm }}
                  bindtap={() => void memberAction('demote')}
                >
                  <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>取消管理员</text>
                </view>
              )}
              {isOwner ? (
                <view
                  style={{ ...smallBtnStyle(), borderWidth: '1px', borderColor: colors.warning, marginRight: spacing.sm, marginBottom: spacing.sm }}
                  bindtap={() => void doTransfer()}
                >
                  <text style={{ color: colors.warning, fontSize: fontSize.sm }}>转让群主</text>
                </view>
              ) : null}
              <view
                style={{ ...smallBtnStyle(), borderWidth: '1px', borderColor: colors.danger, marginBottom: spacing.sm }}
                bindtap={() => void memberAction('remove')}
              >
                <text style={{ color: colors.danger, fontSize: fontSize.sm }}>移出群聊</text>
              </view>
            </view>
            <view
              style={{ ...smallBtnStyle(), borderWidth: '1px', borderColor: colors.cardBorder }}
              bindtap={() => setActiveMember(null)}
            >
              <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>取消</text>
            </view>
          </view>
        ) : null}

        {/* 退出群聊 */}
        <view
          style={{
            width: '100%',
            height: '46px',
            borderRadius: radius.md,
            borderWidth: '1px',
            borderColor: colors.danger,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: spacing.lg,
            marginBottom: spacing.xxl,
          }}
          bindtap={isOwner ? undefined : () => void doLeave()}
        >
          <text style={{ color: colors.danger, fontSize: fontSize.md }}>
            {isOwner ? '群主需先转让才能退群' : '退出群聊'}
          </text>
        </view>
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 成员行                                                               */
/* ------------------------------------------------------------------ */

function MemberRow(props: {
  member: GroupMemberItem;
  isSelf: boolean;
  canManage: boolean;
  onTap: () => void;
}) {
  const { member: m, isSelf, canManage, onTap } = props;
  const initial = m.displayName.slice(0, 1).toUpperCase();

  const roleLabel = m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '';

  return (
    <view
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.card,
        borderWidth: '1px',
        borderColor: colors.cardBorder,
        borderRadius: radius.md,
        padding: spacing.sm,
        marginBottom: spacing.sm,
      }}
      bindtap={canManage ? onTap : undefined}
    >
      <view
        style={{
          width: '38px',
          height: '38px',
          borderRadius: radius.full,
          backgroundColor: colors.primarySoft,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
        }}
      >
        <text style={{ color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' }}>
          {initial}
        </text>
      </view>

      <view
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0px', display: 'flex', flexDirection: 'row', alignItems: 'center' }}
      >
        <text style={{ color: colors.text, fontSize: fontSize.md }} text-maxline="1">
          {m.displayName}
        </text>
        {isSelf ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginLeft: '6px' }}>
            （我）
          </text>
        ) : null}
        {roleLabel ? (
          <text style={{ color: colors.warning, fontSize: fontSize.xs, marginLeft: '6px' }}>
            {roleLabel}
          </text>
        ) : null}
      </view>

      {canManage ? (
        <IconChevron size={16} color={colors.textFaint} />
      ) : null}
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 样式常量                                                             */
/* ------------------------------------------------------------------ */

function infoCardStyle() {
  return {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: colors.card,
  borderWidth: '1px',
  borderColor: colors.cardBorder,
  borderRadius: radius.md,
  padding: spacing.md,
  marginBottom: spacing.sm,
  } as const;
}

function inputStyle() {
  return {
  width: '100%',
  height: '44px',
  borderRadius: radius.md,
  backgroundColor: colors.surfaceAlt,
  borderWidth: '1px',
  borderColor: colors.border,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  color: colors.text,
  fontSize: fontSize.md,
  } as const;
}

function smallBtnStyle() {
  return {
  minWidth: '88px',
  height: '38px',
  borderRadius: radius.md,
  display: 'flex',
  flexDirection: 'row', width: '100%',
  alignItems: 'center',
  justifyContent: 'center',
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  } as const;
}
