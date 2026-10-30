ALTER TABLE `attachments` ADD `expires_at` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attachments` ADD `expired_at` bigint;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD `updated_at` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `updated_at` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_attachments_expires` ON `attachments` (`expired_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_members_updated` ON `conversation_members` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_updated` ON `conversations` (`updated_at`);--> statement-breakpoint
-- 全文索引必须用 FULLTEXT + ngram 分词器，否则中文检索无效
-- （MySQL 默认分词按空格切，中文整句会变成一个 token）
-- 需要 MySQL 配置 ngram_token_size=2（默认值，无需改动）
ALTER TABLE `messages` ADD FULLTEXT `ft_messages_text` (`text`) WITH PARSER ngram;

--> statement-breakpoint
-- 存量数据回填：把 updated_at 初始化为已有时间戳
-- 否则新加的列默认 0，增量同步会漏掉历史会话
UPDATE `conversations` SET `updated_at` = COALESCE(`last_message_at`, `created_at`) WHERE `updated_at` = 0;
--> statement-breakpoint
UPDATE `conversation_members` SET `updated_at` = `joined_at` WHERE `updated_at` = 0;
--> statement-breakpoint
-- 存量附件：expires_at 默认 0 会让 toAttachmentDto 回退到 createdAt + TTL，
-- 这里直接算好，保证清理任务能正常扫到
UPDATE `attachments` SET `expires_at` = `created_at` + 2592000000 WHERE `expires_at` = 0;
