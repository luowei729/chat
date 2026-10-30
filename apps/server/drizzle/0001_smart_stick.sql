CREATE TABLE `contact_remarks` (
	`owner_id` varchar(26) NOT NULL,
	`target_id` varchar(26) NOT NULL,
	`remark` varchar(32) NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `contact_remarks_owner_id_target_id_pk` PRIMARY KEY(`owner_id`,`target_id`)
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`user_id` varchar(26) NOT NULL,
	`friend_id` varchar(26) NOT NULL,
	`status` varchar(10) NOT NULL,
	`requester_id` varchar(26) NOT NULL,
	`created_at` bigint NOT NULL,
	`accepted_at` bigint,
	CONSTRAINT `friendships_user_id_friend_id_pk` PRIMARY KEY(`user_id`,`friend_id`)
);
--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_id` varchar(26) NOT NULL,
	`user_id` varchar(26) NOT NULL,
	`emoji` varchar(8) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `message_reactions_message_id_user_id_emoji_pk` PRIMARY KEY(`message_id`,`user_id`,`emoji`)
);
--> statement-breakpoint
CREATE INDEX `idx_friendships_user` ON `friendships` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_friendships_friend` ON `friendships` (`friend_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_reactions_message` ON `message_reactions` (`message_id`);