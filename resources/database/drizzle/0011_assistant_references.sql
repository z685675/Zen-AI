-- Rebuild the four child tables in the migration transaction. Foreign-key
-- enforcement is enabled after copying existing data, including legacy orphans.
CREATE TABLE assistant_rebuild_sessions (
  id text PRIMARY KEY NOT NULL,
  agent_type text NOT NULL,
  agent_id text NOT NULL,
  name text NOT NULL,
  description text,
  accessible_paths text,
  instructions text,
  model text NOT NULL,
  plan_model text,
  small_model text,
  mcps text,
  allowed_tools text,
  configuration text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  slash_commands text,
  sort_order integer NOT NULL DEFAULT 0,
  is_pinned integer NOT NULL DEFAULT false,
  is_archived integer NOT NULL DEFAULT false,
  CONSTRAINT fk_session_agent_id FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
INSERT INTO assistant_rebuild_sessions (id, agent_type, agent_id, name, description, accessible_paths, instructions, model, plan_model, small_model, mcps, allowed_tools, configuration, created_at, updated_at, slash_commands, sort_order, is_pinned, is_archived)
  SELECT id, agent_type, agent_id, name, description, accessible_paths, instructions, model, plan_model, small_model, mcps, allowed_tools, configuration, created_at, updated_at, slash_commands, sort_order, is_pinned, is_archived FROM sessions;
DROP TABLE sessions;
ALTER TABLE assistant_rebuild_sessions RENAME TO sessions;
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions (model);
CREATE INDEX IF NOT EXISTS idx_sessions_sort_order ON sessions (sort_order);
CREATE INDEX IF NOT EXISTS idx_sessions_is_pinned ON sessions (is_pinned);
CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions (is_archived);

CREATE TABLE assistant_rebuild_session_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  metadata text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  agent_session_id text DEFAULT '',
  CONSTRAINT fk_session_messages_session_id FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
INSERT INTO assistant_rebuild_session_messages (id, session_id, role, content, metadata, created_at, updated_at, agent_session_id)
  SELECT id, session_id, role, content, metadata, created_at, updated_at, agent_session_id FROM session_messages;
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'assistant_rebuild_session_messages', seq FROM sqlite_sequence
  WHERE name = 'session_messages' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'assistant_rebuild_session_messages');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'session_messages'), 0))
  WHERE name = 'assistant_rebuild_session_messages';
DROP TABLE session_messages;
ALTER TABLE assistant_rebuild_session_messages RENAME TO session_messages;
CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_created_at ON session_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_updated_at ON session_messages (updated_at);

CREATE TABLE assistant_rebuild_scheduled_tasks (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  schedule_type text NOT NULL,
  schedule_value text NOT NULL,
  timeout_minutes integer NOT NULL DEFAULT 60,
  next_run text,
  last_run text,
  last_result text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  model_id text,
  CONSTRAINT fk_scheduled_tasks_agent_id FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
INSERT INTO assistant_rebuild_scheduled_tasks (id, agent_id, name, prompt, schedule_type, schedule_value, timeout_minutes, next_run, last_run, last_result, status, created_at, updated_at, model_id)
  SELECT id, agent_id, name, prompt, schedule_type, schedule_value, timeout_minutes, next_run, last_run, last_result, status, created_at, updated_at, model_id FROM scheduled_tasks;
DROP TABLE scheduled_tasks;
ALTER TABLE assistant_rebuild_scheduled_tasks RENAME TO scheduled_tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON scheduled_tasks (agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks (next_run);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks (status);

CREATE TABLE assistant_rebuild_task_run_logs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  task_id text NOT NULL,
  session_id text,
  run_at text NOT NULL,
  duration_ms integer NOT NULL,
  status text NOT NULL,
  result text,
  error text,
  model_id text,
  trigger_type text NOT NULL DEFAULT 'scheduled',
  scheduled_for text,
  CONSTRAINT fk_task_run_logs_task_id FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);
INSERT INTO assistant_rebuild_task_run_logs (id, task_id, session_id, run_at, duration_ms, status, result, error, model_id, trigger_type, scheduled_for)
  SELECT id, task_id, session_id, run_at, duration_ms, status, result, error, model_id, trigger_type, scheduled_for FROM task_run_logs;
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'assistant_rebuild_task_run_logs', seq FROM sqlite_sequence
  WHERE name = 'task_run_logs' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'assistant_rebuild_task_run_logs');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'task_run_logs'), 0))
  WHERE name = 'assistant_rebuild_task_run_logs';
DROP TABLE task_run_logs;
ALTER TABLE assistant_rebuild_task_run_logs RENAME TO task_run_logs;
CREATE INDEX IF NOT EXISTS idx_task_run_logs_task_id ON task_run_logs (task_id);
