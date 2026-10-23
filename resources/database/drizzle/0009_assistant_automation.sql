-- Additive and restart-safe: no legacy records, credentials or message tables are changed.
CREATE TABLE IF NOT EXISTS `assistant_automation_bindings` (
  `channel_id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `peer_id` text NOT NULL,
  `session_id` text NOT NULL,
  `version` integer NOT NULL CHECK (`version` > 0),
  `enabled` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `automation_active_session_idx`
  ON `assistant_automation_bindings` (`session_id`) WHERE `enabled` = 1;
CREATE UNIQUE INDEX IF NOT EXISTS `automation_active_peer_idx`
  ON `assistant_automation_bindings` (`account_id`, `peer_id`) WHERE `enabled` = 1;
CREATE TABLE IF NOT EXISTS `assistant_automation_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `source_key` text NOT NULL,
  `origin` text NOT NULL CHECK (`origin` IN ('wechat', 'desktop')),
  `channel_id` text NOT NULL,
  `binding_version` integer NOT NULL,
  `session_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('queued', 'running', 'completed', 'failed', 'stopped', 'interrupted')),
  `input` text NOT NULL,
  `result` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `automation_source_key_idx` ON `assistant_automation_runs` (`source_key`);
CREATE UNIQUE INDEX IF NOT EXISTS `automation_running_session_idx`
  ON `assistant_automation_runs` (`session_id`) WHERE `state` = 'running';
CREATE INDEX IF NOT EXISTS `automation_run_channel_idx` ON `assistant_automation_runs` (`channel_id`, `state`);
CREATE TABLE IF NOT EXISTS `assistant_automation_outbox` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `delivery_key` text NOT NULL,
  `run_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `account_id` text NOT NULL,
  `peer_id` text NOT NULL,
  `session_id` text NOT NULL,
  `binding_version` integer NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('user', 'assistant', 'notice')),
  `text` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('pending', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown', 'cancelled')),
  `attempts` integer NOT NULL DEFAULT 0,
  `lease` text,
  `reason` text,
  `next_attempt_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `automation_delivery_key_idx` ON `assistant_automation_outbox` (`delivery_key`);
CREATE INDEX IF NOT EXISTS `automation_outbox_channel_idx` ON `assistant_automation_outbox` (`channel_id`, `id`);
