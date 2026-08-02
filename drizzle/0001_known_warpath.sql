CREATE TABLE `candles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`openTime` bigint NOT NULL,
	`closeTime` bigint NOT NULL,
	`open` double NOT NULL,
	`high` double NOT NULL,
	`low` double NOT NULL,
	`close` double NOT NULL,
	`volume` double NOT NULL,
	`quoteVolume` double NOT NULL,
	`trades` int NOT NULL DEFAULT 0,
	`takerBuyBase` double NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `candles_id` PRIMARY KEY(`id`),
	CONSTRAINT `candles_symbol_openTime_idx` UNIQUE(`symbol`,`openTime`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`job` varchar(64) NOT NULL,
	`status` enum('running','success','error') NOT NULL DEFAULT 'running',
	`detail` text,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `job_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`algorithm` varchar(32) NOT NULL DEFAULT 'gradient_boosting',
	`modelVersion` varchar(64) NOT NULL,
	`payload` text NOT NULL,
	`trainSamples` int NOT NULL DEFAULT 0,
	`validationAccuracy` double,
	`highConfidenceAccuracy` double,
	`confidenceThreshold` double NOT NULL DEFAULT 0.5,
	`featureNames` text,
	`trainedThroughOpenTime` bigint,
	`trainedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `models_id` PRIMARY KEY(`id`),
	CONSTRAINT `models_symbol_unique` UNIQUE(`symbol`)
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`targetOpenTime` bigint NOT NULL,
	`basisOpenTime` bigint NOT NULL,
	`direction` enum('LONG','SHORT') NOT NULL,
	`confidence` double NOT NULL,
	`probUp` double NOT NULL,
	`basisClose` double NOT NULL,
	`outcome` enum('pending','win','loss','flat') NOT NULL DEFAULT 'pending',
	`resolvedClose` double,
	`realizedChangePct` double,
	`modelVersion` varchar(64),
	`features` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	CONSTRAINT `predictions_id` PRIMARY KEY(`id`),
	CONSTRAINT `predictions_symbol_target_idx` UNIQUE(`symbol`,`targetOpenTime`)
);
--> statement-breakpoint
CREATE INDEX `candles_openTime_idx` ON `candles` (`openTime`);--> statement-breakpoint
CREATE INDEX `job_runs_job_started_idx` ON `job_runs` (`job`,`startedAt`);--> statement-breakpoint
CREATE INDEX `predictions_symbol_created_idx` ON `predictions` (`symbol`,`targetOpenTime`);--> statement-breakpoint
CREATE INDEX `predictions_outcome_idx` ON `predictions` (`outcome`);