-- ============================================================
-- 回填存量数据的 updated_at
-- ------------------------------------------------------------
-- 背景：updated_at 是增量同步上线时新增的字段，默认 0。
-- 而增量条件是 updated_at > since，对老数据（=0）永远不成立，
-- 会导致客户端增量同步永远看不到这些会话。
--
-- 回填策略：用该行已有的时间信息推算，而不是统一写 now()。
-- 统一写 now() 的坏处是「所有老数据看起来都在同一时刻变化」，
-- 客户端第二次同步会白拉一遍全量。
--
-- 正确做法：
--   conversations.updated_at      = COALESCE(last_message_at, created_at)
--   conversation_members.updated_at = joined_at
-- 两者都取「最后一次真实变化的时间」，语义正确且能保持增量有效性。
-- ============================================================

UPDATE `conversations`
SET `updated_at` = COALESCE(`last_message_at`, `created_at`)
WHERE `updated_at` = 0;
--> statement-breakpoint

UPDATE `conversation_members`
SET `updated_at` = `joined_at`
WHERE `updated_at` = 0;
--> statement-breakpoint

-- 附件过期时间回填：存量附件按「上传时间 + 30 天」计算
-- 30 天 = 2592000000 毫秒
UPDATE `attachments`
SET `expires_at` = `created_at` + 2592000000
WHERE `expires_at` = 0;
