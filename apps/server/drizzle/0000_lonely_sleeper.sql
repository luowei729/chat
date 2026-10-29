CREATE TABLE `attachments` (
	`id` varchar(26) NOT NULL,
	`uploader_id` varchar(26) NOT NULL,
	`kind` varchar(8) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`mime` varchar(128) NOT NULL,
	`size` bigint NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`storage_path` varchar(512) NOT NULL,
	`thumb_path` varchar(512),
	`width` int,
	`height` int,
	`duration_ms` int,
	`waveform` json,
	`message_id` varchar(26),
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` bigint NOT NULL,
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `call_participants` (
	`call_id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`state` varchar(12) NOT NULL,
	`joined_at` bigint,
	`left_at` bigint,
	CONSTRAINT `call_participants_call_id_user_id_pk` PRIMARY KEY(`call_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `call_sessions` (
	`id` varchar(26) NOT NULL,
	`conversation_id` varchar(26) NOT NULL,
	`mode` varchar(8) NOT NULL,
	`status` varchar(12) NOT NULL,
	`initiator_id` varchar(26) NOT NULL,
	`router_id` varchar(64),
	`started_at` bigint NOT NULL,
	`answered_at` bigint,
	`ended_at` bigint,
	`end_reason` varchar(16),
	CONSTRAINT `call_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`role` varchar(8) NOT NULL DEFAULT 'member',
	`last_read_seq` bigint NOT NULL DEFAULT 0,
	`pinned` boolean NOT NULL DEFAULT false,
	`muted` boolean NOT NULL DEFAULT false,
	`joined_at` bigint NOT NULL,
	`left_at` bigint,
	CONSTRAINT `conversation_members_conversation_id_user_id_pk` PRIMARY KEY(`conversation_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` varchar(26) NOT NULL,
	`type` varchar(8) NOT NULL,
	`title` varchar(64),
	`avatar_url` varchar(512),
	`owner_id` varchar(26),
	`direct_key` varchar(64),
	`last_seq` bigint NOT NULL DEFAULT 0,
	`last_message_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_conversations_direct` UNIQUE(`direct_key`)
);
--> statement-breakpoint
CREATE TABLE `email_codes` (
	`id` varchar(26) NOT NULL,
	`email` varchar(254) NOT NULL,
	`purpose` varchar(16) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`consumed_at` bigint,
	`expires_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`ip` varchar(45),
	CONSTRAINT `email_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`id` varchar(26) NOT NULL,
	`code` varchar(16) NOT NULL,
	`creator_id` varchar(26) NOT NULL,
	`max_uses` int NOT NULL DEFAULT 1,
	`used_count` int NOT NULL DEFAULT 0,
	`expires_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `invite_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_invite_codes_code` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `invite_usages` (
	`id` varchar(26) NOT NULL,
	`invite_code_id` varchar(26) NOT NULL,
	`invitee_id` varchar(26) NOT NULL,
	`inviter_id` varchar(26) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `invite_usages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_invite_usages_invitee` UNIQUE(`invitee_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(26) NOT NULL,
	`conversation_id` varchar(26) NOT NULL,
	`seq` bigint NOT NULL,
	`sender_id` varchar(26) NOT NULL,
	`client_id` varchar(40),
	`type` varchar(8) NOT NULL,
	`text` text,
	`reply_to_id` varchar(26),
	`created_at` bigint NOT NULL,
	`edited_at` bigint,
	`deleted_at` bigint,
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_messages_seq` UNIQUE(`conversation_id`,`seq`),
	CONSTRAINT `uk_messages_client` UNIQUE(`conversation_id`,`sender_id`,`client_id`)
);
--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`platform` varchar(16) NOT NULL,
	`provider` varchar(16) NOT NULL,
	`device_id` varchar(128) NOT NULL,
	`token` varchar(512) NOT NULL,
	`app_version` varchar(32),
	`updated_at` bigint NOT NULL,
	CONSTRAINT `push_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_push_provider_token` UNIQUE(`provider`,`token`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`device_id` varchar(128) NOT NULL,
	`platform` varchar(16) NOT NULL,
	`device_name` varchar(64),
	`expires_at` bigint NOT NULL,
	`revoked_at` bigint,
	`created_at` bigint NOT NULL,
	`last_used_at` bigint NOT NULL,
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_refresh_tokens_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(26) NOT NULL,
	`email` varchar(254) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`password_hash` varchar(255) NOT NULL,
	`nickname` varchar(32) NOT NULL,
	`avatar_url` varchar(512),
	`bio` varchar(120),
	`invite_quota` int NOT NULL DEFAULT 0,
	`invited_by` varchar(26),
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` bigint NOT NULL,
	`last_seen_at` bigint,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_users_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_sha` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_attachments_uploader` ON `attachments` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `idx_call_participants_user` ON `call_participants` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_calls_conversation` ON `call_sessions` (`conversation_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_status` ON `call_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_members_user` ON `conversation_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_members_active` ON `conversation_members` (`user_id`,`left_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_last_message` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_email_codes_lookup` ON `email_codes` (`email`,`purpose`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_email_codes_expires` ON `email_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_invite_codes_creator` ON `invite_codes` (`creator_id`);--> statement-breakpoint
CREATE INDEX `idx_invite_usages_inviter` ON `invite_usages` (`inviter_id`);--> statement-breakpoint
CREATE INDEX `idx_invite_usages_code` ON `invite_usages` (`invite_code_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_conversation` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_messages_sender` ON `messages` (`sender_id`);--> statement-breakpoint
CREATE INDEX `idx_push_user` ON `push_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_tokens_user` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_refresh_tokens_device` ON `refresh_tokens` (`user_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_users_invited_by` ON `users` (`invited_by`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);