/**
 * ============================================================
 * 消息全文搜索
 * ------------------------------------------------------------
 * 使用 MySQL FULLTEXT + ngram 分词器。
 *
 * 【为什么必须用 ngram】
 * MySQL 默认分词按空格切词，中文整句会被当成一个 token，
 * 搜「会议」搜不到「明天下午三点开会」。
 * ngram 按固定长度滑窗切分（ngram_token_size=2），
 * 中文两字词检索准确率高，且索引体积可控。
 *
 * 【为什么不'LIKE %kw%'】
 * 前导通配符无法走索引，10 万条消息会全表扫描。
 * 在 2 核机器上单个搜索请求就能把 CPU 打满，拖垮聊天服务。
 * FULLTEXT 走倒排索引，耗时稳定在毫秒级。
 *
 * 【权限】
 * 只搜当前用户仍在的会话（leftAt IS NULL），
 * 且只搜未删除的消息。SQL 里用 IN 子查询限制会话范围，
 * 避免越权检索他人聊天内容。
 * ============================================================
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { MessageSearchHit, MessageSearchResult } from '@chat/shared';
import { db } from '../../db/index.js';
import { conversationMembers, conversations, messages, users } from '../../db/schema.js';

/** 命中词包裹符：客户端据此高亮 */
const HL_START = '\u0002';
const HL_END = '\u0003';

/** 结果每页条数 */
const SEARCH_PAGE_SIZE = 20;

export async function searchMessages(
  userId: string,
  rawKeyword: string,
  options: { conversationId?: string; before?: number; limit?: number } = {},
): Promise<MessageSearchResult> {
  const keyword = rawKeyword.trim().slice(0, 64);
  if (keyword.length === 0) {
    return { hits: [], total: 0, hasMore: false, nextCursor: null };
  }

  const limit = Math.min(options.limit ?? SEARCH_PAGE_SIZE, 50);

  /**
   * BOOLEAN MODE 语义：
   *   +word 必须包含
   *   word* 前缀匹配
   * 这里把关键词整体当作必须包含项，ngram 分词器会自行切分。
   */
  const ftQuery = `"${keyword.replace(/["\\]/g, ' ')}"`;

  // 会话范围：我仍在的会话
  const myConvRows = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)));

  const myConvIds = myConvRows.map((r) => r.conversationId);
  if (myConvIds.length === 0) {
    return { hits: [], total: 0, hasMore: false, nextCursor: null };
  }

  // 可限定单个会话搜索
  const scopeIds =
    options.conversationId && myConvIds.includes(options.conversationId)
      ? [options.conversationId]
      : myConvIds;

  if (scopeIds.length === 0) {
    return { hits: [], total: 0, hasMore: false, nextCursor: null };
  }

  const conditions = [
    inArray(messages.conversationId, scopeIds),
    isNull(messages.deletedAt),
    sql`MATCH(${messages.text}) AGAINST (${ftQuery} IN BOOLEAN MODE)`,
  ];

  if (options.before !== undefined && options.before > 0) {
    conditions.push(sql`${messages.createdAt} < ${options.before}`);
  }

  /**
   * 用 MATCH 打分排序，相关性高的在前。
   * 同时取总数（SQL_CALC_FOUND_ROWS 已废弃，用单独 COUNT）。
   */
  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      senderName: users.nickname,
      type: messages.type,
      text: messages.text,
      seq: messages.seq,
      createdAt: messages.createdAt,
      score: sql<number>`MATCH(${messages.text}) AGAINST (${ftQuery} IN BOOLEAN MODE)`,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(...conditions))
    .orderBy(
      sql`MATCH(${messages.text}) AGAINST (${ftQuery} IN BOOLEAN MODE) DESC`,
      sql`${messages.createdAt} DESC`,
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // 会话标题：私聊显示对方昵称，群聊显示群名
  const convIds = Array.from(new Set(pageRows.map((r) => r.conversationId)));
  const titleMap = await loadConversationTitles(userId, convIds);

  const hits: MessageSearchHit[] = pageRows.map((r) => ({
    messageId: r.messageId,
    conversationId: r.conversationId,
    conversationTitle: titleMap.get(r.conversationId) ?? '会话',
    senderId: r.senderId,
    senderName: r.senderName,
    type: r.type,
    snippet: buildSnippet(r.text ?? '', keyword),
    seq: r.seq,
    createdAt: r.createdAt,
  }));

  // 总数：单独查一次，比把全部行拉回来再计数省内存得多
  const totalRows = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(messages)
    .where(and(...conditions));

  const last = pageRows[pageRows.length - 1];

  return {
    hits,
    total: Number(totalRows[0]?.c ?? 0),
    hasMore,
    nextCursor: hasMore && last ? String(last.createdAt) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                 */
/* ------------------------------------------------------------------ */

/** 批量取会话展示标题 */
async function loadConversationTitles(
  userId: string,
  conversationIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (conversationIds.length === 0) return out;

  const convRows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
    })
    .from(conversations)
    .where(inArray(conversations.id, conversationIds));

  const directIds = convRows.filter((c) => c.type === 'direct').map((c) => c.id);

  const peerMap = new Map<string, string>();
  if (directIds.length > 0) {
    const peerRows = await db
      .select({
        conversationId: conversationMembers.conversationId,
        nickname: users.nickname,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(
        and(
          inArray(conversationMembers.conversationId, directIds),
          sql`${conversationMembers.userId} <> ${userId}`,
          isNull(conversationMembers.leftAt),
        ),
      );
    for (const p of peerRows) peerMap.set(p.conversationId, p.nickname);
  }

  for (const c of convRows) {
    out.set(c.id, c.type === 'direct' ? (peerMap.get(c.id) ?? '私聊') : (c.title ?? '群聊'));
  }

  return out;
}

/**
 * 构造命中片段
 * 说明：服务端已经知道关键词，直接把命中处包上控制字符，
 *      客户端按 \u0002 / \u0003 切分即可高亮，
 *      不用在前端再做一次字符串匹配（省客户端 CPU）。
 */
function buildSnippet(text: string, keyword: string): string {
  if (!text) return '';

  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  const idx = lowerText.indexOf(lowerKw);

  if (idx < 0) {
    // FULLTEXT 可能是分词命中（不是完整子串），退化为展示开头
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  // 命中词前后各留 20 字上下文
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + keyword.length + 20);

  const before = text.slice(start, idx);
  const hit = text.slice(idx, idx + keyword.length);
  const after = text.slice(idx + keyword.length, end);

  return `${start > 0 ? '…' : ''}${before}${HL_START}${hit}${HL_END}${after}${end < text.length ? '…' : ''}`;
}
