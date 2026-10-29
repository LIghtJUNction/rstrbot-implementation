use crate::*;

impl Store {
    /// On restart, preserve the unknown outcome of image calls belonging to a
    /// run interrupted by the previous process. No external action is replayed.
    pub async fn mark_interrupted_image_costs(&self, workspace: &str, run_id: &str) -> Result<()> {
        uuid::Uuid::parse_str(run_id).map_err(|_| Error::Invalid("Invalid run ID".into()))?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        sqlx::query("UPDATE reservations SET state = 'unknown', updated_at = $1 WHERE workspace_id = $2 AND state = 'reserved' AND operation_id LIKE $3")
            .bind(now()).bind(workspace).bind(format!("{run_id}:model:%:image-unknown-cost"))
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn budget(&self, workspace: &str, user: &str) -> Result<Budget> {
        self.membership(workspace, user).await?;
        let row = sqlx::query("SELECT b.*, (SELECT COUNT(*) FROM reservations r WHERE r.workspace_id = b.workspace_id AND r.state = 'unknown') AS unknown_reservations FROM budgets b WHERE b.workspace_id = $1")
            .bind(workspace).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        let limit: i64 = row.try_get("limit_microusd")?;
        Ok(Budget {
            workspace_id: workspace.to_owned(),
            limit_microusd: if limit < 0 { None } else { Some(limit) },
            spent_microusd: row.try_get("spent_microusd")?,
            reserved_microusd: row.try_get("reserved_microusd")?,
            unknown_reservations: row.try_get("unknown_reservations")?,
        })
    }

    pub async fn set_budget(
        &self,
        workspace: &str,
        user: &str,
        limit: Option<i64>,
    ) -> Result<Budget> {
        if limit.is_some_and(|v| v < 0) {
            return Err(Error::Invalid("budget must be nonnegative".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Admin {
            return Err(Error::Forbidden);
        }
        if limit.is_some() {
            let active_unknown: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reservations WHERE workspace_id = $1 AND state = 'reserved' AND operation_id LIKE '%:image-unknown-cost'")
                .bind(workspace).fetch_one(&mut *tx).await?;
            if active_unknown > 0 {
                return Err(Error::ImageBudgetInFlight);
            }
        }
        sqlx::query("UPDATE budgets SET limit_microusd = $1 WHERE workspace_id = $2")
            .bind(limit.unwrap_or(-1))
            .bind(workspace)
            .execute(&mut *tx)
            .await?;
        crate::resources::record_event(
            &mut tx,
            workspace,
            user,
            Visibility::Workspace,
            workspace,
            "budget.updated",
            &serde_json::json!({"limit_microusd":limit}),
        )
        .await?;
        tx.commit().await?;
        self.budget(workspace, user).await
    }

    /// Reserve before dispatch. Duplicate operation IDs return their original
    /// reservation, never allocate twice. Unknown outcomes remain frozen.
    pub async fn reserve(
        &self,
        workspace: &str,
        user: &str,
        operation: &str,
        amount: i64,
    ) -> Result<Reservation> {
        self.reserve_inner(workspace, user, operation, amount, false)
            .await
    }

    /// Atomically exclude image dispatch while a workspace budget is enabled.
    pub async fn reserve_image_unknown(
        &self,
        workspace: &str,
        user: &str,
        operation: &str,
    ) -> Result<Reservation> {
        self.reserve_inner(
            workspace,
            user,
            &format!("{operation}:image-unknown-cost"),
            0,
            true,
        )
        .await
    }

    async fn reserve_inner(
        &self,
        workspace: &str,
        user: &str,
        operation: &str,
        amount: i64,
        image_unknown: bool,
    ) -> Result<Reservation> {
        checked_label(operation, "operation id", 200)?;
        if !(0..=i64::MAX / 4).contains(&amount) {
            return Err(Error::Invalid("invalid reservation amount".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Member {
            return Err(Error::Forbidden);
        }
        if image_unknown {
            let limit: i64 =
                sqlx::query_scalar("SELECT limit_microusd FROM budgets WHERE workspace_id = $1")
                    .bind(workspace)
                    .fetch_one(&mut *tx)
                    .await?;
            if limit >= 0 {
                return Err(Error::ImageBudgetEnabled);
            }
        }
        if let Some(row) =
            sqlx::query("SELECT * FROM reservations WHERE workspace_id = $1 AND operation_id = $2")
                .bind(workspace)
                .bind(operation)
                .fetch_optional(&mut *tx)
                .await?
        {
            let reservation = reservation_from_row(&row)?;
            if reservation.amount_microusd != amount || row.try_get::<String, _>("user_id")? != user
            {
                return Err(Error::Conflict);
            }
            tx.commit().await?;
            return Ok(reservation);
        }
        let changed = sqlx::query("UPDATE budgets SET reserved_microusd = reserved_microusd + $1 WHERE workspace_id = $2 AND reserved_microusd <= 9223372036854775807 - $1 AND spent_microusd <= 9223372036854775807 - reserved_microusd - $1 AND (limit_microusd < 0 OR spent_microusd + reserved_microusd <= limit_microusd - $1)")
            .bind(amount).bind(workspace).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(Error::BudgetExceeded);
        }
        let reservation = Reservation {
            id: new_id(),
            workspace_id: workspace.to_owned(),
            operation_id: operation.to_owned(),
            amount_microusd: amount,
            actual_microusd: None,
            state: "reserved".into(),
        };
        sqlx::query("INSERT INTO reservations (id, workspace_id, user_id, operation_id, amount_microusd, actual_microusd, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NULL, 'reserved', $6, $6)")
            .bind(&reservation.id).bind(workspace).bind(user).bind(operation).bind(amount).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(reservation)
    }

    /// Trusted accounting operation. `None` means cost unknown, retaining the
    /// entire reservation. A verified later cost may settle that frozen entry.
    /// Actual cost is recorded even when it exceeds the reservation or limit.
    pub async fn settle(&self, reservation_id: &str, actual: Option<i64>) -> Result<Reservation> {
        if actual.is_some_and(|v| !(0..=i64::MAX / 4).contains(&v)) {
            return Err(Error::Invalid("invalid actual cost".into()));
        }
        let workspace: String =
            sqlx::query_scalar("SELECT workspace_id FROM reservations WHERE id = $1")
                .bind(reservation_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(Error::NotFound)?;
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, &workspace).await?;
        let row = sqlx::query("SELECT * FROM reservations WHERE id = $1")
            .bind(reservation_id)
            .fetch_one(&mut *tx)
            .await?;
        let mut reservation = reservation_from_row(&row)?;
        if reservation.state == "settled" {
            if reservation.actual_microusd == actual {
                tx.commit().await?;
                return Ok(reservation);
            }
            return Err(Error::Conflict);
        }
        match actual {
            Some(actual) => {
                let row = sqlx::query(
                    "SELECT spent_microusd, reserved_microusd FROM budgets WHERE workspace_id = $1",
                )
                .bind(&workspace)
                .fetch_one(&mut *tx)
                .await?;
                let spent = row
                    .try_get::<i64, _>("spent_microusd")?
                    .checked_add(actual)
                    .ok_or_else(|| Error::Invalid("accounting overflow".into()))?;
                let reserved = row
                    .try_get::<i64, _>("reserved_microusd")?
                    .checked_sub(reservation.amount_microusd)
                    .filter(|v| *v >= 0)
                    .ok_or_else(|| Error::Invalid("reservation ledger is inconsistent".into()))?;
                sqlx::query("UPDATE budgets SET spent_microusd = $1, reserved_microusd = $2 WHERE workspace_id = $3")
                    .bind(spent).bind(reserved).bind(&workspace).execute(&mut *tx).await?;
                reservation.state = "settled".into();
                reservation.actual_microusd = Some(actual);
            }
            None => {
                reservation.state = "unknown".into();
            }
        }
        sqlx::query("UPDATE reservations SET state = $1, actual_microusd = $2, updated_at = $3 WHERE id = $4")
            .bind(&reservation.state).bind(reservation.actual_microusd).bind(now()).bind(reservation_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(reservation)
    }

    pub async fn reservations(
        &self,
        workspace: &str,
        user: &str,
        offset: i64,
        limit: i64,
    ) -> Result<ReservationPage> {
        let offset = offset.max(0);
        let limit = limit.clamp(1, 500);
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Admin {
            return Err(Error::Forbidden);
        }
        let total: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM reservations WHERE workspace_id = $1")
                .bind(workspace)
                .fetch_one(&mut *tx)
                .await?;
        let rows = sqlx::query("SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.workspace_id = r.workspace_id AND e.resource_id = r.id AND e.kind IN ('budget.reservation.reconciled','budget.reservation.corrected')) AS reconciliation_revision FROM reservations r WHERE r.workspace_id = $1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3")
            .bind(workspace).bind(limit).bind(offset).fetch_all(&mut *tx).await?;
        let summaries = rows
            .iter()
            .map(|row| {
                Ok(ReservationSummary {
                    reservation: reservation_from_row(row)?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    reconciliation_revision: row.try_get("reconciliation_revision")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let has_more = offset.saturating_add(summaries.len() as i64) < total;
        tx.commit().await?;
        Ok(ReservationPage {
            items: summaries,
            offset,
            limit,
            total,
            has_more,
        })
    }

    /// Record provider-reported cost through an administrator's explicit
    /// attestation. Workspace authorization, version check, ledger update and
    /// durable audit event share one serialized transaction.
    pub async fn reconcile_reservation(
        &self,
        workspace: &str,
        reservation_id: &str,
        user: &str,
        expected_revision: i64,
        actual_microusd: i64,
        source: &str,
        confirm_reported_cost: bool,
    ) -> Result<Reservation> {
        const MAX_AMOUNT: i64 = 9_007_199_254_740_991;
        if expected_revision < 0 {
            return Err(Error::Invalid("revision must be nonnegative".into()));
        }
        if !(0..=MAX_AMOUNT).contains(&actual_microusd) {
            return Err(Error::Invalid(
                "actual cost is outside the supported range".into(),
            ));
        }
        if !matches!(
            source,
            "usage_dashboard" | "invoice" | "usage_receipt" | "provider_adjustment"
        ) {
            return Err(Error::Invalid("unsupported cost source".into()));
        }
        if !confirm_reported_cost {
            return Err(Error::Invalid(
                "provider comparison must be confirmed".into(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Admin {
            return Err(Error::Forbidden);
        }
        let row = sqlx::query("SELECT * FROM reservations WHERE id = $1 AND workspace_id = $2")
            .bind(reservation_id)
            .bind(workspace)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let reservation = reservation_from_row(&row)?;
        let revision: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events WHERE workspace_id = $1 AND resource_id = $2 AND kind IN ('budget.reservation.reconciled','budget.reservation.corrected')")
            .bind(workspace).bind(reservation_id).fetch_one(&mut *tx).await?;

        if expected_revision != revision {
            // A lost response may be retried after the successful commit. Only
            // the latest identical request is acknowledged; an old form never
            // rolls the ledger back or creates another version.
            if revision > 0 {
                let latest = sqlx::query("SELECT owner_id, data FROM events WHERE workspace_id = $1 AND resource_id = $2 AND kind IN ('budget.reservation.reconciled','budget.reservation.corrected') ORDER BY id DESC LIMIT 1")
                    .bind(workspace).bind(reservation_id).fetch_optional(&mut *tx).await?;
                if let Some(latest) = latest {
                    let owner: String = latest.try_get("owner_id")?;
                    let data: Value = serde_json::from_str(&latest.try_get::<String, _>("data")?)?;
                    if owner == user
                        && data["expected_revision"].as_i64() == Some(expected_revision)
                        && data["actual_microusd"].as_i64() == Some(actual_microusd)
                        && data["source"].as_str() == Some(source)
                        && data["confirm_reported_cost"].as_bool() == Some(true)
                    {
                        tx.commit().await?;
                        return Ok(reservation);
                    }
                }
            }
            return Err(Error::Conflict);
        }

        let old_microusd = match (
            revision,
            reservation.state.as_str(),
            reservation.actual_microusd,
        ) {
            (0, "unknown", None) => None,
            (0, _, _) => return Err(Error::Conflict),
            (_, "settled", Some(old)) => Some(old),
            _ => return Err(Error::Conflict),
        };
        let budget = sqlx::query(
            "SELECT spent_microusd, reserved_microusd FROM budgets WHERE workspace_id = $1",
        )
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await?;
        let spent: i64 = budget.try_get("spent_microusd")?;
        let reserved: i64 = budget.try_get("reserved_microusd")?;
        let next_spent = spent
            .checked_sub(old_microusd.unwrap_or(0))
            .and_then(|value| value.checked_add(actual_microusd))
            .ok_or_else(|| Error::Invalid("accounting overflow".into()))?;
        let next_reserved = if revision == 0 {
            reserved
                .checked_sub(reservation.amount_microusd)
                .filter(|value| *value >= 0)
                .ok_or_else(|| Error::Invalid("reservation ledger is inconsistent".into()))?
        } else {
            reserved
        };
        sqlx::query("UPDATE budgets SET spent_microusd = $1, reserved_microusd = $2 WHERE workspace_id = $3")
            .bind(next_spent).bind(next_reserved).bind(workspace).execute(&mut *tx).await?;
        let timestamp = now();
        sqlx::query("UPDATE reservations SET state = 'settled', actual_microusd = $1, updated_at = $2 WHERE id = $3 AND workspace_id = $4")
            .bind(actual_microusd).bind(timestamp).bind(reservation_id).bind(workspace).execute(&mut *tx).await?;
        let data = serde_json::json!({
            "revision": revision + 1,
            "expected_revision": expected_revision,
            "old_microusd": old_microusd,
            "actual_microusd": actual_microusd,
            "source": source,
            "confirm_reported_cost": true,
        });
        crate::resources::record_event(
            &mut tx,
            workspace,
            user,
            Visibility::Workspace,
            reservation_id,
            if revision == 0 {
                "budget.reservation.reconciled"
            } else {
                "budget.reservation.corrected"
            },
            &data,
        )
        .await?;
        tx.commit().await?;

        let mut updated = reservation;
        updated.state = "settled".into();
        updated.actual_microusd = Some(actual_microusd);
        Ok(updated)
    }

    pub async fn reservation_reconciliations(
        &self,
        workspace: &str,
        reservation_id: &str,
        user: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<BudgetReconciliation>> {
        let mut tx = self.pool.begin().await?;
        lock_workspace(&mut tx, workspace).await?;
        if role_in(&mut tx, workspace, user).await? < Role::Admin {
            return Err(Error::Forbidden);
        }
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM reservations WHERE id = $1 AND workspace_id = $2",
        )
        .bind(reservation_id)
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await?;
        if exists == 0 {
            return Err(Error::NotFound);
        }
        let rows = sqlx::query("SELECT id, owner_id, data, created_at FROM events WHERE workspace_id = $1 AND resource_id = $2 AND id > $3 AND kind IN ('budget.reservation.reconciled','budget.reservation.corrected') ORDER BY id LIMIT $4")
            .bind(workspace).bind(reservation_id).bind(after.max(0)).bind(limit.clamp(1, 500)).fetch_all(&mut *tx).await?;
        let mut history = Vec::with_capacity(rows.len());
        for row in &rows {
            let data: Value = serde_json::from_str(&row.try_get::<String, _>("data")?)?;
            history.push(BudgetReconciliation {
                id: row.try_get("id")?,
                reservation_id: reservation_id.to_owned(),
                revision: data["revision"]
                    .as_i64()
                    .ok_or_else(|| Error::Invalid("invalid reconciliation history".into()))?,
                expected_revision: data["expected_revision"]
                    .as_i64()
                    .ok_or_else(|| Error::Invalid("invalid reconciliation history".into()))?,
                old_microusd: data["old_microusd"].as_i64(),
                actual_microusd: data["actual_microusd"]
                    .as_i64()
                    .ok_or_else(|| Error::Invalid("invalid reconciliation history".into()))?,
                source: data["source"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("invalid reconciliation history".into()))?
                    .to_owned(),
                performed_by: row.try_get("owner_id")?,
                created_at: row.try_get("created_at")?,
            });
        }
        tx.commit().await?;
        Ok(history)
    }
}

fn reservation_from_row(row: &sqlx::any::AnyRow) -> Result<Reservation> {
    Ok(Reservation {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        operation_id: row.try_get("operation_id")?,
        amount_microusd: row.try_get("amount_microusd")?,
        actual_microusd: row.try_get("actual_microusd")?,
        state: row.try_get("state")?,
    })
}
