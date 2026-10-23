CREATE TABLE IF NOT EXISTS assistant_automation_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('wechat', 'schedule')),
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_automation_task_settings (
  task_id TEXT PRIMARY KEY NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0,
  notify_channel_id TEXT,
  notify_version INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_automation_task_slots (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','stopped','interrupted','missed')),
  session_id TEXT,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS automation_task_slot_unique ON assistant_automation_task_slots(task_id, slot);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS automation_task_slot_state ON assistant_automation_task_slots(state);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS automation_task_single_active ON assistant_automation_task_slots(task_id) WHERE state IN ('queued','running');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_automation_files (
  delivery_id INTEGER PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_automation_inputs (
  run_id TEXT PRIMARY KEY NOT NULL,
  paths TEXT NOT NULL
);
