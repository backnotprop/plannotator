CREATE TABLE `actors` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`host` text DEFAULT '' NOT NULL,
	`session` text DEFAULT '' NOT NULL,
	`name` text,
	`person_id` text,
	`external_ref` text,
	`created_at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `answers` (
	`id` text PRIMARY KEY,
	`question_id` text NOT NULL,
	`author_id` text NOT NULL,
	`via_actor_id` text,
	`answer` text,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`sent_reply_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`seq` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text NOT NULL,
	`message_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer,
	`sha256` text NOT NULL,
	`created_at` text,
	CONSTRAINT `attachments_pk` PRIMARY KEY(`message_id`, `id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL,
	`card` text NOT NULL,
	`heard_seq` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY,
	`at` text NOT NULL,
	`v` integer NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`project_id` text,
	`thread_id` text,
	`message_id` text,
	`actor_id` text,
	`data` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `initiatives` (
	`id` text PRIMARY KEY,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `mentions` (
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`target_actor_id` text NOT NULL,
	`label` text,
	`wakes` integer,
	`record` text NOT NULL,
	CONSTRAINT `mentions_pk` PRIMARY KEY(`message_id`, `position`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `message_tags` (
	`message_id` text NOT NULL,
	`tag_key` text NOT NULL,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`seq` integer NOT NULL,
	CONSTRAINT `message_tags_pk` PRIMARY KEY(`message_id`, `tag_key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`reply_to` text,
	`author_id` text NOT NULL,
	`via_actor_id` text,
	`created_at` text NOT NULL,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`root` text NOT NULL,
	`name` text NOT NULL,
	`record` text NOT NULL,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`deleted_at` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`thread_id` text,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`revision` integer NOT NULL,
	`sent_revision` integer NOT NULL,
	`current_answer_id` text,
	`sent_reply_id` text,
	`asked_by_actor_id` text,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `read_state` (
	`thread_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`seen_seq` integer,
	`read_seq` integer,
	`read_at` text,
	`seq` integer NOT NULL,
	CONSTRAINT `read_state_pk` PRIMARY KEY(`thread_id`, `actor_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY,
	`thread_id` text,
	`project_id` text,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `thread_names` (
	`root_id` text NOT NULL,
	`seq` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`routes` integer NOT NULL,
	CONSTRAINT `thread_names_pk` PRIMARY KEY(`root_id`, `seq`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `thread_pull_events` (
	`seq` integer PRIMARY KEY,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `thread_pulls` (
	`id` text PRIMARY KEY,
	`thread_id` text,
	`project_id` text,
	`first_seq` integer NOT NULL,
	`seq` integer NOT NULL,
	`record` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`thread_name` text,
	`resolved_at` text,
	`resolved_seq` integer,
	`readdressed` integer DEFAULT false NOT NULL,
	`first_seq` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`last_at` text NOT NULL,
	`message_count` integer NOT NULL,
	`seq` integer NOT NULL,
	`deleted_at` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_identity` ON `actors` (`kind`,`host`,`session`);--> statement-breakpoint
CREATE INDEX `annotations_thread` ON `annotations` (`thread_id`);--> statement-breakpoint
CREATE INDEX `annotations_seq` ON `annotations` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_author` ON `answers` (`question_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `answers_seq` ON `answers` (`seq`);--> statement-breakpoint
CREATE INDEX `attachments_sha` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `cards_project` ON `cards` (`project_id`);--> statement-breakpoint
CREATE INDEX `cards_seq` ON `cards` (`seq`);--> statement-breakpoint
CREATE INDEX `events_subject` ON `events` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `events_project` ON `events` (`project_id`);--> statement-breakpoint
CREATE INDEX `events_thread` ON `events` (`thread_id`);--> statement-breakpoint
CREATE INDEX `events_message` ON `events` (`message_id`);--> statement-breakpoint
CREATE INDEX `initiatives_seq` ON `initiatives` (`seq`);--> statement-breakpoint
CREATE INDEX `mentions_target` ON `mentions` (`target_actor_id`);--> statement-breakpoint
CREATE INDEX `message_tags_thread` ON `message_tags` (`thread_id`);--> statement-breakpoint
CREATE INDEX `message_tags_project` ON `message_tags` (`project_id`);--> statement-breakpoint
CREATE INDEX `message_tags_seq` ON `message_tags` (`seq`);--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`,`first_seq`);--> statement-breakpoint
CREATE INDEX `messages_seq` ON `messages` (`seq`);--> statement-breakpoint
CREATE INDEX `projects_key` ON `projects` (`key`);--> statement-breakpoint
CREATE INDEX `projects_seq` ON `projects` (`seq`);--> statement-breakpoint
CREATE INDEX `questions_message` ON `questions` (`message_id`);--> statement-breakpoint
CREATE INDEX `questions_thread` ON `questions` (`thread_id`);--> statement-breakpoint
CREATE INDEX `questions_seq` ON `questions` (`seq`);--> statement-breakpoint
CREATE INDEX `steps_thread` ON `steps` (`thread_id`);--> statement-breakpoint
CREATE INDEX `steps_project` ON `steps` (`project_id`);--> statement-breakpoint
CREATE INDEX `steps_seq` ON `steps` (`seq`);--> statement-breakpoint
CREATE INDEX `thread_names_project` ON `thread_names` (`project_id`);--> statement-breakpoint
CREATE INDEX `thread_names_seq` ON `thread_names` (`seq`);--> statement-breakpoint
CREATE INDEX `thread_pull_events_thread` ON `thread_pull_events` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_pull_events_project` ON `thread_pull_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `thread_pulls_thread` ON `thread_pulls` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_pulls_project` ON `thread_pulls` (`project_id`);--> statement-breakpoint
CREATE INDEX `thread_pulls_seq` ON `thread_pulls` (`seq`);--> statement-breakpoint
CREATE INDEX `threads_project` ON `threads` (`project_id`);--> statement-breakpoint
CREATE INDEX `threads_last` ON `threads` (`last_seq`);--> statement-breakpoint
CREATE INDEX `threads_seq` ON `threads` (`seq`);