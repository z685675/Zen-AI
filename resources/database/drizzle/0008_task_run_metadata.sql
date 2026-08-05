ALTER TABLE `task_run_logs` ADD `model_id` text;
ALTER TABLE `task_run_logs` ADD `trigger_type` text NOT NULL DEFAULT 'scheduled';
ALTER TABLE `task_run_logs` ADD `scheduled_for` text;
