//! Bounded text indexing with authorization before retrieval.
//!
//! This is lexical retrieval over UTF-8 text/Markdown. It does not claim vector
//! embeddings, PDF parsing or semantic ranking that has not been implemented.
use crate::state::AppError;
use rstrbot_store::{Store, Visibility};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_SOURCE_BYTES: usize = 512 * 1024;
const CHUNK_BYTES: usize = 2048;
const OVERLAP_BYTES: usize = 192;
const MAX_DOCUMENTS: i64 = 500;
const MAX_RESULTS: usize = 8;

/// Validate source text and rebuild every derived chunk from that source.
/// Caller-supplied indexes are ignored; the resource's own CAS version protects
/// concurrent edits. `index_version` identifies this indexing algorithm and
/// `source_hash` identifies its immutable source generation.
pub fn validate_and_index(mut data: Value) -> Result<Value, AppError> {
    let object = data
        .as_object_mut()
        .ok_or_else(|| AppError::bad_request("Knowledge data must be an object"))?;
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() || title.len() > 512 {
        return Err(AppError::bad_request(
            "Document title must contain 1 to 512 bytes",
        ));
    }
    let title = title.to_owned();
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("A UTF-8 source text is required"))?;
    if text.trim().is_empty() || text.len() > MAX_SOURCE_BYTES || text.contains('\0') {
        return Err(AppError::bad_request(
            "Document must contain valid text, without NUL bytes, up to 512 KiB",
        ));
    }
    let digest = hex::encode(Sha256::digest(text.as_bytes()));
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + CHUNK_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end < text.len() {
            // Prefer a paragraph or line boundary when enough progress remains.
            if let Some(boundary) = text[start..end].rfind('\n')
                && boundary > CHUNK_BYTES / 2
            {
                end = start + boundary + 1;
            }
        }
        let ordinal = chunks.len();
        chunks.push(
            json!({"id":format!("{}-{ordinal}",&digest[..16]),"ordinal":ordinal,
            "start_byte":start,"end_byte":end,"text":&text[start..end]}),
        );
        if chunks.len() > 512 {
            return Err(AppError::bad_request("Document needs more than 512 chunks"));
        }
        if end == text.len() {
            break;
        }
        let mut next = end.saturating_sub(OVERLAP_BYTES).max(start + 1);
        while !text.is_char_boundary(next) {
            next += 1;
        }
        start = next;
    }
    object.retain(|key, _| matches!(key.as_str(), "title" | "text" | "enabled" | "archived"));
    object.insert("title".into(), title.into());
    object.insert("chunks".into(), chunks.into());
    object.insert("source_hash".into(), digest.into());
    object.insert("index_version".into(), 1.into());
    object.insert("index_kind".into(), "lexical-v1".into());
    object.insert("state".into(), "ready".into());
    object.insert("status".into(), "ready".into());
    object.insert("updated_at".into(), rstrbot_store::now().into());
    Ok(data)
}

fn terms(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut tokens: Vec<String> = lower
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .take(24)
        .map(str::to_owned)
        .collect();
    // CJK queries often have no spaces. Character bigrams provide a simple,
    // explicit lexical fallback without pretending to understand semantics.
    for token in tokens.clone() {
        if token
            .chars()
            .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
        {
            let characters: Vec<char> = token.chars().take(64).collect();
            for pair in characters.windows(2).take(24) {
                tokens.push(pair.iter().collect());
            }
        }
    }
    tokens.sort();
    tokens.dedup();
    tokens.truncate(48);
    tokens
}

/// A ready index must cover its source without gaps and name the same version.
fn consistent_index(data: &Value, source: &str, chunks: &[Value]) -> bool {
    if source.is_empty()
        || source.len() > MAX_SOURCE_BYTES
        || chunks.is_empty()
        || chunks.len() > 512
        || data.get("index_version").and_then(Value::as_u64) != Some(1)
        || data.get("index_kind").and_then(Value::as_str) != Some("lexical-v1")
    {
        return false;
    }
    let digest = hex::encode(Sha256::digest(source.as_bytes()));
    if data.get("source_hash").and_then(Value::as_str) != Some(digest.as_str()) {
        return false;
    }
    let mut previous_start = None;
    let mut previous_end = 0usize;
    for (ordinal, chunk) in chunks.iter().enumerate() {
        let Some((start, end)) = chunk
            .get("start_byte")
            .and_then(Value::as_u64)
            .and_then(|start| usize::try_from(start).ok())
            .zip(
                chunk
                    .get("end_byte")
                    .and_then(Value::as_u64)
                    .and_then(|end| usize::try_from(end).ok()),
            )
        else {
            return false;
        };
        let expected_id = format!("{}-{ordinal}", &digest[..16]);
        if start >= end
            || end - start > CHUNK_BYTES
            || start > previous_end
            || previous_start.is_some_and(|prior| start <= prior)
            || chunk.get("ordinal").and_then(Value::as_u64) != Some(ordinal as u64)
            || chunk.get("id").and_then(Value::as_str) != Some(expected_id.as_str())
            || source.get(start..end).is_none()
            || chunk.get("text").and_then(Value::as_str).is_none()
            || source.get(start..end) != chunk.get("text").and_then(Value::as_str)
        {
            return false;
        }
        previous_start = Some(start);
        previous_end = end;
    }
    previous_end == source.len()
}

/// Retrieve authorized chunks only. Private documents belonging to another
/// member are excluded by the database query before text is scored.
pub async fn search(store: &Store, wid: &str, user: &str, query: &str) -> Result<Value, AppError> {
    search_for_audience(store, wid, user, query, Visibility::Private).await
}

/// A caller may read their own private sources, but must not implicitly publish
/// them into a conversation whose audience includes other workspace members.
async fn search_for_audience(
    store: &Store,
    wid: &str,
    user: &str,
    query: &str,
    audience: Visibility,
) -> Result<Value, AppError> {
    let query = query.trim();
    if query.is_empty() || query.len() > 2048 {
        return Err(AppError::bad_request(
            "Search query must contain 1 to 2048 bytes",
        ));
    }
    let tokens = terms(query);
    if tokens.is_empty() {
        return Ok(
            json!({"items":[],"method":"lexical","truncated":false,"degraded":false,"degraded_reason":null,"inconsistent_documents":[]}),
        );
    }
    let mut truncated = false;
    let mut matches: Vec<(usize, String, Value)> = Vec::new();
    let phrase = query.to_lowercase();
    let mut scanned_bytes = 0usize;
    let mut scan_limited = false;
    let mut inconsistent_candidates = Vec::new();
    'pages: for offset in (0..MAX_DOCUMENTS).step_by(16) {
        let count = (MAX_DOCUMENTS - offset).min(16);
        let documents = store
            .list_resources(wid, user, "knowledge", count, offset)
            .await?;
        let last_page = documents.len() < (count as usize);
        if offset + count == MAX_DOCUMENTS && !last_page {
            truncated = true;
        }
        for document in documents {
            if (audience == Visibility::Workspace && document.visibility != Visibility::Workspace)
                || document.data.get("enabled") == Some(&Value::Bool(false))
                || document.data.get("archived") == Some(&Value::Bool(true))
                || document.data.get("state").and_then(Value::as_str) != Some("ready")
            {
                continue;
            }
            let Some(source) = document.data.get("text").and_then(Value::as_str) else {
                inconsistent_candidates.push((document.id.clone(), document.version));
                continue;
            };
            if source.len() > MAX_SOURCE_BYTES {
                inconsistent_candidates.push((document.id.clone(), document.version));
                continue;
            }
            scanned_bytes += source.len();
            if scanned_bytes > 16 * 1024 * 1024 {
                scan_limited = true;
                break 'pages;
            }
            let title = document
                .data
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let title_lower = title.to_lowercase();
            let Some(chunks) = document.data.get("chunks").and_then(Value::as_array) else {
                inconsistent_candidates.push((document.id.clone(), document.version));
                continue;
            };
            if !consistent_index(&document.data, source, chunks) {
                inconsistent_candidates.push((document.id.clone(), document.version));
                continue;
            }
            for chunk in chunks.iter().take(512) {
                let (Some(start), Some(end), Some(text)) = (
                    chunk.get("start_byte").and_then(Value::as_u64),
                    chunk.get("end_byte").and_then(Value::as_u64),
                    chunk.get("text").and_then(Value::as_str),
                ) else {
                    continue;
                };
                // Reject corrupt/stale derived data; never retrieve bytes that no
                // longer correspond to the stored source generation.
                if source.get(start as usize..end as usize) != Some(text) {
                    continue;
                }
                let haystack = text.to_lowercase();
                let phrase_score = if haystack.contains(&phrase) {
                    100usize
                } else {
                    0
                };
                let score = phrase_score
                    + tokens
                        .iter()
                        .map(|term| {
                            haystack.matches(term).count().min(5) * 4
                                + usize::from(title_lower.contains(term)) * 8
                        })
                        .sum::<usize>();
                if score == 0 {
                    continue;
                }
                let id = chunk.get("id").and_then(Value::as_str).unwrap_or("");
                let excerpt: String = text.chars().take(600).collect();
                let item = json!({"id":format!("{}:{id}",document.id),"document_id":document.id,
                "title":title,"excerpt":excerpt,"text":text,"score":score,"chunk":chunk.get("ordinal"),
                "chunk_id":id,"source_start":start,"source_end":end,"source_hash":document.data.get("source_hash"),
                "index_version":document.data.get("index_version")});
                matches.push((score, format!("{}:{id}", document.id), item));
                // Retain a small bounded working set while scanning many chunks.
                if matches.len() > 64 {
                    matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
                    matches.truncate(MAX_RESULTS);
                }
            }
        }
        if last_page {
            break;
        }
        tokio::task::yield_now().await;
    }
    matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    matches.truncate(MAX_RESULTS);
    // Recheck membership after potentially expensive scoring. Database reads
    // and emission are separate moments; each later engine action also checks.
    store.membership(wid, user).await?;
    let mut inconsistent_documents = Vec::new();
    for (id, version) in inconsistent_candidates {
        match store.get_resource(wid, user, &id).await {
            Ok(current)
                if current.version == version
                    && (audience != Visibility::Workspace
                        || current.visibility == Visibility::Workspace)
                    && current.data.get("enabled") != Some(&Value::Bool(false))
                    && current.data.get("archived") != Some(&Value::Bool(true))
                    && current.data.get("state").and_then(Value::as_str) == Some("ready") =>
            {
                let title = current
                    .data
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&id);
                inconsistent_documents.push(json!({"id":id,"title":title}));
            }
            Ok(_) | Err(rstrbot_store::Error::NotFound) | Err(rstrbot_store::Error::Forbidden) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let inconsistent = !inconsistent_documents.is_empty();
    let mut items = Vec::new();
    for (_, _, item) in matches {
        let Some(id) = item["document_id"].as_str() else {
            continue;
        };
        match store.get_resource(wid, user, id).await {
            Ok(current)
                if (audience != Visibility::Workspace
                    || current.visibility == Visibility::Workspace)
                    && current.data.get("source_hash") == item.get("source_hash")
                    && current.data.get("enabled") != Some(&Value::Bool(false))
                    && current.data.get("archived") != Some(&Value::Bool(true)) =>
            {
                items.push(item)
            }
            Ok(_) | Err(rstrbot_store::Error::NotFound) | Err(rstrbot_store::Error::Forbidden) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(
        json!({"items":items,"method":"lexical","truncated":truncated||scan_limited,"degraded":inconsistent,
        "degraded_reason":if inconsistent { Some("index_inconsistent") } else { None },"inconsistent_documents":inconsistent_documents,
        "limits":{"documents":MAX_DOCUMENTS,"scanned_source_bytes":16*1024*1024,"results":MAX_RESULTS}}),
    )
}

/// Engine context checks both the caller's access and the output audience.
/// Shared conversations include only explicitly workspace-visible sources.
pub async fn contexts(
    store: &Store,
    wid: &str,
    user: &str,
    query: &str,
    audience: Visibility,
) -> Result<Vec<Value>, AppError> {
    // A valid long chat message must not become an indexing error. Search uses
    // a bounded projection of it; permanent conversation text is unchanged.
    let mut end = query.len().min(2048);
    while !query.is_char_boundary(end) {
        end -= 1;
    }
    let query = &query[..end];
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let result = search_for_audience(store, wid, user, query, audience).await?;
    if result["degraded"] == true {
        let names = result["inconsistent_documents"]
            .as_array()
            .into_iter()
            .flatten()
            .take(5)
            .filter_map(|item| item["title"].as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            "knowledge_index_inconsistent",
            format!("Knowledge index inconsistent: {names}"),
        ));
    }
    Ok(result["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut context = json!({});
                    for key in [
                        "document_id",
                        "title",
                        "chunk_id",
                        "source_start",
                        "source_end",
                        "text",
                        "index_version",
                        "source_hash",
                    ] {
                        context[key] = item[key].clone();
                    }
                    context
                })
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integrity_check_detects_stale_or_incomplete_index_without_rejecting_valid_unicode() {
        let text = "段落🙂 source.\n".repeat(700);
        let valid = validate_and_index(json!({"title":"Source","text":text})).unwrap();
        let check = |value: &Value| {
            consistent_index(
                value,
                value["text"].as_str().unwrap(),
                value["chunks"].as_array().unwrap(),
            )
        };
        assert!(check(&valid));
        let mut changed = valid.clone();
        changed["chunks"][0]["text"] = json!("stale");
        assert!(!check(&changed));
        let mut missing_end = valid.clone();
        missing_end["chunks"].as_array_mut().unwrap().pop();
        assert!(!check(&missing_end));
        let mut missing_id = valid.clone();
        missing_id["chunks"][0]
            .as_object_mut()
            .unwrap()
            .remove("id");
        assert!(!check(&missing_id));
        let mut missing_hash = valid.clone();
        missing_hash.as_object_mut().unwrap().remove("source_hash");
        assert!(!check(&missing_hash));
    }
    #[test]
    fn unicode_chunks_are_bounded_and_source_exact() {
        let text = "段落与引文🙂，不会切坏 UTF-8。\n".repeat(500);
        let document =
            validate_and_index(json!({"title":"中文","text":text,"chunks":[{"text":"injected"}]}))
                .unwrap();
        let chunks = document["chunks"].as_array().unwrap();
        assert!(chunks.len() > 1);
        for chunk in chunks {
            let start = chunk["start_byte"].as_u64().unwrap() as usize;
            let end = chunk["end_byte"].as_u64().unwrap() as usize;
            assert_eq!(&text[start..end], chunk["text"].as_str().unwrap());
            assert!(end - start <= CHUNK_BYTES);
        }
        assert_eq!(
            chunks.last().unwrap()["end_byte"].as_u64().unwrap() as usize,
            text.len()
        );
    }
    #[test]
    fn invalid_and_oversized_documents_are_rejected() {
        for text in [
            "".to_string(),
            "nul\0byte".into(),
            "a".repeat(MAX_SOURCE_BYTES + 1),
        ] {
            assert!(validate_and_index(json!({"title":"x","text":text})).is_err());
        }
    }
    #[tokio::test]
    async fn lexical_retrieval_respects_same_workspace_privacy_and_deletion() {
        use rstrbot_store::{Role, Visibility};
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let owner = store
            .bootstrap("owner", "a-long-password-123", "workspace")
            .await
            .unwrap()
            .user;
        let workspace = store.workspaces(&owner.id).await.unwrap().remove(0);
        let member = store
            .create_user(&owner, "member", "another-long-password-123")
            .await
            .unwrap();
        store
            .set_member(&workspace.id, &owner.id, &member.id, Role::Member)
            .await
            .unwrap();
        let private = store
            .create_resource(
                &workspace.id,
                &owner.id,
                "knowledge",
                Visibility::Private,
                validate_and_index(json!({"title":"Secret","text":"needle private content"}))
                    .unwrap(),
            )
            .await
            .unwrap();
        let shared = store
            .create_resource(
                &workspace.id,
                &owner.id,
                "knowledge",
                Visibility::Workspace,
                validate_and_index(json!({"title":"Shared","text":"needle shared content"}))
                    .unwrap(),
            )
            .await
            .unwrap();
        let found = search(&store, &workspace.id, &member.id, "needle")
            .await
            .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
        assert_eq!(found["items"][0]["document_id"], shared.id);
        assert_ne!(found["items"][0]["document_id"], private.id);
        store
            .delete_resource(&workspace.id, &owner.id, &shared.id, shared.version)
            .await
            .unwrap();
        assert!(
            search(&store, &workspace.id, &member.id, "needle")
                .await
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        store
            .remove_member(&workspace.id, &owner.id, &member.id)
            .await
            .unwrap();
        assert!(
            search(&store, &workspace.id, &member.id, "needle")
                .await
                .is_err()
        );
    }
}
