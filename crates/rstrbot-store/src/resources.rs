use crate::*;
use futures_util::TryStreamExt;

/// Opaque position for a trusted internal scan. It is bound to one resource
/// kind and retains the first page's upper bound so later inserts cannot keep
/// extending the scan. It is not an authorization token or a public API cursor.
#[derive(Debug, Clone)]
pub struct ResourceCursor {
    kind: String,
    after: (i64, String),
    through: (i64, String),
}

/// A bounded batch that releases its database connection before the caller
/// processes resources. `next == None` means this scan has reached its end.
#[derive(Debug)]
pub struct ResourcePage {
    pub items: Vec<Resource>,
    pub next: Option<ResourceCursor>,
}

const RESOURCE_PAGE_BYTES: usize = 16 * 1024 * 1024;

impl Store {
    /// Atomically accept a conversation turn and its durable idempotency receipt.
    /// A busy or invalid request leaves no claim, history entry, or run behind.
    /// A crash after commit leaves an accepted run for reconciliation, never an
    /// unrecorded external operation. No model or plugin is called in this method.
    pub async fn admit_run(
        &self,
        workspace: &str,
        user: &str,
        request: RunAdmissionRequest,
    ) -> Result<RunAdmission> {
        checked_label(&request.operation_key, "idempotency key", 200)?;
        checked_label(&request.fingerprint, "operation fingerprint", 128)?;
        if request.content.trim().is_empty() || request.content.len() > 32_768 {
            return Err(Error::Invalid("message must contain 1–32768 bytes".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        let role = role_in(&mut tx, workspace, user).await?;
        if role < Role::Member {
            return Err(Error::Forbidden);
        }
        let mut conversation = resource_in(&mut tx, workspace, &request.conversation_id).await?;
        if conversation.kind != "conversations" {
            return Err(Error::Invalid("expected a conversation".into()));
        }
        can_write(&conversation, user, role)?;
        let existing = sqlx::query("SELECT fingerprint, state, result FROM operations WHERE workspace_id = $1 AND user_id = $2 AND operation_key = $3")
            .bind(workspace).bind(user).bind(&request.operation_key).fetch_optional(&mut *tx).await?;
        if let Some(row) = existing {
            if row.try_get::<String, _>("fingerprint")? != request.fingerprint
                || row.try_get::<String, _>("state")? != "complete"
            {
                return Err(Error::Conflict);
            }
            let receipt: Value = serde_json::from_str(&row.try_get::<String, _>("result")?)?;
            let id = receipt["run_id"].as_str().ok_or(Error::Conflict)?;
            let run = resource_in(&mut tx, workspace, id).await?;
            if run.kind != "runs"
                || run.owner_id != user
                || run.data["conversation_id"] != conversation.id
            {
                return Err(Error::NotFound);
            }
            tx.commit().await?;
            return Ok(RunAdmission {
                run,
                conversation,
                model: None,
                agent: None,
                created: false,
            });
        }
        if conversation
            .data
            .get("active_run")
            .is_some_and(|value| !value.is_null())
        {
            return Err(Error::Conflict);
        }
        let model = resource_in(&mut tx, workspace, &request.model_id).await?;
        if model.kind != "models"
            || (model.visibility == Visibility::Private && model.owner_id != user)
        {
            return Err(Error::NotFound);
        }
        if conversation.visibility == Visibility::Workspace
            && model.visibility == Visibility::Private
        {
            return Err(Error::Forbidden);
        }
        let agent = match request.agent_id.as_deref() {
            Some(id) => {
                let resource = resource_in(&mut tx, workspace, id).await?;
                if resource.kind != "agents"
                    || (resource.visibility == Visibility::Private && resource.owner_id != user)
                {
                    return Err(Error::NotFound);
                }
                // The run persists the full agent snapshot with the
                // conversation's visibility. Reading one's own private agent
                // does not authorize publishing it to the whole workspace.
                if conversation.visibility == Visibility::Workspace
                    && resource.visibility == Visibility::Private
                {
                    return Err(Error::Forbidden);
                }
                Some(resource)
            }
            None => None,
        };
        let generation = conversation.data["generation"]
            .as_u64()
            .ok_or_else(|| Error::Invalid("conversation generation is invalid".into()))?;
        let created_at = now();
        let run = Resource {
            id: new_id(),
            workspace_id: workspace.into(),
            owner_id: user.into(),
            kind: "runs".into(),
            visibility: conversation.visibility,
            version: 1,
            data: serde_json::json!({
                "conversation_id":conversation.id,"model_id":model.id,"model_version":model.version,
                "provider":model.data["provider"],"generation":generation,
                "agent_id":request.agent_id,"agent_snapshot":agent.as_ref().map(|a| &a.data),
                "status":"queued","stage":"accepted","content":"","steps":0,
                "usage":null,"cost_microusd":null,"delivery":"not_attempted","persistence":"saved",
                "created_at":created_at,"model_calls":[],"tool_results":[],"error":null
            }),
            created_at,
            updated_at: created_at,
        };
        let history = conversation.data["messages"]
            .as_array_mut()
            .ok_or_else(|| Error::Invalid("conversation history is invalid".into()))?;
        history.push(serde_json::json!({"id":new_id(),"role":"user","content":request.content,"run_id":run.id,"generation":generation,"created_at":created_at}));
        conversation.data["active_run"] = serde_json::json!(run.id);
        // Record the target in the same transaction as the accepted user turn.
        conversation.data["last_model_id"] = serde_json::json!(model.id);
        let history = encode_data(&conversation.data)?;
        if history.len() > 7 * 1024 * 1024 {
            return Err(Error::Invalid(
                "conversation history limit reached; create a new conversation".into(),
            ));
        }
        let run_data = encode_data(&run.data)?;
        sqlx::query("INSERT INTO resources (id, workspace_id, owner_id, kind, visibility, version, data, created_at, updated_at) VALUES ($1, $2, $3, 'runs', $4, 1, $5, $6, $6)")
            .bind(&run.id).bind(workspace).bind(user).bind(run.visibility.as_str()).bind(run_data).bind(created_at).execute(&mut *tx).await?;
        conversation.version = conversation.version.checked_add(1).ok_or(Error::Conflict)?;
        conversation.updated_at = created_at;
        sqlx::query("UPDATE resources SET data = $1, version = $2, updated_at = $3 WHERE id = $4 AND workspace_id = $5")
            .bind(history).bind(conversation.version).bind(created_at).bind(&conversation.id).bind(workspace).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO operations (workspace_id, user_id, operation_key, fingerprint, state, result, created_at) VALUES ($1, $2, $3, $4, 'complete', $5, $6)")
            .bind(workspace).bind(user).bind(&request.operation_key).bind(&request.fingerprint)
            .bind(serde_json::json!({"run_id":run.id}).to_string()).bind(created_at).execute(&mut *tx).await?;
        record_event(
            &mut tx,
            workspace,
            &run.owner_id,
            run.visibility,
            &run.id,
            "resource.created",
            &serde_json::json!({"kind":"runs","version":1}),
        )
        .await?;
        record_event(
            &mut tx,
            workspace,
            &conversation.owner_id,
            conversation.visibility,
            &conversation.id,
            "resource.updated",
            &serde_json::json!({"kind":"conversations","version":conversation.version}),
        )
        .await?;
        tx.commit().await?;
        Ok(RunAdmission {
            run,
            conversation,
            model: Some(model),
            agent,
            created: true,
        })
    }

    pub async fn create_resource(
        &self,
        workspace: &str,
        user: &str,
        kind: &str,
        visibility: Visibility,
        data: Value,
    ) -> Result<Resource> {
        let kind = checked_label(kind, "resource kind", 64)?;
        if !kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::Invalid("invalid resource kind".into()));
        }
        let encoded = encode_data(&data)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < minimum_role(&kind) {
            return Err(Error::Forbidden);
        }
        let resource = Resource {
            id: new_id(),
            workspace_id: workspace.to_owned(),
            owner_id: user.to_owned(),
            kind,
            visibility,
            version: 1,
            data,
            created_at: now(),
            updated_at: now(),
        };
        sqlx::query("INSERT INTO resources (id, workspace_id, owner_id, kind, visibility, version, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
            .bind(&resource.id).bind(workspace).bind(user).bind(&resource.kind).bind(visibility.as_str()).bind(resource.version).bind(encoded).bind(resource.created_at).bind(resource.updated_at)
            .execute(&mut *tx).await?;
        record_event(
            &mut tx,
            workspace,
            user,
            visibility,
            &resource.id,
            "resource.created",
            &serde_json::json!({"kind":resource.kind,"version":1}),
        )
        .await?;
        tx.commit().await?;
        Ok(resource)
    }

    pub async fn get_resource(&self, workspace: &str, user: &str, id: &str) -> Result<Resource> {
        let row = sqlx::query("SELECT r.* FROM resources r JOIN members m ON m.workspace_id = r.workspace_id AND m.user_id = $2 JOIN users u ON u.id = m.user_id AND u.disabled = 0 WHERE r.workspace_id = $1 AND r.id = $3 AND (r.visibility = 'workspace' OR r.owner_id = $2)")
            .bind(workspace).bind(user).bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        resource_from_row(&row)
    }

    pub async fn list_resources(
        &self,
        workspace: &str,
        user: &str,
        kind: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Resource>> {
        self.membership(workspace, user).await?;
        let rows = sqlx::query("SELECT r.* FROM resources r JOIN members m ON m.workspace_id = r.workspace_id AND m.user_id = $2 JOIN users u ON u.id = m.user_id AND u.disabled = 0 WHERE r.workspace_id = $1 AND r.kind = $3 AND (r.visibility = 'workspace' OR r.owner_id = $2) ORDER BY r.created_at DESC, r.id DESC LIMIT $4 OFFSET $5")
            .bind(workspace).bind(user).bind(kind).bind(limit.clamp(1, 500)).bind(offset.clamp(0, 10_000_000)).fetch_all(&self.pool).await?;
        rows.iter().map(resource_from_row).collect()
    }

    pub async fn update_resource(
        &self,
        workspace: &str,
        user: &str,
        id: &str,
        expected_version: i64,
        data: Value,
    ) -> Result<Resource> {
        let encoded = encode_data(&data)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        let role = role_in(&mut tx, workspace, user).await?;
        let mut resource = resource_in(&mut tx, workspace, id).await?;
        can_write(&resource, user, role)?;
        // A schedule runs with its owner's current authority. Sharing it grants
        // visibility, not permission to replace the owner's execution intent.
        // Moderators can still delete a shared schedule, but cannot change or
        // re-enable it on behalf of another user, even by a no-op update.
        if resource.kind == "schedules" && resource.owner_id != user {
            return Err(Error::Forbidden);
        }
        let version = expected_version.checked_add(1).ok_or(Error::Conflict)?;
        let changed = sqlx::query("UPDATE resources SET data = $1, version = $2, updated_at = $3 WHERE id = $4 AND workspace_id = $5 AND version = $6")
            .bind(encoded).bind(version).bind(now()).bind(id).bind(workspace).bind(expected_version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(Error::Conflict);
        }
        resource.data = data;
        resource.version = version;
        resource.updated_at = now();
        record_event(
            &mut tx,
            workspace,
            &resource.owner_id,
            resource.visibility,
            id,
            "resource.updated",
            &serde_json::json!({"kind":resource.kind,"version":version}),
        )
        .await?;
        tx.commit().await?;
        Ok(resource)
    }

    pub async fn delete_resource(
        &self,
        workspace: &str,
        user: &str,
        id: &str,
        expected_version: i64,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        let role = role_in(&mut tx, workspace, user).await?;
        let resource = resource_in(&mut tx, workspace, id).await?;
        can_write(&resource, user, role)?;
        let changed = sqlx::query(
            "DELETE FROM resources WHERE id = $1 AND workspace_id = $2 AND version = $3",
        )
        .bind(id)
        .bind(workspace)
        .bind(expected_version)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(Error::Conflict);
        }
        // A reconnect must not recover deleted message bodies from the event log.
        sqlx::query("DELETE FROM events WHERE workspace_id = $1 AND resource_id = $2")
            .bind(workspace)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        record_event(
            &mut tx,
            workspace,
            &resource.owner_id,
            resource.visibility,
            id,
            "resource.deleted",
            &serde_json::json!({"kind":resource.kind}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn append_event(
        &self,
        workspace: &str,
        user: &str,
        resource_id: &str,
        kind: &str,
        data: Value,
    ) -> Result<Event> {
        checked_label(kind, "event kind", 128)?;
        if serde_json::to_vec(&data)?.len() > 128 * 1024 {
            return Err(Error::Invalid("event exceeds 128 KiB".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        let role = role_in(&mut tx, workspace, user).await?;
        let resource = resource_in(&mut tx, workspace, resource_id).await?;
        can_write(&resource, user, role)?;
        let event = record_event(
            &mut tx,
            workspace,
            &resource.owner_id,
            resource.visibility,
            resource_id,
            kind,
            &data,
        )
        .await?;
        tx.commit().await?;
        Ok(event)
    }

    /// Durable, ordered replay. Authorization is evaluated by the replay query,
    /// so a revoked member cannot continue consuming a previously opened stream.
    pub async fn events(
        &self,
        workspace: &str,
        user: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<Event>> {
        self.membership(workspace, user).await?;
        let rows = sqlx::query("SELECT e.* FROM events e JOIN members m ON m.workspace_id = e.workspace_id AND m.user_id = $2 JOIN users u ON u.id = m.user_id AND u.disabled = 0 WHERE e.workspace_id = $1 AND e.id > $3 AND (e.visibility = 'workspace' OR e.owner_id = $2) ORDER BY e.id LIMIT $4")
            .bind(workspace).bind(user).bind(after.max(0)).bind(limit.clamp(1,500)).fetch_all(&self.pool).await?;
        rows.iter().map(event_from_row).collect()
    }

    /// Audit omits event payloads and respects private-resource boundaries.
    pub async fn audit(
        &self,
        workspace: &str,
        user: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<Event>> {
        self.require_role(workspace, user, Role::Admin).await?;
        let mut events = self.events(workspace, user, after, limit).await?;
        for event in &mut events {
            event.data = Value::Null;
        }
        Ok(events)
    }

    /// Scan trusted recovery/scheduler records in stable `(created_at, id)`
    /// order. Never expose this unscoped method as an HTTP or plugin operation.
    ///
    /// The first page fixes an inclusive upper position. Updates and removal of
    /// earlier records cannot shift subsequent pages, and newly appended records
    /// beyond the upper position wait for the next scan. This is not a database
    /// snapshot: a concurrent insertion behind the cursor is also picked up on
    /// the next scan. Startup recovery runs before accepting new work; recurring
    /// schedulers must begin a fresh scan on each pass.
    ///
    /// Batches contain at most `limit.clamp(1, 500)` records and 16 MiB of stored
    /// JSON (except that one record is always allowed to make progress). Keep
    /// following `next`, including after a short page: the byte bound can stop
    /// a page before its row limit. No total-record limit is imposed.
    pub async fn internal_list_page(
        &self,
        kind: &str,
        cursor: Option<&ResourceCursor>,
        limit: i64,
    ) -> Result<ResourcePage> {
        checked_label(kind, "resource kind", 64)?;
        if cursor.is_some_and(|cursor| cursor.kind != kind) {
            return Err(Error::Invalid(
                "resource scan cursor belongs to a different kind".into(),
            ));
        }
        let through = match cursor {
            Some(cursor) => cursor.through.clone(),
            None => {
                let row = sqlx::query(
                    "SELECT created_at, id FROM resources WHERE kind = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
                )
                .bind(kind)
                .fetch_optional(&self.pool)
                .await?;
                let Some(row) = row else {
                    return Ok(ResourcePage {
                        items: Vec::new(),
                        next: None,
                    });
                };
                (row.try_get("created_at")?, row.try_get("id")?)
            }
        };
        let limit = limit.clamp(1, 500);
        // A separate initial query avoids sentinel timestamps or IDs, including
        // for old imported records with negative creation timestamps.
        let query = if cursor.is_some() {
            "SELECT * FROM resources WHERE kind = $1 AND (created_at < $2 OR (created_at = $2 AND id <= $3)) AND (created_at > $4 OR (created_at = $4 AND id > $5)) ORDER BY created_at, id LIMIT $6"
        } else {
            "SELECT * FROM resources WHERE kind = $1 AND (created_at < $2 OR (created_at = $2 AND id <= $3)) ORDER BY created_at, id LIMIT $4"
        };
        let mut query = sqlx::query(query)
            .bind(kind)
            .bind(through.0)
            .bind(&through.1);
        if let Some(cursor) = cursor {
            query = query.bind(cursor.after.0).bind(&cursor.after.1);
        }
        let mut rows = query.bind(limit).fetch(&self.pool);
        let mut items = Vec::new();
        let mut bytes = 0usize;
        let mut byte_limited = false;
        while let Some(row) = rows.try_next().await? {
            let encoded: String = row.try_get("data")?;
            let size = encoded.len();
            if !items.is_empty() && size > RESOURCE_PAGE_BYTES.saturating_sub(bytes) {
                byte_limited = true;
                break;
            }
            bytes = bytes.saturating_add(size);
            drop(encoded);
            items.push(resource_from_row(&row)?);
        }
        drop(rows);
        let next = if byte_limited || items.len() == limit as usize {
            items.last().map(|last| ResourceCursor {
                kind: kind.to_owned(),
                after: (last.created_at, last.id.clone()),
                through,
            })
        } else {
            None
        };
        Ok(ResourcePage { items, next })
    }

    /// Legacy bounded internal list. Recovery and recurring scheduling must use
    /// `internal_list_page` so accumulated history cannot prevent startup.
    /// Never expose this method as an unscoped HTTP list.
    pub async fn internal_list(&self, kind: &str) -> Result<Vec<Resource>> {
        let rows = sqlx::query(
            "SELECT * FROM resources WHERE kind = $1 ORDER BY created_at, id LIMIT 10001",
        )
        .bind(kind)
        .fetch_all(&self.pool)
        .await?;
        if rows.len() > 10_000 {
            return Err(Error::Invalid(
                "internal scan exceeds 10,000 rows; use paginated recovery".into(),
            ));
        }
        rows.iter().map(resource_from_row).collect()
    }

    /// Trusted scheduler identity lookup; no authentication bypass is implied.
    pub async fn internal_get_resource(&self, id: &str) -> Result<Resource> {
        let row = sqlx::query("SELECT * FROM resources WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)?;
        resource_from_row(&row)
    }

    /// Atomically deletes a conversation and its run/event payloads. Linked
    /// schedules are paused, retaining their history without dispatching anew.
    pub async fn delete_conversation(
        &self,
        workspace: &str,
        user: &str,
        id: &str,
        expected_version: i64,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        let role = role_in(&mut tx, workspace, user).await?;
        let conversation = resource_in(&mut tx, workspace, id).await?;
        can_write(&conversation, user, role)?;
        if !matches!(conversation.kind.as_str(), "conversation" | "conversations") {
            return Err(Error::Invalid("resource is not a conversation".into()));
        }
        if conversation.version != expected_version {
            return Err(Error::Conflict);
        }
        // UUID IDs are safe as a LIKE needle, then parsed equality confirms the
        // semantic relationship. No database-specific JSON extension is needed.
        let rows = sqlx::query("SELECT * FROM resources WHERE workspace_id = $1 AND kind IN ('run','runs','task','schedule','schedules') AND data LIKE $2")
            .bind(workspace).bind(format!("%{id}%")).fetch_all(&mut *tx).await?;
        for row in rows {
            let mut child = resource_from_row(&row)?;
            if child.data.get("conversation_id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            if matches!(child.kind.as_str(), "run" | "runs") {
                sqlx::query("DELETE FROM events WHERE workspace_id = $1 AND resource_id = $2")
                    .bind(workspace)
                    .bind(&child.id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("DELETE FROM resources WHERE id = $1")
                    .bind(&child.id)
                    .execute(&mut *tx)
                    .await?;
            } else if let Some(data) = child.data.as_object_mut() {
                data.insert("enabled".into(), Value::Bool(false));
                data.insert("status".into(), Value::String("paused".into()));
                data.insert(
                    "pause_reason".into(),
                    Value::String("conversation_deleted".into()),
                );
                sqlx::query("UPDATE resources SET data = $1, version = version + 1, updated_at = $2 WHERE id = $3")
                    .bind(serde_json::to_string(&child.data)?).bind(now()).bind(&child.id).execute(&mut *tx).await?;
            }
        }
        sqlx::query("DELETE FROM events WHERE workspace_id = $1 AND resource_id = $2")
            .bind(workspace)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM resources WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        record_event(
            &mut tx,
            workspace,
            &conversation.owner_id,
            conversation.visibility,
            id,
            "resource.deleted",
            &serde_json::json!({"kind":conversation.kind}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Trusted scheduler identity lookup; no authentication bypass is implied.
    pub async fn user_by_id(&self, id: &str) -> Result<User> {
        let row = sqlx::query(
            "SELECT id, username, instance_admin FROM users WHERE id = $1 AND disabled = 0",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::NotFound)?;
        Ok(User {
            id: row.try_get("id")?,
            username: row.try_get("username")?,
            instance_admin: row.try_get::<i64, _>("instance_admin")? == 1,
        })
    }

    /// Trusted engine bookkeeping for an outcome already in flight when access
    /// was revoked. This must never authorize new work. CAS and existence checks
    /// prevent stale completions from recreating deleted or reset resources.
    pub async fn internal_update_resource(
        &self,
        id: &str,
        expected_version: i64,
        data: Value,
    ) -> Result<Resource> {
        let encoded = encode_data(&data)?;
        let workspace: String =
            sqlx::query_scalar("SELECT workspace_id FROM resources WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(Error::NotFound)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, &workspace).await?;
        let mut resource = resource_in(&mut tx, &workspace, id).await?;
        let version = expected_version.checked_add(1).ok_or(Error::Conflict)?;
        let changed = sqlx::query("UPDATE resources SET data = $1, version = $2, updated_at = $3 WHERE id = $4 AND version = $5")
            .bind(encoded).bind(version).bind(now()).bind(id).bind(expected_version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(Error::Conflict);
        }
        resource.data = data;
        resource.version = version;
        resource.updated_at = now();
        record_event(
            &mut tx,
            &workspace,
            &resource.owner_id,
            resource.visibility,
            id,
            "resource.updated",
            &serde_json::json!({"kind":resource.kind,"version":version}),
        )
        .await?;
        tx.commit().await?;
        Ok(resource)
    }

    /// Persist the receipt of an already-authorized external attempt, even after
    /// the actor is revoked. This does not grant permission to dispatch anything.
    pub async fn internal_append_event(
        &self,
        resource_id: &str,
        kind: &str,
        data: Value,
    ) -> Result<Event> {
        checked_label(kind, "event kind", 128)?;
        if serde_json::to_vec(&data)?.len() > 128 * 1024 {
            return Err(Error::Invalid("event exceeds 128 KiB".into()));
        }
        let workspace: String =
            sqlx::query_scalar("SELECT workspace_id FROM resources WHERE id = $1")
                .bind(resource_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(Error::NotFound)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, &workspace).await?;
        let resource = resource_in(&mut tx, &workspace, resource_id).await?;
        let event = record_event(
            &mut tx,
            &workspace,
            &resource.owner_id,
            resource.visibility,
            resource_id,
            kind,
            &data,
        )
        .await?;
        tx.commit().await?;
        Ok(event)
    }

    /// Atomically claims an idempotency key. A running/unknown request remains
    /// claimed after a crash; callers must reconcile it instead of replaying.
    pub async fn begin_operation(
        &self,
        workspace: &str,
        user: &str,
        key: &str,
        fingerprint: &str,
    ) -> Result<Option<Value>> {
        checked_label(key, "idempotency key", 200)?;
        checked_label(fingerprint, "operation fingerprint", 128)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Member {
            return Err(Error::Forbidden);
        }
        let existing = sqlx::query("SELECT fingerprint, state, result FROM operations WHERE workspace_id = $1 AND user_id = $2 AND operation_key = $3")
            .bind(workspace).bind(user).bind(key).fetch_optional(&mut *tx).await?;
        if let Some(row) = existing {
            if row.try_get::<String, _>("fingerprint")? != fingerprint
                || row.try_get::<String, _>("state")? != "complete"
            {
                return Err(Error::Conflict);
            }
            let result = serde_json::from_str(&row.try_get::<String, _>("result")?)?;
            tx.commit().await?;
            return Ok(Some(result));
        }
        sqlx::query("INSERT INTO operations (workspace_id, user_id, operation_key, fingerprint, state, result, created_at) VALUES ($1, $2, $3, $4, 'running', 'null', $5)")
            .bind(workspace).bind(user).bind(key).bind(fingerprint).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(None)
    }

    /// Records an already-observed outcome, including after membership revoked.
    /// Only the trusted engine should call this method.
    pub async fn finish_operation(
        &self,
        workspace: &str,
        user: &str,
        key: &str,
        result: Value,
    ) -> Result<()> {
        let encoded = encode_data(&result)?;
        let changed = sqlx::query("UPDATE operations SET result = $1, state = 'complete' WHERE workspace_id = $2 AND user_id = $3 AND operation_key = $4 AND state = 'running'")
            .bind(encoded).bind(workspace).bind(user).bind(key).execute(&self.pool).await?.rows_affected();
        if changed == 0 {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}

pub(crate) async fn resource_in(
    tx: &mut Transaction<'_, Any>,
    workspace: &str,
    id: &str,
) -> Result<Resource> {
    let row = sqlx::query("SELECT * FROM resources WHERE workspace_id = $1 AND id = $2")
        .bind(workspace)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
    resource_from_row(&row)
}

fn can_write(resource: &Resource, user: &str, role: Role) -> Result<()> {
    if role < minimum_role(&resource.kind)
        || (resource.visibility == Visibility::Private && resource.owner_id != user)
        || (resource.owner_id != user && role < Role::Operator)
    {
        return Err(Error::Forbidden);
    }
    Ok(())
}

fn minimum_role(kind: &str) -> Role {
    if matches!(kind, "models" | "plugins" | "routes" | "agents") {
        Role::Admin
    } else {
        Role::Member
    }
}

fn encode_data(data: &Value) -> Result<String> {
    let encoded = serde_json::to_string(data)?;
    if encoded.len() > 8 * 1024 * 1024 {
        return Err(Error::Invalid("resource exceeds 8 MiB".into()));
    }
    Ok(encoded)
}

pub(crate) async fn record_event(
    tx: &mut Transaction<'_, Any>,
    workspace: &str,
    owner: &str,
    visibility: Visibility,
    resource: &str,
    kind: &str,
    data: &Value,
) -> Result<Event> {
    let id: i64 = sqlx::query_scalar(
        "UPDATE counters SET value = value + 1 WHERE name = 'event' RETURNING value",
    )
    .fetch_one(&mut **tx)
    .await?;
    let created_at = now();
    sqlx::query("INSERT INTO events (id, workspace_id, owner_id, visibility, resource_id, kind, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
        .bind(id).bind(workspace).bind(owner).bind(visibility.as_str()).bind(resource).bind(kind).bind(serde_json::to_string(data)?).bind(created_at).execute(&mut **tx).await?;
    Ok(Event {
        id,
        workspace_id: workspace.to_owned(),
        resource_id: resource.to_owned(),
        kind: kind.to_owned(),
        data: data.clone(),
        created_at,
    })
}

fn event_from_row(row: &sqlx::any::AnyRow) -> Result<Event> {
    Ok(Event {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        resource_id: row.try_get("resource_id")?,
        kind: row.try_get("kind")?,
        data: serde_json::from_str(&row.try_get::<String, _>("data")?)?,
        created_at: row.try_get("created_at")?,
    })
}
