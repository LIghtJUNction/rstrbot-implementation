//! Durable calendar intentions. A database CAS claims a slot before execution;
//! an uncertain dispatch is never turned into a new pending job on restart.
use crate::{
    engine::{self, ChatRequest},
    state::{AppError, AppState},
};
use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use rstrbot_store::{Resource, Role, Store, User};
use serde_json::{Value, json};
use std::{str::FromStr, time::Duration};

const MISFIRE_GRACE_SECONDS: i64 = 30;
const MAX_DISPATCHES_PER_TICK: usize = 4;
const PROTECTED_FIELDS: &[&str] = &[
    "status",
    "claim_id",
    "claimed_at",
    "scheduled_for",
    "run_id",
    "last_run",
    "last_error",
    "last_result",
];

fn required<'a>(data: &'a Value, key: &str, limit: usize) -> Result<&'a str, AppError> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= limit)
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "{key} is required and must be at most {limit} bytes"
            ))
        })
}
fn timestamp(value: &Value) -> Result<i64, AppError> {
    let seconds = if let Some(seconds) = value.as_i64() {
        seconds
    } else if let Some(text) = value.as_str() {
        DateTime::parse_from_rfc3339(text)
            .map_err(|_| {
                AppError::bad_request(
                    "Timestamp requires Unix seconds or RFC3339 with an explicit offset",
                )
            })?
            .timestamp()
    } else {
        return Err(AppError::bad_request(
            "Timestamp requires Unix seconds or RFC3339",
        ));
    };
    if !(0..=4_102_444_800).contains(&seconds) {
        return Err(AppError::bad_request(
            "Schedule timestamp is outside 1970–2100",
        ));
    }
    Ok(seconds)
}
fn calendar(data: &Value) -> Result<(Schedule, Tz), AppError> {
    let expression = required(data, "cron", 128)?;
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if !(6..=7).contains(&fields.len())
        || fields
            .first()
            .is_none_or(|value| value.parse::<u32>().map_or(true, |second| second > 59))
    {
        return Err(AppError::bad_request(
            "Calendar schedules need six or seven fields and one fixed second (0–59); maximum frequency is once a minute",
        ));
    }
    let schedule = Schedule::from_str(expression)
        .map_err(|_| AppError::bad_request("Invalid calendar expression"))?;
    let zone = Tz::from_str(required(data, "timezone", 100)?)
        .map_err(|_| AppError::bad_request("Use a valid IANA time zone, such as Asia/Taipei"))?;
    Ok((schedule, zone))
}

/// Return the next planned UTC second strictly after `now`.
///
/// DST gaps are skipped. A repeated local time uses its first occurrence only;
/// this avoids creating a second side effect when clocks move backwards.
pub fn next_due(data: &Value, now: i64) -> Result<Option<i64>, AppError> {
    let kind = required(data, "schedule_type", 16)?;
    match kind {
        "once" => {
            let at =
                timestamp(data.get("at").ok_or_else(|| {
                    AppError::bad_request("at is required for a one-time schedule")
                })?)?;
            Ok((at > now).then_some(at))
        }
        "interval" => {
            let interval = data
                .get("interval_seconds")
                .and_then(Value::as_i64)
                .filter(|value| (60..=31_536_000).contains(value))
                .ok_or_else(|| {
                    AppError::bad_request("Interval must be between 60 seconds and one year")
                })?;
            let anchor = data
                .get("start_at")
                .map(timestamp)
                .transpose()?
                .unwrap_or(now);
            if anchor > now {
                return Ok(Some(anchor));
            }
            let elapsed = now
                .checked_sub(anchor)
                .ok_or_else(|| AppError::bad_request("Invalid interval anchor"))?;
            let steps = elapsed
                .checked_div(interval)
                .and_then(|value| value.checked_add(1))
                .ok_or_else(|| AppError::bad_request("Interval overflow"))?;
            let next = steps
                .checked_mul(interval)
                .and_then(|value| anchor.checked_add(value))
                .ok_or_else(|| AppError::bad_request("Interval overflow"))?;
            Ok(Some(next))
        }
        "cron" => {
            let (schedule, zone) = calendar(data)?;
            let now = DateTime::<Utc>::from_timestamp(now, 0)
                .ok_or_else(|| AppError::bad_request("Invalid reference timestamp"))?;
            let local = now.with_timezone(&zone);
            // The expression allows only one second per minute. The bound
            // covers even unusually large historical timezone folds.
            for candidate in schedule.after(&local).take(2_882) {
                if candidate.timestamp() <= now.timestamp() {
                    continue;
                }
                if zone
                    .from_local_datetime(&candidate.naive_local())
                    .earliest()
                    .is_some_and(|first| first.timestamp() == candidate.timestamp())
                {
                    return Ok(Some(candidate.timestamp()));
                }
            }
            Ok(None)
        }
        _ => Err(AppError::bad_request(
            "schedule_type must be once, interval or cron",
        )),
    }
}

/// Validate user configuration. Operational fields are created by the server;
/// API updates must preserve them from the stored resource while work is active.
pub fn validate(data: Value) -> Result<Value, AppError> {
    if !data.is_object() {
        return Err(AppError::bad_request("Schedule data must be an object"));
    }
    required(&data, "title", 200)?;
    required(&data, "prompt", 16_384)?;
    required(&data, "model_id", 128)?;
    required(&data, "conversation_id", 128)?;
    if let Some(value) = data.get("agent_id")
        && !value.is_null()
        && value
            .as_str()
            .is_none_or(|value| value.is_empty() || value.len() > 128)
    {
        return Err(AppError::bad_request("agent_id is invalid"));
    }
    if data
        .get("missed_policy")
        .and_then(Value::as_str)
        .is_some_and(|policy| policy != "skip")
    {
        return Err(AppError::bad_request(
            "This version supports only missed_policy=skip",
        ));
    }
    if data.get("enabled").is_some_and(|value| !value.is_boolean()) {
        return Err(AppError::bad_request("enabled must be true or false"));
    }
    let mut clean = json!({});
    for key in [
        "title",
        "prompt",
        "model_id",
        "conversation_id",
        "agent_id",
        "schedule_type",
        "at",
        "interval_seconds",
        "start_at",
        "cron",
        "timezone",
        "enabled",
    ] {
        if let Some(value) = data.get(key) {
            clean[key] = value.clone();
        }
    }
    clean["enabled"] = data.get("enabled").cloned().unwrap_or(Value::Bool(true));
    clean["missed_policy"] = "skip".into();
    clean["misfire_grace_seconds"] = MISFIRE_GRACE_SECONDS.into();
    clean["dst_policy"] = "first_occurrence_skip_gaps".into();
    if clean.get("timezone").is_none() {
        clean["timezone"] = "UTC".into();
    }
    let now = rstrbot_store::now();
    if clean["schedule_type"] == "interval" && clean.get("start_at").is_none() {
        clean["start_at"] = now.into();
    }
    if clean["schedule_type"] == "once" {
        clean["at"] = timestamp(clean.get("at").unwrap_or(&Value::Null))?.into();
    }
    let next = next_due(&clean, now)?;
    clean["next_run"] = json!(next);
    clean["status"] = if !clean["enabled"].as_bool().unwrap_or(false) {
        "paused"
    } else if next.is_some() {
        "scheduled"
    } else {
        "completed"
    }
    .into();
    if next.is_none() {
        clean["enabled"] = false.into();
    }
    Ok(clean)
}

/// Preview uses the same time function as the scheduler, including DST policy.
pub fn preview(data: Value) -> Result<Value, AppError> {
    let configured = validate(data)?;
    let mut cursor = rstrbot_store::now();
    let mut next = Vec::new();
    for _ in 0..5 {
        let Some(at) = next_due(&configured, cursor)? else {
            break;
        };
        next.push(at);
        cursor = at;
    }
    Ok(
        json!({"next_runs":next,"next_run":next.first(),"timezone":configured["timezone"],
        "missed_policy":"skip","misfire_grace_seconds":MISFIRE_GRACE_SECONDS,"dst_policy":"first_occurrence_skip_gaps"}),
    )
}

fn in_progress(data: &Value) -> bool {
    matches!(
        data.get("status").and_then(Value::as_str),
        Some("dispatching" | "running" | "queued")
    )
}
fn uncertain(data: &Value) -> bool {
    matches!(
        data.get("status").and_then(Value::as_str),
        Some("unknown" | "needs_reconciliation")
    )
}

async fn claim(
    store: &Store,
    user: &User,
    schedule: &Resource,
    scheduled_for: i64,
    manual: bool,
) -> Result<Resource, AppError> {
    if schedule.kind != "schedules" || schedule.owner_id != user.id {
        return Err(AppError::forbidden());
    }
    store
        .require_role(&schedule.workspace_id, &user.id, Role::Member)
        .await?;
    if in_progress(&schedule.data) || uncertain(&schedule.data) {
        return Err(AppError::conflict(
            "This schedule has an in-flight or uncertain operation; reconcile it before starting another",
        ));
    }
    let mut data = schedule.data.clone();
    let claim_id = if manual {
        format!("manual:{}:{}", schedule.id, uuid::Uuid::new_v4())
    } else {
        format!("schedule:{}:{scheduled_for}", schedule.id)
    };
    data["status"] = "dispatching".into();
    data["claim_id"] = claim_id.into();
    data["claimed_at"] = rstrbot_store::now().into();
    data["scheduled_for"] = scheduled_for.into();
    data["run_id"] = Value::Null;
    data["last_error"] = Value::Null;
    data["next_run"] = json!(next_due(&data, rstrbot_store::now())?);
    Ok(store
        .update_resource(
            &schedule.workspace_id,
            &user.id,
            &schedule.id,
            schedule.version,
            data,
        )
        .await?)
}

async fn dispatch(
    state: AppState,
    user: User,
    schedule: Resource,
    scheduled_for: i64,
    manual: bool,
) -> Result<Value, AppError> {
    let store = state.store().await;
    if store.recovery_mode().await? {
        return Err(AppError::conflict(
            "Restore recovery mode pauses scheduled side effects",
        ));
    }
    if state.shutdown.is_cancelled() {
        return Err(AppError::conflict("The service is stopping"));
    }
    let claimed = claim(&store, &user, &schedule, scheduled_for, manual).await?;
    // Membership and resource access are checked again by engine::start. The
    // claim remains persisted even if the process dies in the following gap.
    let request = ChatRequest {
        conversation_id: required(&claimed.data, "conversation_id", 128)?.into(),
        content: required(&claimed.data, "prompt", 16_384)?.into(),
        model_id: required(&claimed.data, "model_id", 128)?.into(),
        idempotency_key: required(&claimed.data, "claim_id", 200)?.into(),
        agent_id: claimed
            .data
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    match engine::start(state, user, claimed.workspace_id.clone(), request).await {
        Ok(result) => {
            let run_id = result.pointer("/run/id").and_then(Value::as_str);
            let mut data = claimed.data.clone();
            data["run_id"] = json!(run_id);
            data["last_run"] = rstrbot_store::now().into();
            data["status"] = if run_id.is_some() {
                "running"
            } else {
                "needs_reconciliation"
            }
            .into();
            if run_id.is_none() {
                data["enabled"] = false.into();
                data["last_error"]="Engine accepted the request without a readable run receipt; reconcile before retrying".into();
            }
            // A concurrent edit must not be overwritten. The immutable event
            // still records the accepted receipt for later reconciliation.
            store.internal_append_event(&claimed.id,"schedule.dispatched",json!({"claim_id":claimed.data["claim_id"],"run_id":run_id,"scheduled_for":scheduled_for})).await?;
            let updated = store
                .internal_update_resource(&claimed.id, claimed.version, data)
                .await;
            if updated.is_err() {
                return Err(AppError::conflict(
                    "The request was accepted but its schedule changed; inspect the run receipt before retrying",
                ));
            }
            Ok(result)
        }
        Err(error) => {
            // An error does not prove that engine admission or persistence made
            // no progress. Freeze the claim instead of replaying it silently.
            let mut data = claimed.data;
            data["status"] = "needs_reconciliation".into();
            data["enabled"] = false.into();
            data["last_error"] = format!(
                "Dispatch did not return a reliable receipt ({}); inspect runs before retrying",
                error.code
            )
            .into();
            let _ = store
                .internal_update_resource(&claimed.id, claimed.version, data)
                .await;
            Err(error)
        }
    }
}

/// Explicit owner action starts a fresh manual intention. An unresolved old
/// claim blocks it so that a convenient retry cannot duplicate an unknown write.
pub async fn trigger(state: AppState, user: &User, wid: &str, id: &str) -> Result<Value, AppError> {
    let store = state.store().await;
    let schedule = store.get_resource(wid, &user.id, id).await?;
    dispatch(state, user.clone(), schedule, rstrbot_store::now(), true).await
}

async fn recover_claims(store: &Store) -> Result<(), AppError> {
    let mut cursor = None;
    loop {
        let page = store
            .internal_list_page("schedules", cursor.as_ref(), 128)
            .await?;
        for schedule in page.items {
            if !in_progress(&schedule.data) {
                continue;
            }
            let mut data = schedule.data;
            data["status"] = "needs_reconciliation".into();
            data["enabled"] = false.into();
            data["last_error"]="Service restarted with an in-flight schedule. Its previous intent is preserved; verify its run before resuming.".into();
            match store
                .internal_update_resource(&schedule.id, schedule.version, data)
                .await
            {
                Ok(_)
                | Err(rstrbot_store::Error::Conflict)
                | Err(rstrbot_store::Error::NotFound) => {}
                Err(error) => return Err(error.into()),
            }
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    Ok(())
}

async fn refresh_running(store: &Store, schedule: &Resource) -> Result<(), AppError> {
    let Some(id) = schedule.data.get("run_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let run = store
        .get_resource(&schedule.workspace_id, &schedule.owner_id, id)
        .await?;
    let status = run
        .data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if matches!(
        status,
        "queued" | "running" | "preparing" | "streaming" | "waiting"
    ) {
        return Ok(());
    }
    let mut data = schedule.data.clone();
    data["last_result"] = json!({"run_id":id,"status":status});
    if matches!(status, "unknown" | "needs_reconciliation" | "interrupted") {
        data["status"] = "needs_reconciliation".into();
        data["enabled"] = false.into();
        data["last_error"] =
            "The run has an uncertain outcome; review its receipts before resuming this schedule"
                .into();
    } else {
        let next = next_due(&data, rstrbot_store::now())?;
        data["next_run"] = json!(next);
        if next.is_none() {
            data["enabled"] = false.into();
        }
        data["status"] = if data["enabled"] == true {
            "scheduled"
        } else if next.is_none() {
            match status {
                "failed" => "failed",
                "cancelled" => "cancelled",
                _ => "completed",
            }
        } else {
            "paused"
        }
        .into();
    }
    store
        .internal_update_resource(&schedule.id, schedule.version, data)
        .await?;
    Ok(())
}

async fn tick(state: &AppState) -> Result<(), AppError> {
    let store = state.store().await;
    if !store.initialized().await? || store.recovery_mode().await? {
        return Ok(());
    }
    let now = rstrbot_store::now();
    let mut dispatched = 0;
    let mut cursor = None;
    loop {
        let page = store
            .internal_list_page("schedules", cursor.as_ref(), 128)
            .await?;
        for schedule in page.items {
            if state.shutdown.is_cancelled() {
                return Ok(());
            }
            if in_progress(&schedule.data) {
                if let Err(error) = refresh_running(&store, &schedule).await {
                    tracing::warn!(schedule_id=%schedule.id,code=%error.code,"schedule receipt refresh deferred");
                }
                continue;
            }
            if uncertain(&schedule.data) || schedule.data.get("enabled") != Some(&Value::Bool(true))
            {
                continue;
            }
            let Some(due) = schedule.data.get("next_run").and_then(Value::as_i64) else {
                continue;
            };
            if due > now {
                continue;
            }
            if now.saturating_sub(due) > MISFIRE_GRACE_SECONDS {
                let mut data = schedule.data;
                let next = next_due(&data, now)?;
                data["next_run"] = json!(next);
                data["last_missed"] = due.into();
                if next.is_none() {
                    data["enabled"] = false.into();
                    data["status"] = "missed".into();
                }
                match store
                    .internal_update_resource(&schedule.id, schedule.version, data)
                    .await
                {
                    Ok(_)
                    | Err(rstrbot_store::Error::Conflict)
                    | Err(rstrbot_store::Error::NotFound) => {}
                    Err(error) => return Err(error.into()),
                }
                continue;
            }
            if dispatched >= MAX_DISPATCHES_PER_TICK {
                return Ok(());
            }
            let user = match store.user_by_id(&schedule.owner_id).await {
                Ok(user) => user,
                Err(_) => {
                    pause_revoked(&store, &schedule).await?;
                    continue;
                }
            };
            if store
                .require_role(&schedule.workspace_id, &user.id, Role::Member)
                .await
                .is_err()
            {
                pause_revoked(&store, &schedule).await?;
                continue;
            }
            dispatched += 1;
            if let Err(error) = dispatch(state.clone(), user, schedule, due, false).await {
                tracing::warn!(code=%error.code,"schedule dispatch stopped");
            }
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    Ok(())
}

async fn pause_revoked(store: &Store, schedule: &Resource) -> Result<(), AppError> {
    let mut data = schedule.data.clone();
    data["enabled"] = false.into();
    data["status"] = "paused".into();
    data["last_error"] = "Schedule owner no longer has execution permission".into();
    match store
        .internal_update_resource(&schedule.id, schedule.version, data)
        .await
    {
        Ok(_) | Err(rstrbot_store::Error::Conflict) | Err(rstrbot_store::Error::NotFound) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Reconcile pre-existing claims before the HTTP listener accepts new work.
/// Running this concurrently with admission could mistake a fresh manual run
/// for an abandoned claim, especially when a large history needs many pages.
pub async fn recover(state: &AppState) -> Result<(), AppError> {
    recover_claims(&state.store().await).await
}

/// Run the single-core scheduler after startup recovery. Multi-replica
/// scheduling is not advertised; durable CAS still protects concurrent claims.
pub async fn run_scheduler(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _=state.shutdown.cancelled()=>break,
            _=interval.tick()=>if let Err(error)=tick(&state).await {tracing::warn!(code=%error.code,"scheduler tick deferred");},
        }
    }
}

/// Operational fields callers must retain when changing schedule configuration.
pub fn protected_fields() -> &'static [&'static str] {
    PROTECTED_FIELDS
}

#[cfg(test)]
mod tests {
    use super::*;
    fn utc(text: &str) -> i64 {
        DateTime::parse_from_rfc3339(text).unwrap().timestamp()
    }
    #[test]
    fn intervals_keep_their_anchor_and_skip_missed_slots() {
        let data = json!({"schedule_type":"interval","interval_seconds":60,"start_at":1000});
        assert_eq!(next_due(&data, 999).unwrap(), Some(1000));
        assert_eq!(next_due(&data, 1000).unwrap(), Some(1060));
        assert_eq!(next_due(&data, 1401).unwrap(), Some(1420));
    }
    #[test]
    fn once_never_implicitly_replays_a_past_time() {
        let data = json!({"schedule_type":"once","at":2000});
        assert_eq!(next_due(&data, 1999).unwrap(), Some(2000));
        assert_eq!(next_due(&data, 2000).unwrap(), None);
    }
    #[test]
    fn calendar_skips_dst_gap_and_uses_first_fold_occurrence() {
        let gap =
            json!({"schedule_type":"cron","cron":"0 30 2 * * *","timezone":"America/New_York"});
        assert_eq!(
            next_due(&gap, utc("2026-03-08T05:00:00Z")).unwrap(),
            Some(utc("2026-03-09T06:30:00Z"))
        );
        let fold =
            json!({"schedule_type":"cron","cron":"0 30 1 * * *","timezone":"America/New_York"});
        assert_eq!(
            next_due(&fold, utc("2026-11-01T04:00:00Z")).unwrap(),
            Some(utc("2026-11-01T05:30:00Z"))
        );
        assert_eq!(
            next_due(&fold, utc("2026-11-01T05:30:00Z")).unwrap(),
            Some(utc("2026-11-02T06:30:00Z"))
        );
    }
    #[test]
    fn invalid_timezone_and_unbounded_frequency_are_rejected() {
        assert!(
            next_due(
                &json!({"schedule_type":"cron","cron":"* * * * * *","timezone":"UTC"}),
                1000
            )
            .is_err()
        );
        assert!(
            next_due(
                &json!({"schedule_type":"cron","cron":"0 * * * * *","timezone":"not/a-zone"}),
                1000
            )
            .is_err()
        );
        assert!(
            next_due(
                &json!({"schedule_type":"interval","interval_seconds":0}),
                1000
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn only_one_claim_wins_and_restart_preserves_uncertainty() {
        use rstrbot_store::Visibility;
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let user = store
            .bootstrap("owner", "a-long-password-123", "workspace")
            .await
            .unwrap()
            .user;
        let workspace = store.workspaces(&user.id).await.unwrap().remove(0);
        let data = json!({"title":"x","prompt":"hello","model_id":"model","conversation_id":"conversation","schedule_type":"interval","interval_seconds":60,"start_at":1000,"enabled":true,"status":"scheduled"});
        let schedule = store
            .create_resource(
                &workspace.id,
                &user.id,
                "schedules",
                Visibility::Private,
                data,
            )
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            claim(&store, &user, &schedule, 1000, false),
            claim(&store, &user, &schedule, 1000, false)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        recover_claims(&store).await.unwrap();
        let restored = store
            .get_resource(&workspace.id, &user.id, &schedule.id)
            .await
            .unwrap();
        assert_eq!(restored.data["status"], "needs_reconciliation");
        assert_eq!(restored.data["enabled"], false);
        assert!(claim(&store, &user, &restored, 1000, false).await.is_err());
    }
}
