-- ============================================================
-- 消息「仅删除自己可见」
-- ------------------------------------------------------------
-- 与 messages.deleted_at（撤回）互补：
--   撤回 = 对所有成员失效，客户端显示「撤回了一条消息」
--   删除 = 只对操作者隐藏，其他成员照常看到
--
-- 主键 (message_id, user_id) 保证重复删除幂等；
-- idx_hides_user 让「按用户过滤」的列表查询走索引。
-- ============================================================

CREATE TABLE IF NOT EXISTS `message_hides` (
  `message_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `created_at` bigint NOT NULL,
  PRIMARY KEY (`message_id`, `user_id`),
  KEY `idx_hides_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
