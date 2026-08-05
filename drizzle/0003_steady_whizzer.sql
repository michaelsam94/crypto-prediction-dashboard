CREATE TABLE `fear_greed` (
	`id` int AUTO_INCREMENT NOT NULL,
	`day` bigint NOT NULL,
	`value` int NOT NULL,
	`classification` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fear_greed_id` PRIMARY KEY(`id`),
	CONSTRAINT `fear_greed_day_unique` UNIQUE(`day`)
);
--> statement-breakpoint
CREATE TABLE `funding_rates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`fundingTime` bigint NOT NULL,
	`fundingRate` double NOT NULL,
	`markPrice` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `funding_rates_id` PRIMARY KEY(`id`),
	CONSTRAINT `funding_symbol_time_idx` UNIQUE(`symbol`,`fundingTime`)
);
--> statement-breakpoint
CREATE TABLE `open_interest` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`ts` bigint NOT NULL,
	`openInterest` double NOT NULL,
	`openInterestValue` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `open_interest_id` PRIMARY KEY(`id`),
	CONSTRAINT `oi_symbol_ts_idx` UNIQUE(`symbol`,`ts`)
);
