//! The same suite runs against SQLite and PostgreSQL. Set
//! RSTRBOT_TEST_DATABASE_URL to a disposable PG database; each test uses a unique
//! schema, deliberately leaving it available for failure diagnosis.
use rstrbot_store::{Error, Role, Store, User, Visibility};
use serde_json::json;

const PASSWORD: &str = "a correct horse battery staple";

async fn database() -> (Store, Option<tempfile::TempDir>) {
    let (store, directory, _) = database_with_url().await;
    (store, directory)
}

async fn database_with_url() -> (Store, Option<tempfile::TempDir>, String) {
    if let Ok(url) = std::env::var("RSTRBOT_TEST_DATABASE_URL") {
        sqlx::any::install_default_drivers();
        let pool = sqlx::AnyPool::connect(&url).await.unwrap();
        let schema = format!("rstrbot_test_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let separator = if url.contains('?') { '&' } else { '?' };
        let url = format!("{url}{separator}options=-csearch_path%3D{schema}");
        (Store::connect(&url).await.unwrap(), None, url)
    } else {
        let dir = tempfile::tempdir().unwrap();
        let url = Store::sqlite_file_url(&dir.path().join("test.sqlite3")).unwrap();
        (Store::connect(&url).await.unwrap(), Some(dir), url)
    }
}

async fn initialized() -> (Store, User, String, Option<tempfile::TempDir>) {
    let (store, dir) = database().await;
    let session = store
        .bootstrap("alice", PASSWORD, "Workspace")
        .await
        .unwrap();
    let workspace = store
        .workspaces(&session.user.id)
        .await
        .unwrap()
        .remove(0)
        .id;
    (store, session.user, workspace, dir)
}

#[tokio::test]
async fn visible_cursor_keeps_scope_and_membership_during_pages() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let mut shared = Vec::new();
    for index in 0..5 {
        shared.push(
            store
                .create_resource(
                    &workspace,
                    &alice.id,
                    "conversations",
                    Visibility::Workspace,
                    json!({"index":index}),
                )
                .await
                .unwrap(),
        );
    }
    let secret = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversations",
            Visibility::Private,
            json!({"private":true}),
        )
        .await
        .unwrap();
    let own = store
        .create_resource(
            &workspace,
            &bob.id,
            "conversations",
            Visibility::Private,
            json!({"private":true}),
        )
        .await
        .unwrap();
    let first = store
        .visible_resource_page(&workspace, &bob.id, "conversations", None, 2)
        .await
        .unwrap();
    let cursor = first.next.unwrap();
    assert!(matches!(
        store
            .visible_resource_page(&workspace, &alice.id, "conversations", Some(&cursor), 2)
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .visible_resource_page(&workspace, &bob.id, "runs", Some(&cursor), 2)
            .await,
        Err(Error::Invalid(_))
    ));
    let mut seen: Vec<_> = first.items.iter().map(|item| item.id.clone()).collect();
    let already_read = first
        .items
        .iter()
        .find(|item| item.owner_id == alice.id)
        .unwrap();
    store
        .delete_resource(
            &workspace,
            &alice.id,
            &already_read.id,
            already_read.version,
        )
        .await
        .unwrap();
    let mut next = Some(cursor);
    while let Some(current) = next {
        let page = store
            .visible_resource_page(&workspace, &bob.id, "conversations", Some(&current), 2)
            .await
            .unwrap();
        seen.extend(page.items.into_iter().map(|item| item.id));
        next = page.next;
    }
    seen.sort();
    let mut expected: Vec<_> = shared
        .into_iter()
        .map(|item| item.id)
        .chain([own.id])
        .collect();
    expected.sort();
    assert_eq!(seen, expected);
    assert!(!seen.contains(&secret.id));
    let cursor = store
        .visible_resource_page(&workspace, &bob.id, "conversations", None, 2)
        .await
        .unwrap()
        .next
        .unwrap();
    store
        .remove_member(&workspace, &alice.id, &bob.id)
        .await
        .unwrap();
    assert!(
        store
            .visible_resource_page(&workspace, &bob.id, "conversations", Some(&cursor), 2)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn recovery_scan_traverses_more_than_ten_thousand_records_in_bounded_pages() {
    let (store, _directory, url) = database_with_url().await;
    let owner = store
        .bootstrap("alice", PASSWORD, "History")
        .await
        .unwrap()
        .user;
    let workspace = store.workspaces(&owner.id).await.unwrap().remove(0).id;
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    // Seed durable historical facts in one transaction: this test exercises the
    // scan, not ten thousand independent user-admission transactions.
    let mut tx = pool.begin().await.unwrap();
    let total = 10_023;
    for index in 0..total {
        let id = format!("{index:08}-0000-4000-8000-000000000000");
        sqlx::query("INSERT INTO resources (id, workspace_id, owner_id, kind, visibility, version, data, created_at, updated_at) VALUES ($1, $2, $3, 'runs', 'private', 1, $4, $5, $5)")
            .bind(id).bind(&workspace).bind(&owner.id)
            .bind("{\"status\":\"completed\"}")
            // Many records share a timestamp, as they do in real busy servers.
            .bind(1_700_000_000_i64 + index / 113)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    pool.close().await;
    // A normal user still sees only their workspace-scoped page. The new
    // trusted scan does not replace or relax the public listing contract.
    assert_eq!(
        store
            .list_resources(&workspace, &owner.id, "runs", 10_000, 0)
            .await
            .unwrap()
            .len(),
        500
    );
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let page = store
            .internal_list_page("runs", cursor.as_ref(), 127)
            .await
            .unwrap();
        assert!(page.items.len() <= 127);
        seen.extend(page.items.into_iter().map(|record| record.id));
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    let expected: Vec<_> = (0..total)
        .map(|index| format!("{index:08}-0000-4000-8000-000000000000"))
        .collect();
    assert_eq!(
        seen, expected,
        "every historical record must be visited exactly once"
    );
}

#[tokio::test]
async fn recovery_cursor_survives_deletion_and_bounds_concurrent_growth() {
    let (store, _directory, url) = database_with_url().await;
    let alice = store
        .bootstrap("alice", PASSWORD, "Recovery")
        .await
        .unwrap()
        .user;
    let workspace = store.workspaces(&alice.id).await.unwrap().remove(0).id;
    let mut records = Vec::new();
    for index in 0..6 {
        records.push(
            store
                .create_resource(
                    &workspace,
                    &alice.id,
                    "runs",
                    Visibility::Private,
                    json!({"status":"completed","index":index}),
                )
                .await
                .unwrap(),
        );
    }
    records.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let first = store.internal_list_page("runs", None, 2).await.unwrap();
    let cursor = first.next.unwrap();
    assert!(matches!(
        store
            .internal_list_page("deliveries", Some(&cursor), 2)
            .await,
        Err(Error::Invalid(_))
    ));
    // Removing a previously read row would make OFFSET pagination skip one of
    // the unread rows. A keyset cursor retains its position after that deletion.
    store
        .delete_resource(&workspace, &alice.id, &records[0].id, records[0].version)
        .await
        .unwrap();
    let later = store
        .create_resource(
            &workspace,
            &alice.id,
            "runs",
            Visibility::Private,
            json!({"status":"completed","new":true}),
        )
        .await
        .unwrap();
    // Set the fixture's later timestamp directly instead of relying on a clock
    // sleep. Ordinary resource updates cannot alter these immutable scan keys.
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    sqlx::query("UPDATE resources SET created_at = $1 WHERE id = $2")
        .bind(records.last().unwrap().created_at + 1)
        .bind(&later.id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let mut cursor = Some(cursor);
    let mut seen = Vec::new();
    loop {
        let page = store
            .internal_list_page("runs", cursor.as_ref(), 2)
            .await
            .unwrap();
        seen.extend(page.items.into_iter().map(|record| record.id));
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        seen,
        records[2..]
            .iter()
            .map(|r| r.id.clone())
            .collect::<Vec<_>>()
    );
    let fresh = store.internal_list_page("runs", None, 500).await.unwrap();
    assert_eq!(fresh.items.len(), 6);
    assert!(fresh.items.iter().any(|record| record.id == later.id));
    assert!(fresh.next.is_none());
    let one = store.internal_list_page("runs", None, 0).await.unwrap();
    assert_eq!(one.items.len(), 1);
    assert!(one.next.is_some());
    let empty = store
        .internal_list_page("deliveries", None, 2)
        .await
        .unwrap();
    assert!(empty.items.is_empty() && empty.next.is_none());
}

#[tokio::test]
async fn recovery_pages_bound_large_payloads_without_skipping_records() {
    let (store, alice, workspace, _directory) = initialized().await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(
            store
                .create_resource(
                    &workspace,
                    &alice.id,
                    "runs",
                    Visibility::Private,
                    json!({"status":"completed","content":"x".repeat(6 * 1024 * 1024)}),
                )
                .await
                .unwrap()
                .id,
        );
    }
    let first = store.internal_list_page("runs", None, 500).await.unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(
        first.next.is_some(),
        "a byte-limited short page still needs continuation"
    );
    let second = store
        .internal_list_page("runs", first.next.as_ref(), 500)
        .await
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.next.is_none());
    let mut seen: Vec<_> = first
        .items
        .into_iter()
        .chain(second.items)
        .map(|r| r.id)
        .collect();
    seen.sort();
    ids.sort();
    assert_eq!(seen, ids);
}

#[tokio::test]
async fn populated_database_probe_and_reconnect_preserve_records() {
    let (store, _directory, url) = database_with_url().await;
    let session = store
        .bootstrap("alice", PASSWORD, "Persistent")
        .await
        .unwrap();
    let workspace = store.workspaces(&session.user.id).await.unwrap().remove(0);
    let resource = store
        .create_resource(
            &workspace.id,
            &session.user.id,
            "conversations",
            Visibility::Private,
            json!({"title":"survives restart","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let events = store
        .events(&workspace.id, &session.user.id, 0, 100)
        .await
        .unwrap();

    let probe = Store::probe(&url).await.unwrap();
    assert_eq!(probe.backend, store.backend());
    assert!(probe.has_user_tables && probe.rstrbot_schema && probe.initialized);
    // Check an existing populated database, not only the empty-schema case.
    store.close().await;
    let reopened = Store::connect(&url).await.unwrap();
    assert!(reopened.initialized().await.unwrap());
    let saved = reopened
        .get_resource(&workspace.id, &session.user.id, &resource.id)
        .await
        .unwrap();
    assert_eq!(saved.version, resource.version);
    assert_eq!(saved.data, resource.data);
    assert_eq!(
        reopened
            .events(&workspace.id, &session.user.id, 0, 100)
            .await
            .unwrap()
            .len(),
        events.len()
    );
    reopened.close().await;

    // A recognizable set of table names must not authorize a migration of a
    // future or unversioned database. Inspecting/refusing it stays read-only.
    let pool = sqlx::AnyPool::connect(&url).await.unwrap();
    sqlx::query("UPDATE instance_state SET value = '3' WHERE key = 'schema_version'")
        .execute(&pool)
        .await
        .unwrap();
    let unsupported = Store::probe(&url).await.unwrap();
    assert!(unsupported.has_user_tables && !unsupported.rstrbot_schema);
    assert!(matches!(Store::connect(&url).await, Err(Error::Invalid(_))));
    let version: String =
        sqlx::query_scalar("SELECT value FROM instance_state WHERE key = 'schema_version'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(version, "3");

    sqlx::query("DELETE FROM instance_state WHERE key = 'schema_version'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!Store::probe(&url).await.unwrap().rstrbot_schema);
    assert!(matches!(Store::connect(&url).await, Err(Error::Invalid(_))));
    let missing: Option<String> =
        sqlx::query_scalar("SELECT value FROM instance_state WHERE key = 'schema_version'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(missing.is_none());
    pool.close().await;
}

#[tokio::test]
async fn bootstrap_is_atomic_and_cannot_be_repeated() {
    let (store, _dir) = database().await;
    let (first, second) = tokio::join!(
        store.bootstrap("alice", PASSWORD, "A"),
        store.bootstrap("bob", PASSWORD, "B")
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert!(store.initialized().await.unwrap());
    assert!(matches!(
        store.bootstrap("charlie", PASSWORD, "C").await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn private_resources_are_private_even_from_workspace_owner() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let private = store
        .create_resource(
            &workspace,
            &bob.id,
            "conversation",
            Visibility::Private,
            json!({"text":"private-secret"}),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.get_resource(&workspace, &alice.id, &private.id).await,
        Err(Error::NotFound)
    ));
    assert!(
        store
            .list_resources(&workspace, &alice.id, "conversation", 50, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        !serde_json::to_string(&store.events(&workspace, &alice.id, 0, 100).await.unwrap())
            .unwrap()
            .contains(&private.id)
    );
    assert_eq!(
        store
            .get_resource(&workspace, &bob.id, &private.id)
            .await
            .unwrap()
            .data["text"],
        "private-secret"
    );
    let shared = store
        .create_resource(
            &workspace,
            &bob.id,
            "document",
            Visibility::Workspace,
            json!({"title":"Same title"}),
        )
        .await
        .unwrap();
    assert!(
        store
            .get_resource(&workspace, &alice.id, &shared.id)
            .await
            .is_ok()
    );
    let other = store.create_workspace(&bob.id, "Workspace").await.unwrap();
    assert!(matches!(
        store.get_resource(&other.id, &bob.id, &private.id).await,
        Err(Error::NotFound)
    ));
}

#[tokio::test]
async fn membership_revocation_shrinks_existing_tokens_and_event_replay() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let session = store.login("bob", PASSWORD).await.unwrap();
    let resource = store
        .create_resource(
            &workspace,
            &bob.id,
            "conversation",
            Visibility::Private,
            json!({}),
        )
        .await
        .unwrap();
    store
        .remove_member(&workspace, &alice.id, &bob.id)
        .await
        .unwrap();
    assert!(store.authenticate(&session.token).await.is_ok());
    assert!(
        store
            .get_resource(&workspace, &bob.id, &resource.id)
            .await
            .is_err()
    );
    assert!(matches!(
        store.events(&workspace, &bob.id, 0, 10).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .update_resource(&workspace, &bob.id, &resource.id, 1, json!({}))
            .await,
        Err(Error::Forbidden)
    ));
    store.revoke(&session.token).await.unwrap();
    assert!(matches!(
        store.authenticate(&session.token).await,
        Err(Error::Unauthorized)
    ));
}

#[tokio::test]
async fn roles_cannot_escalate_or_remove_last_owner() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Viewer)
        .await
        .unwrap();
    assert!(matches!(
        store
            .create_resource(
                &workspace,
                &bob.id,
                "conversation",
                Visibility::Private,
                json!({})
            )
            .await,
        Err(Error::Forbidden)
    ));
    assert!(
        store
            .remove_member(&workspace, &alice.id, &alice.id)
            .await
            .is_err()
    );
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Admin)
        .await
        .unwrap();
    assert!(matches!(
        store
            .set_member(&workspace, &bob.id, &bob.id, Role::Owner)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store.remove_member(&workspace, &bob.id, &alice.id).await,
        Err(Error::Forbidden)
    ));
}

#[tokio::test]
async fn stale_configuration_cannot_overwrite_a_concurrent_edit() {
    let (store, alice, workspace, _dir) = initialized().await;
    let resource = store
        .create_resource(
            &workspace,
            &alice.id,
            "config",
            Visibility::Workspace,
            json!({"value":0}),
        )
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        store.update_resource(&workspace, &alice.id, &resource.id, 1, json!({"value":1})),
        store.update_resource(&workspace, &alice.id, &resource.id, 1, json!({"value":2}))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(
        store
            .get_resource(&workspace, &alice.id, &resource.id)
            .await
            .unwrap()
            .version,
        2
    );
}

#[tokio::test]
async fn deletion_removes_replayable_private_payloads() {
    let (store, alice, workspace, _dir) = initialized().await;
    let resource = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversation",
            Visibility::Private,
            json!({}),
        )
        .await
        .unwrap();
    store
        .append_event(
            &workspace,
            &alice.id,
            &resource.id,
            "delta",
            json!({"text":"must disappear"}),
        )
        .await
        .unwrap();
    store
        .delete_resource(&workspace, &alice.id, &resource.id, 1)
        .await
        .unwrap();
    let events = store.events(&workspace, &alice.id, 0, 100).await.unwrap();
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("must disappear")
    );
    assert!(events.iter().any(|event| event.kind == "resource.deleted"));
}

#[tokio::test]
async fn concurrent_reservations_cannot_overspend_and_unknown_stays_frozen() {
    let (store, alice, workspace, _dir) = initialized().await;
    store
        .set_budget(&workspace, &alice.id, Some(100))
        .await
        .unwrap();
    let mut jobs = Vec::new();
    for i in 0..12 {
        let (store, user, workspace) = (store.clone(), alice.id.clone(), workspace.clone());
        jobs.push(tokio::spawn(async move {
            store
                .reserve(&workspace, &user, &format!("call-{i}"), 30)
                .await
        }));
    }
    let mut reservations = Vec::new();
    for job in jobs {
        if let Ok(reservation) = job.await.unwrap() {
            reservations.push(reservation);
        }
    }
    assert_eq!(reservations.len(), 3);
    let reservation = &reservations[0];
    store.settle(&reservation.id, None).await.unwrap();
    let budget = store.budget(&workspace, &alice.id).await.unwrap();
    assert_eq!(budget.reserved_microusd, 90);
    assert_eq!(budget.unknown_reservations, 1);
    assert!(matches!(
        store.reserve(&workspace, &alice.id, "extra", 20).await,
        Err(Error::BudgetExceeded)
    ));
    store.settle(&reservation.id, Some(12)).await.unwrap();
    store.settle(&reservation.id, Some(12)).await.unwrap();
    let budget = store.budget(&workspace, &alice.id).await.unwrap();
    assert_eq!(budget.spent_microusd, 12);
    assert_eq!(budget.reserved_microusd, 60);
    assert_eq!(budget.unknown_reservations, 0);
}

#[tokio::test]
async fn actual_cost_over_reservation_is_recorded_as_debt() {
    let (store, alice, workspace, _dir) = initialized().await;
    store
        .set_budget(&workspace, &alice.id, Some(50))
        .await
        .unwrap();
    let reservation = store
        .reserve(&workspace, &alice.id, "call", 40)
        .await
        .unwrap();
    let duplicate = store
        .reserve(&workspace, &alice.id, "call", 40)
        .await
        .unwrap();
    assert_eq!(reservation.id, duplicate.id);
    store.settle(&reservation.id, Some(70)).await.unwrap();
    let budget = store.budget(&workspace, &alice.id).await.unwrap();
    assert_eq!(budget.spent_microusd, 70);
    assert_eq!(budget.reserved_microusd, 0);
    assert!(
        store
            .reserve(&workspace, &alice.id, "next", 1)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn unknown_cost_reconciliation_is_serialized_redacted_and_backed_up() {
    let (store, alice, workspace, _dir) = initialized().await;
    let admin = store
        .create_user(&alice, "cost_admin", PASSWORD)
        .await
        .unwrap();
    let member = store
        .create_user(&alice, "cost_member", PASSWORD)
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &admin.id, Role::Admin)
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &member.id, Role::Member)
        .await
        .unwrap();

    let in_flight = store
        .reserve(&workspace, &alice.id, "in-flight-cost", 20)
        .await
        .unwrap();
    assert!(matches!(
        store.reservations(&workspace, &member.id, 0, 100).await,
        Err(Error::Forbidden)
    ));
    let second_reservation = store
        .reserve(&workspace, &alice.id, "reservation-page-test", 0)
        .await
        .unwrap();
    let first_page = store
        .reservations(&workspace, &alice.id, 0, 1)
        .await
        .unwrap();
    let second_page = store
        .reservations(&workspace, &alice.id, 1, 1)
        .await
        .unwrap();
    assert_eq!(first_page.total, 2);
    assert_eq!(first_page.items.len(), 1);
    assert!(first_page.has_more);
    assert_eq!(second_page.items.len(), 1);
    assert!(!second_page.has_more);
    assert_ne!(first_page.items[0].id, second_page.items[0].id);
    store.settle(&second_reservation.id, Some(0)).await.unwrap();
    assert!(matches!(
        store
            .reconcile_reservation(&workspace, &in_flight.id, &alice.id, 0, 10, "invoice", true,)
            .await,
        Err(Error::Conflict)
    ));
    store.settle(&in_flight.id, None).await.unwrap();

    assert!(matches!(
        store
            .reconcile_reservation(
                &workspace,
                &in_flight.id,
                &member.id,
                0,
                10,
                "invoice",
                true,
            )
            .await,
        Err(Error::Forbidden)
    ));
    for (amount, source, confirmed) in [
        (-1, "invoice", true),
        (10, "other", true),
        (10, "invoice", false),
    ] {
        assert!(matches!(
            store
                .reconcile_reservation(
                    &workspace,
                    &in_flight.id,
                    &alice.id,
                    0,
                    amount,
                    source,
                    confirmed,
                )
                .await,
            Err(Error::Invalid(_))
        ));
    }

    let left_store = store.clone();
    let left_workspace = workspace.clone();
    let left_id = in_flight.id.clone();
    let left_user = alice.id.clone();
    let left = tokio::spawn(async move {
        left_store
            .reconcile_reservation(
                &left_workspace,
                &left_id,
                &left_user,
                0,
                13,
                "invoice",
                true,
            )
            .await
    });
    let right_store = store.clone();
    let right_workspace = workspace.clone();
    let right_id = in_flight.id.clone();
    let right_user = alice.id.clone();
    let right = tokio::spawn(async move {
        right_store
            .reconcile_reservation(
                &right_workspace,
                &right_id,
                &right_user,
                0,
                13,
                "invoice",
                true,
            )
            .await
    });
    assert!(left.await.unwrap().is_ok());
    assert!(right.await.unwrap().is_ok());
    let budget = store.budget(&workspace, &alice.id).await.unwrap();
    assert_eq!(budget.spent_microusd, 13);
    assert_eq!(budget.reserved_microusd, 0);
    assert_eq!(budget.unknown_reservations, 0);
    assert_eq!(
        store
            .reservation_reconciliations(&workspace, &in_flight.id, &alice.id, 0, 100)
            .await
            .unwrap()
            .len(),
        1,
        "identical concurrent retry appends one revision"
    );
    assert!(matches!(
        store
            .reconcile_reservation(&workspace, &in_flight.id, &admin.id, 0, 14, "invoice", true,)
            .await,
        Err(Error::Conflict)
    ));

    store
        .reconcile_reservation(
            &workspace,
            &in_flight.id,
            &admin.id,
            1,
            4,
            "provider_adjustment",
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .budget(&workspace, &alice.id)
            .await
            .unwrap()
            .spent_microusd,
        4,
        "correction updates the ledger by the difference"
    );
    let history = store
        .reservation_reconciliations(&workspace, &in_flight.id, &alice.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].old_microusd, None);
    assert_eq!(history[0].actual_microusd, 13);
    assert_eq!(history[1].old_microusd, Some(13));
    assert_eq!(history[1].actual_microusd, 4);
    assert_eq!(history[1].performed_by, admin.id);
    let history_first = store
        .reservation_reconciliations(&workspace, &in_flight.id, &alice.id, 0, 1)
        .await
        .unwrap();
    let history_second = store
        .reservation_reconciliations(&workspace, &in_flight.id, &alice.id, history_first[0].id, 1)
        .await
        .unwrap();
    assert_eq!(history_first.len(), 1);
    assert_eq!(history_second.len(), 1);
    assert!(history_second[0].id > history_first[0].id);

    let events = store.events(&workspace, &member.id, 0, 100).await.unwrap();
    let cost_events: Vec<_> = events
        .iter()
        .filter(|event| event.kind.starts_with("budget.reservation."))
        .collect();
    assert_eq!(cost_events.len(), 2);
    assert!(cost_events.iter().all(|event| event.data.is_null()));
    assert!(matches!(
        store
            .reservation_reconciliations(&workspace, &in_flight.id, &member.id, 0, 100)
            .await,
        Err(Error::Forbidden)
    ));

    let backup = store.export_backup(&alice).await.unwrap();
    let (restored, _restored_dir) = database().await;
    restored.import_backup(&backup).await.unwrap();
    assert_eq!(
        restored
            .reservation_reconciliations(&workspace, &in_flight.id, &alice.id, 0, 100)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        restored
            .budget(&workspace, &alice.id)
            .await
            .unwrap()
            .spent_microusd,
        4
    );
    let other_workspace = store
        .create_workspace(&alice.id, "Another workspace")
        .await
        .unwrap();
    assert!(matches!(
        store
            .reservation_reconciliations(&other_workspace.id, &in_flight.id, &alice.id, 0, 100,)
            .await,
        Err(Error::NotFound)
    ));
}

#[tokio::test]
async fn different_admin_reconciliations_and_budget_updates_share_workspace_lock() {
    let (store, alice, workspace, _dir) = initialized().await;
    let admin = store
        .create_user(&alice, "race_admin", PASSWORD)
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &admin.id, Role::Admin)
        .await
        .unwrap();
    let contested = store
        .reserve(&workspace, &alice.id, "contested", 0)
        .await
        .unwrap();
    store.settle(&contested.id, None).await.unwrap();

    let left_store = store.clone();
    let left_workspace = workspace.clone();
    let left_id = contested.id.clone();
    let left_user = alice.id.clone();
    let left = tokio::spawn(async move {
        left_store
            .reconcile_reservation(
                &left_workspace,
                &left_id,
                &left_user,
                0,
                13,
                "invoice",
                true,
            )
            .await
    });
    let right_store = store.clone();
    let right_workspace = workspace.clone();
    let right_id = contested.id.clone();
    let right_user = admin.id.clone();
    let right = tokio::spawn(async move {
        right_store
            .reconcile_reservation(
                &right_workspace,
                &right_id,
                &right_user,
                0,
                17,
                "usage_receipt",
                true,
            )
            .await
    });
    let results = [left.await.unwrap(), right.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result.as_ref(), Err(Error::Conflict)))
            .count(),
        1
    );
    let reconciled = store
        .reservation_reconciliations(&workspace, &contested.id, &alice.id, 0, 100)
        .await
        .unwrap();
    assert_eq!(reconciled.len(), 1);
    assert!(matches!(reconciled[0].actual_microusd, 13 | 17));
    assert_eq!(
        store
            .budget(&workspace, &alice.id)
            .await
            .unwrap()
            .spent_microusd,
        reconciled[0].actual_microusd
    );

    let budget_race = store
        .reserve(&workspace, &alice.id, "budget-race", 0)
        .await
        .unwrap();
    store.settle(&budget_race.id, None).await.unwrap();
    let budget_store = store.clone();
    let budget_workspace = workspace.clone();
    let budget_user = alice.id.clone();
    let change_budget = tokio::spawn(async move {
        budget_store
            .set_budget(&budget_workspace, &budget_user, Some(500))
            .await
    });
    let reconcile_store = store.clone();
    let reconcile_workspace = workspace.clone();
    let reconcile_id = budget_race.id.clone();
    let reconcile_user = admin.id.clone();
    let reconcile = tokio::spawn(async move {
        reconcile_store
            .reconcile_reservation(
                &reconcile_workspace,
                &reconcile_id,
                &reconcile_user,
                0,
                60,
                "invoice",
                true,
            )
            .await
    });
    change_budget.await.unwrap().unwrap();
    reconcile.await.unwrap().unwrap();
    let budget = store.budget(&workspace, &alice.id).await.unwrap();
    assert_eq!(budget.limit_microusd, Some(500));
    assert_eq!(budget.spent_microusd, reconciled[0].actual_microusd + 60);
    assert_eq!(budget.unknown_reservations, 0);
}

#[tokio::test]
async fn idempotency_preserves_unknown_intent_and_compares_fingerprint() {
    let (store, alice, workspace, _dir) = initialized().await;
    assert_eq!(
        store
            .begin_operation(&workspace, &alice.id, "send-1", "fingerprint")
            .await
            .unwrap(),
        None
    );
    assert!(matches!(
        store
            .begin_operation(&workspace, &alice.id, "send-1", "fingerprint")
            .await,
        Err(Error::Conflict)
    ));
    store
        .finish_operation(
            &workspace,
            &alice.id,
            "send-1",
            json!({"receipt":"accepted"}),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .begin_operation(&workspace, &alice.id, "send-1", "fingerprint")
            .await
            .unwrap()
            .unwrap()["receipt"],
        "accepted"
    );
    assert!(matches!(
        store
            .begin_operation(&workspace, &alice.id, "send-1", "different")
            .await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn snapshot_restore_keeps_ownership_unknown_funds_and_quarantines_effects() {
    let (store, alice, workspace, _dir) = initialized().await;
    let resource = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversation",
            Visibility::Private,
            json!({"message":"persisted"}),
        )
        .await
        .unwrap();
    let reservation = store
        .reserve(&workspace, &alice.id, "unknown-call", 25)
        .await
        .unwrap();
    store.settle(&reservation.id, None).await.unwrap();
    let backup = store.export_backup(&alice).await.unwrap();
    assert!(!backup.includes_external_state);
    let (restored, _other_dir) = database().await;
    restored.import_backup(&backup).await.unwrap();
    assert!(restored.recovery_mode().await.unwrap());
    assert_eq!(
        restored
            .get_resource(&workspace, &alice.id, &resource.id)
            .await
            .unwrap()
            .data["message"],
        "persisted"
    );
    assert_eq!(
        restored
            .budget(&workspace, &alice.id)
            .await
            .unwrap()
            .reserved_microusd,
        25
    );
    assert!(restored.login("alice", PASSWORD).await.is_ok());
    assert!(restored.import_backup(&backup).await.is_err());
    let mut corrupted = backup.clone();
    corrupted.tables.get_mut("resources").unwrap()[0]["owner_id"] = json!("other-owner");
    let (empty, _third_dir) = database().await;
    assert!(empty.import_backup(&corrupted).await.is_err());
    assert!(!empty.initialized().await.unwrap());
}

#[tokio::test]
async fn revoked_actor_receipts_can_be_recorded_without_reviving_deleted_runs() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let run = store
        .create_resource(
            &workspace,
            &bob.id,
            "run",
            Visibility::Private,
            json!({"state":"sending"}),
        )
        .await
        .unwrap();
    store
        .remove_member(&workspace, &alice.id, &bob.id)
        .await
        .unwrap();
    let finished = store
        .internal_update_resource(&run.id, run.version, json!({"state":"delivery_unknown"}))
        .await
        .unwrap();
    store
        .internal_append_event(
            &run.id,
            "delivery.unknown",
            json!({"attempt_id":"same-intent"}),
        )
        .await
        .unwrap();
    assert!(
        store
            .update_resource(
                &workspace,
                &bob.id,
                &run.id,
                finished.version,
                json!({"state":"sending"})
            )
            .await
            .is_err()
    );
    assert!(
        store
            .internal_update_resource(&run.id, run.version, json!({"state":"completed"}))
            .await
            .is_err()
    );
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    store
        .delete_resource(&workspace, &bob.id, &run.id, finished.version)
        .await
        .unwrap();
    assert!(matches!(
        store
            .internal_update_resource(&run.id, finished.version, json!({"state":"completed"}))
            .await,
        Err(Error::NotFound)
    ));
}

#[tokio::test]
async fn privileged_resource_writes_recheck_current_role_inside_transaction() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Admin)
        .await
        .unwrap();
    let plugin = store
        .create_resource(
            &workspace,
            &bob.id,
            "plugins",
            Visibility::Workspace,
            json!({"enabled":true}),
        )
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    assert!(matches!(
        store
            .create_resource(
                &workspace,
                &bob.id,
                "models",
                Visibility::Private,
                json!({})
            )
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .update_resource(
                &workspace,
                &bob.id,
                &plugin.id,
                plugin.version,
                json!({"enabled":false})
            )
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .delete_resource(&workspace, &bob.id, &plugin.id, plugin.version)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(
        store
            .get_resource(&workspace, &bob.id, &plugin.id)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn shared_schedule_visibility_never_delegates_the_owners_execution_authority() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let schedule = store
        .create_resource(
            &workspace,
            &bob.id,
            "schedules",
            Visibility::Workspace,
            json!({"prompt":"approved by Bob","model_id":"private-model","enabled":false}),
        )
        .await
        .unwrap();
    let moderator = store
        .create_user(&alice, "moderator", PASSWORD)
        .await
        .unwrap();
    for role in [Role::Operator, Role::Admin, Role::Owner] {
        store
            .set_member(&workspace, &alice.id, &moderator.id, role)
            .await
            .unwrap();
        assert!(
            store
                .get_resource(&workspace, &moderator.id, &schedule.id)
                .await
                .is_ok()
        );
        for data in [
            json!({"prompt":"injected","model_id":"private-model","enabled":true}),
            schedule.data.clone(),
        ] {
            assert!(matches!(
                store
                    .update_resource(
                        &workspace,
                        &moderator.id,
                        &schedule.id,
                        schedule.version,
                        data,
                    )
                    .await,
                Err(Error::Forbidden)
            ));
        }
    }
    let unchanged = store
        .get_resource(&workspace, &bob.id, &schedule.id)
        .await
        .unwrap();
    assert_eq!(unchanged.data, schedule.data);
    assert_eq!(unchanged.version, schedule.version);
    let approved = store
        .update_resource(
            &workspace,
            &bob.id,
            &schedule.id,
            schedule.version,
            json!({"prompt":"new intent approved by Bob","enabled":true}),
        )
        .await
        .unwrap();
    assert_eq!(approved.owner_id, bob.id);
    assert_eq!(approved.version, schedule.version + 1);
    assert!(matches!(
        store
            .update_resource(
                &workspace,
                &bob.id,
                &schedule.id,
                schedule.version,
                schedule.data,
            )
            .await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn shared_schedule_moderation_can_remove_but_never_reconfigure_another_owners_job() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    let moderator = store
        .create_user(&alice, "moderator", PASSWORD)
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    for role in [Role::Operator, Role::Admin] {
        store
            .set_member(&workspace, &alice.id, &moderator.id, role)
            .await
            .unwrap();
        let shared = store
            .create_resource(
                &workspace,
                &bob.id,
                "schedules",
                Visibility::Workspace,
                json!({"prompt":"owner approved","enabled":true}),
            )
            .await
            .unwrap();
        store
            .delete_resource(&workspace, &moderator.id, &shared.id, shared.version)
            .await
            .unwrap();
        assert!(matches!(
            store.get_resource(&workspace, &bob.id, &shared.id).await,
            Err(Error::NotFound)
        ));
        let private = store
            .create_resource(
                &workspace,
                &bob.id,
                "schedules",
                Visibility::Private,
                json!({"enabled":false}),
            )
            .await
            .unwrap();
        assert!(matches!(
            store
                .delete_resource(&workspace, &moderator.id, &private.id, private.version)
                .await,
            Err(Error::Forbidden)
        ));
    }
}

#[tokio::test]
async fn schedule_owner_updates_require_current_execution_permission() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Member)
        .await
        .unwrap();
    let schedule = store
        .create_resource(
            &workspace,
            &bob.id,
            "schedules",
            Visibility::Workspace,
            json!({"enabled":true}),
        )
        .await
        .unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Viewer)
        .await
        .unwrap();
    assert!(matches!(
        store
            .update_resource(
                &workspace,
                &bob.id,
                &schedule.id,
                schedule.version,
                json!({"enabled":true,"prompt":"after demotion"}),
            )
            .await,
        Err(Error::Forbidden)
    ));
    store
        .remove_member(&workspace, &alice.id, &bob.id)
        .await
        .unwrap();
    assert!(matches!(
        store
            .update_resource(
                &workspace,
                &bob.id,
                &schedule.id,
                schedule.version,
                json!({"enabled":true,"prompt":"after revocation"}),
            )
            .await,
        Err(Error::Forbidden)
    ));
    // Revocation may still leave an already-observed outcome to save; the
    // trusted bookkeeping boundary does not grant a new public execution.
    let recorded = store
        .internal_update_resource(
            &schedule.id,
            schedule.version,
            json!({"enabled":false,"status":"paused"}),
        )
        .await
        .unwrap();
    assert_eq!(recorded.owner_id, bob.id);
    assert_eq!(recorded.data["status"], "paused");
}

fn run_intent(conversation: &str, model: &str, key: &str) -> rstrbot_store::RunAdmissionRequest {
    rstrbot_store::RunAdmissionRequest {
        conversation_id: conversation.into(),
        model_id: model.into(),
        agent_id: None,
        operation_key: key.into(),
        fingerprint: format!("fingerprint-{key}"),
        content: format!("message-{key}"),
        attachments: Vec::new(),
        images: Vec::new(),
    }
}

#[tokio::test]
async fn run_admission_is_atomic_and_busy_keys_remain_retryable() {
    let (store, user, workspace, _dir) = initialized().await;
    let model = store
        .create_resource(
            &workspace,
            &user.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"diagnostic"}),
        )
        .await
        .unwrap();
    let conversation = store
        .create_resource(
            &workspace,
            &user.id,
            "conversations",
            Visibility::Private,
            json!({"title":"Atomic","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let (first, duplicate) = tokio::join!(
        store.admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &model.id, "first")
        ),
        store.admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &model.id, "first")
        ),
    );
    let first = first.unwrap();
    let duplicate = duplicate.unwrap();
    assert_ne!(first.created, duplicate.created);
    assert_eq!(first.run.id, duplicate.run.id);
    assert_eq!(
        first.conversation.data["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        store
            .admit_run(
                &workspace,
                &user.id,
                run_intent(&conversation.id, &model.id, "busy")
            )
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        store
            .list_resources(&workspace, &user.id, "runs", 10, 0)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut current = store
        .get_resource(&workspace, &user.id, &conversation.id)
        .await
        .unwrap();
    current.data["active_run"] = serde_json::Value::Null;
    store
        .update_resource(
            &workspace,
            &user.id,
            &current.id,
            current.version,
            current.data,
        )
        .await
        .unwrap();
    // The rejected key was never committed. The exact same request can now run.
    let accepted = store
        .admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &model.id, "busy"),
        )
        .await
        .unwrap();
    assert!(accepted.created);
    assert_ne!(accepted.run.id, first.run.id);
    assert_eq!(
        accepted.conversation.data["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut altered = run_intent(&conversation.id, &model.id, "first");
    altered.fingerprint = "changed-intent".into();
    assert!(matches!(
        store.admit_run(&workspace, &user.id, altered).await,
        Err(Error::Conflict)
    ));
}

#[tokio::test]
async fn invalid_admission_rolls_back_receipt_and_history_before_retry() {
    let (store, user, workspace, _dir) = initialized().await;
    let model = store
        .create_resource(
            &workspace,
            &user.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"diagnostic"}),
        )
        .await
        .unwrap();
    let conversation = store
        .create_resource(
            &workspace,
            &user.id,
            "conversations",
            Visibility::Private,
            json!({"title":"Damaged","messages":"not-an-array","generation":0}),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .admit_run(
                &workspace,
                &user.id,
                run_intent(&conversation.id, &model.id, "repairable")
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(
        store
            .list_resources(&workspace, &user.id, "runs", 10, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let corrected = store
        .update_resource(
            &workspace,
            &user.id,
            &conversation.id,
            conversation.version,
            json!({"title":"Repaired","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let accepted = store
        .admit_run(
            &workspace,
            &user.id,
            run_intent(&corrected.id, &model.id, "repairable"),
        )
        .await
        .unwrap();
    assert!(accepted.created);
    assert_eq!(
        accepted.conversation.data["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn admission_uses_current_resource_permissions_and_snapshots() {
    let (store, alice, workspace, _dir) = initialized().await;
    let bob = store.create_user(&alice, "bob", PASSWORD).await.unwrap();
    store
        .set_member(&workspace, &alice.id, &bob.id, Role::Admin)
        .await
        .unwrap();
    let private_model = store
        .create_resource(
            &workspace,
            &bob.id,
            "models",
            Visibility::Private,
            json!({"provider":"diagnostic","model":"secret"}),
        )
        .await
        .unwrap();
    let conversation = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversations",
            Visibility::Private,
            json!({"title":"Private","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .admit_run(
                &workspace,
                &alice.id,
                run_intent(&conversation.id, &private_model.id, "private")
            )
            .await,
        Err(Error::NotFound)
    ));
    assert!(
        store
            .list_resources(&workspace, &alice.id, "runs", 10, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let model = store
        .create_resource(
            &workspace,
            &alice.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"old"}),
        )
        .await
        .unwrap();
    let current_model = store
        .update_resource(
            &workspace,
            &alice.id,
            &model.id,
            model.version,
            json!({"provider":"diagnostic","model":"current"}),
        )
        .await
        .unwrap();
    let admitted = store
        .admit_run(
            &workspace,
            &alice.id,
            run_intent(&conversation.id, &model.id, "current"),
        )
        .await
        .unwrap();
    assert_eq!(
        admitted.model.as_ref().unwrap().version,
        current_model.version
    );
    assert_eq!(admitted.model.as_ref().unwrap().data["model"], "current");
    assert_eq!(admitted.run.data["model_version"], current_model.version);
}

#[tokio::test]
async fn shared_run_cannot_publish_a_private_agent_snapshot() {
    let (store, alice, workspace, _dir) = initialized().await;
    let model = store
        .create_resource(
            &workspace,
            &alice.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"diagnostic"}),
        )
        .await
        .unwrap();
    let private_agent = store
        .create_resource(
            &workspace,
            &alice.id,
            "agents",
            Visibility::Private,
            json!({"system":"private-agent-secret","name":"private-agent-name"}),
        )
        .await
        .unwrap();
    let shared_conversation = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversations",
            Visibility::Workspace,
            json!({"title":"Shared","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let before = store.events(&workspace, &alice.id, 0, 500).await.unwrap();
    let mut request = run_intent(&shared_conversation.id, &model.id, "agent-scope");
    request.agent_id = Some(private_agent.id.clone());
    assert!(matches!(
        store.admit_run(&workspace, &alice.id, request).await,
        Err(Error::Forbidden)
    ));
    assert!(
        store
            .list_resources(&workspace, &alice.id, "runs", 500, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let unchanged = store
        .get_resource(&workspace, &alice.id, &shared_conversation.id)
        .await
        .unwrap();
    assert_eq!(unchanged.data, shared_conversation.data);
    assert_eq!(unchanged.version, shared_conversation.version);
    assert_eq!(
        store
            .events(&workspace, &alice.id, 0, 500)
            .await
            .unwrap()
            .len(),
        before.len()
    );

    // Rejection must not claim the idempotency key or consume the shared turn.
    let shared_agent = store
        .create_resource(
            &workspace,
            &alice.id,
            "agents",
            Visibility::Workspace,
            json!({"system":"approved shared instructions"}),
        )
        .await
        .unwrap();
    let mut approved = run_intent(&shared_conversation.id, &model.id, "agent-scope");
    approved.agent_id = Some(shared_agent.id.clone());
    let shared_run = store
        .admit_run(&workspace, &alice.id, approved)
        .await
        .unwrap();
    assert!(shared_run.created);
    assert_eq!(shared_run.run.data["agent_snapshot"], shared_agent.data);
    assert!(!shared_run.run.data.to_string().contains("private-agent"));

    // Private conversations retain their normal access to their owner's agent.
    let private_conversation = store
        .create_resource(
            &workspace,
            &alice.id,
            "conversations",
            Visibility::Private,
            json!({"title":"Private","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let mut private_request = run_intent(&private_conversation.id, &model.id, "private-agent");
    private_request.agent_id = Some(private_agent.id);
    let private_run = store
        .admit_run(&workspace, &alice.id, private_request)
        .await
        .unwrap();
    assert_eq!(private_run.run.visibility, Visibility::Private);
    assert_eq!(private_run.run.data["agent_snapshot"], private_agent.data);
}

#[tokio::test]
async fn admitted_model_is_bound_to_the_conversation_without_exposing_private_models() {
    let (store, user, workspace, _dir) = initialized().await;
    let alpha = store
        .create_resource(
            &workspace,
            &user.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"alpha"}),
        )
        .await
        .unwrap();
    let beta = store
        .create_resource(
            &workspace,
            &user.id,
            "models",
            Visibility::Workspace,
            json!({"provider":"diagnostic","model":"beta"}),
        )
        .await
        .unwrap();
    let private_model = store
        .create_resource(
            &workspace,
            &user.id,
            "models",
            Visibility::Private,
            json!({"provider":"diagnostic","model":"private"}),
        )
        .await
        .unwrap();
    let conversation = store
        .create_resource(
            &workspace,
            &user.id,
            "conversations",
            Visibility::Private,
            json!({"title":"Chat","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    let first = store
        .admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &alpha.id, "one"),
        )
        .await
        .unwrap();
    assert_eq!(first.conversation.data["last_model_id"], alpha.id);
    let mut current = store
        .get_resource(&workspace, &user.id, &conversation.id)
        .await
        .unwrap();
    current.data["active_run"] = serde_json::Value::Null;
    store
        .update_resource(
            &workspace,
            &user.id,
            &current.id,
            current.version,
            current.data,
        )
        .await
        .unwrap();
    let second = store
        .admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &beta.id, "two"),
        )
        .await
        .unwrap();
    assert_eq!(second.conversation.data["last_model_id"], beta.id);
    let replay = store
        .admit_run(
            &workspace,
            &user.id,
            run_intent(&conversation.id, &alpha.id, "one"),
        )
        .await
        .unwrap();
    assert!(!replay.created);
    assert_eq!(replay.conversation.data["last_model_id"], beta.id);
    let shared = store
        .create_resource(
            &workspace,
            &user.id,
            "conversations",
            Visibility::Workspace,
            json!({"title":"Shared","messages":[],"generation":0}),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .admit_run(
                &workspace,
                &user.id,
                run_intent(&shared.id, &private_model.id, "private"),
            )
            .await,
        Err(Error::Forbidden)
    ));
    let shared_after = store
        .get_resource(&workspace, &user.id, &shared.id)
        .await
        .unwrap();
    assert!(shared_after.data["last_model_id"].is_null());
    assert_eq!(shared_after.data["messages"].as_array().unwrap().len(), 0);
}
