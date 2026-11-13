//! The queue: one post per idempotency key, leases, retries, and demo publishing end to end.
mod common;
use common::*;
use publisher_core::db::Platform;
use publisher_core::jobs::{self, NewTarget, MAX_ATTEMPTS};
use publisher_core::{runner, App, Endpoints};
use serde_json::json;

fn app() -> std::sync::Arc<App> {
	App::for_tests(Endpoints::default())
}

#[tokio::test]
async fn the_same_idempotency_key_never_creates_a_second_post() {
	let app = app();
	let m = seed_media(&app, 1024);
	let a = seed_account(&app, Platform::Youtube, true);
	let t = || vec![NewTarget { account_id: a.id.clone(), platform: "youtube".into(), settings: json!({}) }];
	let (first, dup1) = jobs::create_post(&app, "same-key-123", &m, "hi", true, &t(), None).unwrap();
	let (second, dup2) = jobs::create_post(&app, "same-key-123", &m, "hi again", true, &t(), None).unwrap();
	assert_eq!(first, second);
	assert!(!dup1 && dup2);
	let posts: i64 = app.db().query_row("SELECT COUNT(*) FROM posts", [], |r| r.get(0)).unwrap();
	let targets: i64 = app.db().query_row("SELECT COUNT(*) FROM targets", [], |r| r.get(0)).unwrap();
	assert_eq!((posts, targets), (1, 1));
}

#[tokio::test]
async fn demo_publishing_finishes_each_destination_and_never_shows_a_link() {
	let app = app();
	let m = seed_media(&app, 1024);
	let targets: Vec<NewTarget> = [Platform::Tiktok, Platform::Instagram, Platform::Youtube]
		.into_iter()
		.map(|p| NewTarget { account_id: seed_account(&app, p, true).id, platform: p.as_str().into(), settings: json!({ "title": "T", "privacy": "private", "madeForKids": false }) })
		.collect();
	let (post, _) = jobs::create_post(&app, "demo-key-1234", &m, "hello", true, &targets, None).unwrap();
	assert_eq!(runner::tick(&app, "w", 3).await, 3);
	let view = jobs::post_view(&app, &post).unwrap();
	assert_eq!(view["done"], true);
	assert_eq!(view["isDemo"], true);
	let state = |p: &str| view["targets"].as_array().unwrap().iter().find(|t| t["platform"] == p).unwrap().clone();
	assert_eq!(state("youtube")["state"], "published");
	assert_eq!(state("instagram")["state"], "published");
	// TikTok only reaches the inbox, so it is never reported as published.
	assert_eq!(state("tiktok")["state"], "needs_attention");
	for t in view["targets"].as_array().unwrap() {
		assert!(t["permalink"].is_null(), "a simulated post must not have a link");
		assert_eq!(t["account"]["isDemo"], true);
	}
	assert_eq!(jobs::active_jobs(&app), 0);
}

#[tokio::test]
async fn a_transient_failure_is_retried_and_only_failed_destinations_can_be_retried() {
	let app = app();
	let (post, flaky, _) = new_target(&app, Platform::Instagram, true, "try #flaky", json!({}));
	runner::tick(&app, "w", 3).await;
	let t = target(&app, &flaky);
	assert_eq!((t.state.as_str(), t.attempts), ("queued", 1));
	assert!(t.error.unwrap().contains("Simulated network hiccup"));
	assert!(t.next_run_at > publisher_core::util::now_ms());
	let t = run_again(&app, &flaky).await;
	assert_eq!((t.state.as_str(), t.attempts), ("queued", 2));
	let t = run_again(&app, &flaky).await;
	assert_eq!(t.state, "published");
	// Nothing failed, so there is nothing to retry.
	assert!(jobs::retry_targets(&app, &post, None).is_empty());

	let (post2, failing, _) = new_target(&app, Platform::Tiktok, true, "this will #fail", json!({}));
	runner::tick(&app, "w", 3).await;
	let t = target(&app, &failing);
	assert_eq!(t.state, "failed");
	assert!(t.error.unwrap().contains("Simulated failure"));
	assert_eq!(jobs::retry_targets(&app, &post2, None), vec![failing.clone()]);
	assert_eq!(target(&app, &failing).state, "queued");
}

#[tokio::test]
async fn retries_stop_after_the_attempt_limit() {
	let app = app();
	let (_, id, _) = new_target(&app, Platform::Youtube, true, "x", json!({}));
	for n in 1..MAX_ATTEMPTS {
		assert!(jobs::schedule_retry(&app, &target(&app, &id), "network down", None));
		assert_eq!(target(&app, &id).attempts, n);
	}
	assert!(!jobs::schedule_retry(&app, &target(&app, &id), "network down", None));
	let t = target(&app, &id);
	assert_eq!(t.state, "failed");
	assert!(t.error.unwrap().contains("gave up after 5 attempts"));

	// If the platform may already have the post, giving up must not call it failed.
	let (_, id, _) = new_target(&app, Platform::Instagram, true, "x", json!({}));
	app.db().execute("UPDATE targets SET uncertain = 1, attempts = 4 WHERE id = ?", [&id]).unwrap();
	jobs::schedule_retry(&app, &target(&app, &id), "status check failed", None);
	let t = target(&app, &id);
	assert_eq!(t.state, "needs_attention");
	assert!(t.error.unwrap().contains("your Instagram profile"));
}

#[tokio::test]
async fn a_job_whose_worker_died_is_picked_up_again_and_flagged_to_check_first() {
	let app = app();
	let (_, id, _) = new_target(&app, Platform::Youtube, true, "x", json!({}));
	let t = jobs::claim_next(&app, "worker-a").unwrap();
	assert_eq!(t.id, id);
	// Leased: nobody else can take it.
	assert!(jobs::claim_next(&app, "worker-b").is_none());
	app.db().execute("UPDATE targets SET state = 'uploading', provider_ref = '{\"sessionUrl\":\"x\"}' WHERE id = ?", [&id]).unwrap();
	assert!(jobs::claim_next(&app, "worker-b").is_none());
	// The app restarts: stale leases are expired at once rather than after a minute.
	assert_eq!(jobs::expire_stale_leases(&app), 1);
	let again = jobs::claim_next(&app, "worker-b").unwrap();
	assert_eq!(again.id, id);
	assert!(again.uncertain);
}

#[tokio::test]
async fn quitting_hands_jobs_back_marked_to_check_first() {
	let app = app();
	let (_, started, _) = new_target(&app, Platform::Youtube, true, "x", json!({}));
	jobs::claim_next(&app, "w").unwrap();
	app.db().execute("UPDATE targets SET state = 'uploading', phase = 'upload' WHERE id = ?", [&started]).unwrap();
	let (_, untouched, _) = new_target(&app, Platform::Instagram, true, "y", json!({}));
	jobs::claim_next(&app, "w").unwrap();
	assert_eq!(jobs::release_leases(&app, "w"), 2);
	let a = target(&app, &started);
	assert_eq!((a.state.as_str(), a.uncertain), ("queued", true));
	let b = target(&app, &untouched);
	assert_eq!((b.state.as_str(), b.uncertain), ("queued", false));
	assert!(jobs::claim_next(&app, "next-launch").is_some());
}

#[tokio::test]
async fn old_videos_are_removed_only_when_every_destination_is_finished() {
	let app = app();
	let (_, id, _) = new_target(&app, Platform::Youtube, true, "x", json!({}));
	let media: String = app.db().query_row("SELECT media_id FROM posts", [], |r| r.get(0)).unwrap();
	let path: String = app.db().query_row("SELECT path FROM media WHERE id = ?", [&media], |r| r.get(0)).unwrap();
	app.db().execute("UPDATE media SET created_at = 0", []).unwrap();
	assert_eq!(runner::cleanup_media(&app), 0, "a queued destination still needs the file");
	assert!(std::path::Path::new(&path).exists());
	runner::tick(&app, "w", 3).await;
	assert_eq!(target(&app, &id).state, "published");
	assert_eq!(runner::cleanup_media(&app), 1);
	assert!(!std::path::Path::new(&path).exists());
}

#[tokio::test]
async fn a_scheduled_post_waits_for_its_time_and_can_be_moved_or_cancelled() {
	let app = app();
	let m = seed_media(&app, 1024);
	let a = seed_account(&app, Platform::Youtube, true);
	let b = seed_account(&app, Platform::Tiktok, true);
	let in_an_hour = publisher_core::util::now_ms() + 3_600_000;
	let targets = vec![
		NewTarget { account_id: a.id.clone(), platform: "youtube".into(), settings: json!({ "title": "T", "privacy": "private", "madeForKids": false }) },
		NewTarget { account_id: b.id.clone(), platform: "tiktok".into(), settings: json!({}) },
	];
	let (post, _) = jobs::create_post(&app, "scheduled-key-1", &m, "later", true, &targets, Some(in_an_hour)).unwrap();

	// Nothing is due yet, and the post says when it will go out.
	assert!(jobs::claim_next(&app, "w").is_none());
	let view = jobs::post_view(&app, &post).unwrap();
	assert_eq!((view["scheduled"].clone(), view["scheduledAt"].clone()), (json!(true), json!(in_an_hour)));
	assert!(view["targets"].as_array().unwrap().iter().all(|t| t["scheduled"] == true));
	// The video is kept while the post waits, even past the retention period.
	app.db().execute("UPDATE media SET created_at = 0", []).unwrap();
	assert_eq!(runner::cleanup_media(&app), 0);

	// Moving it to another time keeps it waiting; "publish now" makes it due at once.
	assert_eq!(jobs::reschedule(&app, &post, Some(in_an_hour * 2)), 2);
	assert!(jobs::claim_next(&app, "w").is_none());
	assert_eq!(jobs::reschedule(&app, &post, None), 2);
	assert_eq!(runner::tick(&app, "w", 3).await, 2);
	let view = jobs::post_view(&app, &post).unwrap();
	assert_eq!(view["scheduled"], false);
	// Once started, it can no longer be moved or cancelled.
	assert_eq!(jobs::reschedule(&app, &post, Some(in_an_hour)), 0);
	assert_eq!(jobs::cancel_scheduled(&app, &post), 0);

	// Cancelling ends the waiting destinations as failed, and Retry can still post them.
	let (later, _) = jobs::create_post(&app, "scheduled-key-2", &m, "never mind", true, &targets[..1], Some(in_an_hour)).unwrap();
	assert_eq!(jobs::cancel_scheduled(&app, &later), 1);
	let t = &jobs::post_view(&app, &later).unwrap()["targets"][0];
	assert_eq!(t["state"], "failed");
	assert!(t["error"].as_str().unwrap().contains("Cancelled"));
	assert_eq!(jobs::retry_targets(&app, &later, None).len(), 1);
	assert!(jobs::claim_next(&app, "w").is_some());
}
