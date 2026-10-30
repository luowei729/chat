/**
 * ============================================================
 * 消息搜索（Telegram 风格）
 * ------------------------------------------------------------
 * 顶部搜索框 + 结果列表。
 *
 * 后端用 MySQL FULLTEXT ngram 索引检索，
 * 命中词在 snippet 里被 \u0002 \u0003 包裹，
 * 这里拆成三段渲染实现高亮（Lynx 不支持富文本嵌套样式组合）。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import type { MessageSearchHit } from '@chat/shared';
import { searchMessages } from '../api/index.js';
import { pop, push } from '../router.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

/** 命中词包裹标记，与后端约定 */
const HL_START = '\u0002';
const HL_END = '\u0003';

export function SearchMessagesPage() {
  const [keyword, setKeyword] = useState('');
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = keyword.trim();
    if (!q) {
      setError('请输入关键词');
      return;
    }
    if (loading) return;

    setLoading(true);
    setError(null);
    try {
      const r = await searchMessages({ q, limit: 30 });
      setHits(r.hits);
      setTotal(r.total);
      setSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '搜索失败');
      setHits([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部：返回 + 搜索框 */}
      <view
        style={{
          width: '100%',
          height: '56px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: spacing.sm,
          paddingRight: spacing.md,
          backgroundColor: colors.surface,
          borderBottomWidth: '1px',
          borderBottomColor: colors.border,
        }}
      >
        <view
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          bindtap={pop}
        >
          <text style={{ color: colors.primary, fontSize: fontSize.md }}>返回</text>
        </view>

        <view style={{ width: '72%', marginRight: spacing.sm }}>
          <input
            style={{
              width: '100%',
              height: '40px',
              borderRadius: radius.md,
              backgroundColor: colors.surfaceAlt,
              borderWidth: '1px',
              borderColor: colors.border,
              paddingLeft: spacing.md,
              paddingRight: spacing.md,
              color: colors.text,
              fontSize: fontSize.sm,
            }}
            default-value={keyword}
            placeholder="搜索消息内容"
            bindinput={(e: { detail: { value: string } }) => setKeyword(e.detail.value)}
            bindconfirm={search}
          />
        </view>

        <view
          style={{
            height: '40px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingLeft: spacing.sm,
            paddingRight: spacing.sm,
          }}
          bindtap={search}
        >
          <text style={{ color: colors.primary, fontSize: fontSize.sm }}>
            {loading ? '搜索中' : '搜索'}
          </text>
        </view>
      </view>

      {/* 结果区：绝对定位锁定在搜索栏下方，避免 flex:1 塌陷导致条目被压扁 */}
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

        {searched && !loading ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginBottom: spacing.sm }}>
            共找到 {String(total)} 条结果
          </text>
        ) : null}

        {hits.map((h) => (
          <HitRow
            key={h.messageId}
            hit={h}
            onTap={() =>
              push({
                name: 'chat',
                params: { conversationId: h.conversationId, title: h.conversationTitle },
              })
            }
          />
        ))}

        {searched && hits.length === 0 && !error ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '48px',
            }}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>没有找到相关消息</text>
            <text
              style={{
                color: colors.textFaint,
                fontSize: fontSize.sm,
                marginTop: spacing.sm,
                textAlign: 'center',
              }}
            >
              换个关键词试试，支持中文与英文
            </text>
          </view>
        ) : null}

        {!searched ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '48px',
            }}
          >
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm, textAlign: 'center' }}>
              输入关键词后点「搜索」
            </text>
          </view>
        ) : null}
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 结果行                                                               */
/* ------------------------------------------------------------------ */

function HitRow(props: { hit: MessageSearchHit; onTap: () => void }) {
  const { hit, onTap } = props;
  const parts = splitHighlight(hit.snippet);

  return (
    <view
      style={{
        width: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.card,
        borderWidth: '1px',
        borderColor: colors.cardBorder,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
      }}
      bindtap={onTap}
    >
      <view
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: '4px',
        }}
      >
        <view style={{ width: '70%' }}>
          <text style={{ color: colors.primary, fontSize: fontSize.sm }} text-maxline="1">
            {hit.conversationTitle}
          </text>
        </view>
        <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
          {formatTime(hit.createdAt)}
        </text>
      </view>

      {/* 高亮片段：命中部分用不同颜色渲染 */}
      <view style={{ width: '100%', display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
        {parts.map((p, i) => (
          <text
            key={`${hit.messageId}-${String(i)}`}
            style={{
              color: p.highlight ? colors.warning : colors.text,
              fontSize: fontSize.sm,
              fontWeight: p.highlight ? '600' : '400',
            }}
          >
            {p.text}
          </text>
        ))}
      </view>

      <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginTop: '4px' }}>
        {hit.senderName}
      </text>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

interface Segment {
  text: string;
  highlight: boolean;
}

/**
 * 把 \u0002命中\u0003 标记拆成 [{text, highlight}] 数组。
 * 用逐段扫描而不是正则，避免特殊字符转义问题。
 */
function splitHighlight(snippet: string): Segment[] {
  const out: Segment[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const start = rest.indexOf(HL_START);
    if (start < 0) {
      out.push({ text: rest, highlight: false });
      break;
    }
    if (start > 0) out.push({ text: rest.slice(0, start), highlight: false });

    const afterStart = rest.slice(start + 1);
    const end = afterStart.indexOf(HL_END);
    if (end < 0) {
      out.push({ text: afterStart, highlight: true });
      break;
    }
    out.push({ text: afterStart.slice(0, end), highlight: true });
    rest = afterStart.slice(end + 1);
  }

  return out.filter((s) => s.text.length > 0);
}

/** 消息时间：今天显示时分，否则显示月-日 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');

  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1)}-${String(d.getDate())}`;
}
