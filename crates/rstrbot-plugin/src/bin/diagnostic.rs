//! Deterministic protocol fixture. This is explicitly not an AI model.
use rstrbot_plugin::sdk::{self, RpcFailure};
use serde_json::{Value, json};

#[tokio::main]
async fn main() {
    let result = sdk::serve(&["model", "tools"], |method, params, call| async move {
        match method.as_str() {
            "model.list" => Ok(json!({"models":[{"id":"diagnostic","name":"Diagnostic fixture (not an AI model)"}],"fixture":true})),
            "model.test" => Ok(json!({"message":{"role":"assistant","content":"Diagnostic fixture is connected."},"finish_reason":"stop","usage":null,"fixture":true})),
            "model.generate" => {
                let messages = params.get("messages").and_then(Value::as_array).ok_or_else(|| RpcFailure::invalid("messages must be an array"))?;
                if let Some(last) = messages.last() {
                    let text = last.get("content").and_then(Value::as_str).unwrap_or_default();
                    if text == "/diagnostic/wait" {
                        tokio::select! {
                            _ = call.cancellation.cancelled() => return Err(RpcFailure::cancelled()),
                            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
                        }
                    }
                    if text.starts_with("/diagnostic/tool ") && params.get("tool_choice").and_then(Value::as_str) != Some("none") {
                        let permitted = params.get("tools").and_then(Value::as_array).and_then(|tools| tools.first()).and_then(|tool| tool.pointer("/function/name")).and_then(Value::as_str);
                        if let Some(name) = permitted {
                            let call_id = if text == "/diagnostic/tool exactly-32-tools" { "catalog_fixed_tool_call".to_owned() } else { format!("diag_{}",call.request_id) };
                            return Ok(json!({"message":{"role":"assistant","content":null,"tool_calls":[{"id":call_id,"type":"function","function":{"name":name,"arguments":json!({"text":text.trim_start_matches("/diagnostic/tool ")}).to_string()}}]},"finish_reason":"tool_calls","usage":null,"fixture":true}));
                        }
                    }
                    let content = if last.get("role").and_then(Value::as_str) == Some("tool") {
                        format!("[Diagnostic fixture · not AI] Tool result received: {text}")
                    } else { format!("[Diagnostic fixture · not AI] Received: {text}") };
                    if params.get("stream").and_then(Value::as_bool).unwrap_or(true) {
                        for chunk in content.chars().collect::<Vec<_>>().chunks(16) {
                            call.emit("model.delta",json!({"content":chunk.iter().collect::<String>()})).await?;
                        }
                    }
                    return Ok(json!({"message":{"role":"assistant","content":content},"finish_reason":"stop","usage":null,"fixture":true}));
                }
                Err(RpcFailure::invalid("messages cannot be empty"))
            },
            "tools.list" => Ok(json!({"tools":[{"name":"echo","description":"Return the provided text; no filesystem, network or writes.","effect":"read_only","input_schema":{"type":"object","properties":{"text":{"type":"string","maxLength":16384}},"required":["text"],"additionalProperties":false}}]})),
            "tools.call" => {
                if params.get("name").and_then(Value::as_str) != Some("echo") { return Err(RpcFailure::not_found()); }
                let text = params.pointer("/arguments/text").and_then(Value::as_str).filter(|text| text.len() <= 16384).ok_or_else(|| RpcFailure::invalid("text must be at most 16384 bytes"))?;
                call.emit("tool.progress", json!({"stage":"received"})).await?;
                Ok(json!({"content":text,"effect":"read_only","call_id":params.get("call_id").cloned().unwrap_or(Value::Null)}))
            },
            _ => Err(RpcFailure::not_found()),
        }
    }).await;
    if let Err(error) = result {
        eprintln!("{}", error.code());
        std::process::exit(1);
    }
}
