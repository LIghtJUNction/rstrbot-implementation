//! OpenAI-compatible wire handling, kept outside the core.
//! No remote request is retried here. Missing usage remains JSON `null`.
use crate::{
    MAX_FRAME_BYTES,
    sdk::{PluginCall, RpcFailure},
};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use url::Url;

const MAX_RESPONSE_BYTES: usize = MAX_FRAME_BYTES / 3;

/// Validate and resolve the provider once, then pin the connection addresses.
/// Redirects and environment proxies are disabled to preserve the approved target.
pub async fn approved_client(
    base: &str,
    allow_private: bool,
) -> Result<(reqwest::Client, Url), RpcFailure> {
    let mut url =
        Url::parse(base).map_err(|_| RpcFailure::invalid("Provider base URL is invalid"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(RpcFailure::invalid(
            "Provider URL cannot contain credentials, query parameters or fragments",
        ));
    }
    if url.scheme() != "https" && !(allow_private && url.scheme() == "http") {
        return Err(RpcFailure::invalid(
            "HTTPS is required; local HTTP needs administrator-approved private networking",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| RpcFailure::invalid("Provider URL has no host"))?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| RpcFailure::invalid("Provider port is invalid"))?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .map_err(|_| RpcFailure::failed("Provider DNS resolution timed out"))?
    .map_err(|_| RpcFailure::failed("Provider DNS resolution failed"))?
    .take(16)
    .collect();
    if addresses.is_empty()
        || (!allow_private
            && addresses
                .iter()
                .any(|address| !public_address(address.ip())))
    {
        return Err(RpcFailure::invalid(
            "Provider resolves to an unapproved private or reserved network",
        ));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(110))
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|_| RpcFailure::failed("Provider HTTP client could not start"))?;
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok((client, url))
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_address(IpAddr::V4(v4));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8))
        }
    }
}

fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcFailure> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 8192)
        .ok_or_else(|| RpcFailure::invalid(&format!("Missing or invalid {name}")))
}

fn authenticated(
    request: reqwest::RequestBuilder,
    params: &Value,
) -> Result<reqwest::RequestBuilder, RpcFailure> {
    match params.get("api_key").and_then(Value::as_str) {
        Some(key) if key.len() > 8192 || key.contains(['\n', '\r']) => {
            Err(RpcFailure::invalid("Invalid provider credential"))
        }
        Some(key) if !key.is_empty() => Ok(request.bearer_auth(key)),
        _ => Ok(request),
    }
}

fn provider_rejection(status: reqwest::StatusCode) -> RpcFailure {
    let (code, message) = match status.as_u16() {
        401 => (-32041, "Provider authentication failed"),
        403 => (-32043, "Provider denied access"),
        429 => (-32029, "Provider rate limited the request"),
        _ => return RpcFailure::failed(&format!("Provider returned HTTP {}", status.as_u16())),
    };
    RpcFailure {
        code,
        message: message.into(),
    }
}

async fn bounded_json(response: reqwest::Response) -> Result<Value, RpcFailure> {
    if !response.status().is_success() {
        return Err(provider_rejection(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RpcFailure::failed("Provider response exceeds byte limit"));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| {
            RpcFailure::failed("Provider response interrupted; usage may be unknown")
        })?;
        if body.len() + part.len() > MAX_RESPONSE_BYTES {
            return Err(RpcFailure::failed("Provider response exceeds byte limit"));
        }
        body.extend_from_slice(&part);
    }
    serde_json::from_slice(&body).map_err(|_| RpcFailure::failed("Provider returned invalid JSON"))
}

/// Dispatch the model protocol. All model requests use identical effective configuration.
pub async fn dispatch(
    method: String,
    params: Value,
    call: PluginCall,
) -> Result<Value, RpcFailure> {
    let operation = async {
        let (client, base) = approved_client(
            string(&params, "base_url")?,
            params
                .get("allow_private_network")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .await?;
        match method.as_str() {
            "model.list" => {
                let url = base
                    .join("models")
                    .map_err(|_| RpcFailure::invalid("Invalid models URL"))?;
                let response = authenticated(client.get(url), &params)?
                    .send()
                    .await
                    .map_err(|_| RpcFailure::failed("Provider connection failed"))?;
                let models = bounded_json(response).await?;
                Ok(
                    json!({"models":models.get("data").cloned().unwrap_or(models),"tested":"discovery"}),
                )
            }
            "model.generate" | "model.test" => {
                generate(&client, &base, &params, &call, method == "model.test").await
            }
            _ => Err(RpcFailure::not_found()),
        }
    };
    tokio::select! {
        _ = call.cancellation.cancelled() => Err(RpcFailure::cancelled()),
        result = operation => result,
    }
}

async fn generate(
    client: &reqwest::Client,
    base: &Url,
    params: &Value,
    call: &PluginCall,
    test: bool,
) -> Result<Value, RpcFailure> {
    let model = string(params, "model")?;
    let messages = if test {
        json!([{"role":"user","content":"Reply with OK."}])
    } else {
        params
            .get("messages")
            .filter(|messages| messages.is_array())
            .cloned()
            .ok_or_else(|| RpcFailure::invalid("messages must be an array"))?
    };
    if messages
        .as_array()
        .is_some_and(|messages| messages.is_empty() || messages.len() > 512)
    {
        return Err(RpcFailure::invalid(
            "messages must contain 1 to 512 entries",
        ));
    }
    let stream = !test
        && params
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(true);
    let max_tokens = if test {
        8
    } else {
        params
            .get("max_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(2048)
    };
    if max_tokens == 0 || max_tokens > 131_072 {
        return Err(RpcFailure::invalid(
            "max_tokens is outside supported bounds",
        ));
    }
    let mut body =
        json!({"model":model,"messages":messages,"max_tokens":max_tokens,"stream":stream});
    if stream {
        body["stream_options"] = json!({"include_usage":true});
    }
    if let Some(temperature) = params.get("temperature") {
        if !temperature
            .as_f64()
            .is_some_and(|value| (0.0..=2.0).contains(&value))
        {
            return Err(RpcFailure::invalid("temperature must be between 0 and 2"));
        }
        body["temperature"] = temperature.clone();
    }
    if !test && let Some(tools) = params.get("tools") {
        if !tools.as_array().is_some_and(|tools| tools.len() <= 128) {
            return Err(RpcFailure::invalid("tools must be a bounded array"));
        }
        if !tools.as_array().is_some_and(Vec::is_empty) {
            body["tools"] = tools.clone();
            body["tool_choice"] = params.get("tool_choice").cloned().unwrap_or(json!("auto"));
        }
    }
    let url = base
        .join("chat/completions")
        .map_err(|_| RpcFailure::invalid("Invalid completion URL"))?;
    let response = authenticated(client.post(url).json(&body), params)?
        .send()
        .await
        .map_err(|_| {
            RpcFailure::failed("Provider connection failed; request usage may be unknown")
        })?;
    if !response.status().is_success() {
        return Err(provider_rejection(response.status()));
    }
    if !stream {
        let result = bounded_json(response).await?;
        let choice = result
            .pointer("/choices/0")
            .ok_or_else(|| RpcFailure::failed("Provider returned no choices"))?;
        let message = choice
            .get("message")
            .filter(|message| message.is_object())
            .ok_or_else(|| RpcFailure::failed("Provider returned no assistant message"))?;
        validate_message(message)?;
        return Ok(
            json!({"message":message,"finish_reason":choice.get("finish_reason").unwrap_or(&Value::Null),"usage":result.get("usage").unwrap_or(&Value::Null),"provider_state":{"id":result.get("id"),"model":result.get("model"),"system_fingerprint":result.get("system_fingerprint")},"tested":if test {Some("invocation")} else {None}}),
        );
    }
    let mut size = 0usize;
    let bytes = response.bytes_stream().map(move |part| {
        let part = part.map_err(|_| std::io::Error::other("provider stream interrupted"))?;
        size += part.len();
        if size > MAX_RESPONSE_BYTES {
            return Err(std::io::Error::other("provider stream exceeds byte limit"));
        }
        Ok(part)
    });
    let mut events = bytes.eventsource();
    let mut accumulator = Completion::default();
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| {
            RpcFailure::failed(
                "Provider stream interrupted or exceeded limits; usage may be unknown",
            )
        })?;
        if event.data == "[DONE]" {
            break;
        }
        let chunk: Value = serde_json::from_str(&event.data)
            .map_err(|_| RpcFailure::failed("Provider sent invalid stream JSON"))?;
        accumulator.raw_chunks.push(chunk.clone());
        if chunk.get("error").is_some() {
            return Err(RpcFailure::failed("Provider reported a stream error"));
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            accumulator.usage = usage.clone();
        }
        if let Some(choice) = chunk.pointer("/choices/0") {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                accumulator.finish_reason = Some(reason.into());
            }
            if let Some(delta) = choice.get("delta") {
                accumulator.push(delta)?;
                let mut progress = delta.clone();
                if !progress.is_object() {
                    progress = json!({});
                }
                call.emit("model.delta", progress).await?;
            }
        }
    }
    accumulator.finish()
}

#[derive(Default)]
struct Completion {
    content: String,
    tools: BTreeMap<u64, Value>,
    extra: Map<String, Value>,
    usage: Value,
    finish_reason: Option<String>,
    raw_chunks: Vec<Value>,
}
impl Completion {
    fn push(&mut self, delta: &Value) -> Result<(), RpcFailure> {
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| RpcFailure::failed("Stream tool call has no index"))?;
                if index >= 128 {
                    return Err(RpcFailure::failed("Too many tool calls"));
                }
                let target = self.tools.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                for key in ["id", "type"] {
                    if let Some(value) = call.get(key).filter(|value| !value.is_null()) {
                        target[key] = value.clone();
                    }
                }
                if let Some(function) = call.get("function") {
                    for key in ["name", "arguments"] {
                        if let Some(fragment) = function.get(key).and_then(Value::as_str) {
                            let current = target["function"][key].as_str().unwrap_or_default();
                            target["function"][key] = format!("{current}{fragment}").into();
                        }
                    }
                }
                if let Some(object) = call.as_object() {
                    for (key, value) in object {
                        if !matches!(key.as_str(), "index" | "id" | "type" | "function") {
                            target[key] = value.clone();
                        }
                    }
                }
            }
        }
        if let Some(object) = delta.as_object() {
            for (key, value) in object {
                if matches!(key.as_str(), "role" | "content" | "tool_calls") {
                    continue;
                }
                // Known content fragments can be concatenated. Unknown vendor
                // fields have no universal merge rule: retain their latest
                // value here and every original chunk in provider_state.
                if matches!(key.as_str(), "reasoning_content" | "reasoning")
                    && let Some(text) = value.as_str()
                {
                    let current = self
                        .extra
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.extra
                        .insert(key.clone(), format!("{current}{text}").into());
                } else {
                    self.extra.insert(key.clone(), value.clone());
                }
            }
        }
        Ok(())
    }
    fn finish(self) -> Result<Value, RpcFailure> {
        let reason = self.finish_reason.ok_or_else(|| {
            RpcFailure::failed(
                "Provider stream ended without a completion marker; usage may be unknown",
            )
        })?;
        let mut message = Value::Object(self.extra);
        message["role"] = "assistant".into();
        message["content"] = if self.content.is_empty() {
            Value::Null
        } else {
            self.content.into()
        };
        if !self.tools.is_empty() {
            message["tool_calls"] = self.tools.into_values().collect::<Vec<_>>().into();
        }
        validate_message(&message)?;
        Ok(
            json!({"message":message,"finish_reason":reason,"usage":self.usage,"provider_state":{"raw_chunks":self.raw_chunks}}),
        )
    }
}

fn validate_message(message: &Value) -> Result<(), RpcFailure> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Err(RpcFailure::failed("Expected an assistant message"));
    }
    if let Some(tools) = message.get("tool_calls").and_then(Value::as_array) {
        if tools.len() > 128 {
            return Err(RpcFailure::failed("Too many tool calls"));
        }
        for tool in tools {
            if tool
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || tool
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || tool
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .is_none()
            {
                return Err(RpcFailure::failed("Incomplete tool call from provider"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_fragments_preserve_ids_and_vendor_state() {
        let mut value = Completion::default();
        value.push(&json!({"tool_calls":[{"index":2,"id":"call_x","function":{"name":"lookup","arguments":"{\"q\":"}}]})).unwrap();
        value.push(&json!({"tool_calls":[{"index":2,"function":{"arguments":"\"a\"}"}}],"reasoning_content":"private trace","signature":"abc"})).unwrap();
        value.finish_reason = Some("tool_calls".into());
        let result = value.finish().unwrap();
        assert_eq!(
            result.pointer("/message/tool_calls/0/id"),
            Some(&json!("call_x"))
        );
        assert_eq!(
            result.pointer("/message/tool_calls/0/function/arguments"),
            Some(&json!("{\"q\":\"a\"}"))
        );
        assert_eq!(result.pointer("/message/signature"), Some(&json!("abc")));
        assert_eq!(result["usage"], Value::Null);
    }
    #[test]
    fn private_and_reserved_targets_are_not_public() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "224.0.0.1",
            "192.0.2.1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
        assert!(public_address("2606:4700:4700::1111".parse().unwrap()));
    }
    #[tokio::test]
    async fn rejects_credentials_and_unapproved_http_before_connecting() {
        assert!(
            approved_client("https://user:secret@example.com/v1", false)
                .await
                .is_err()
        );
        assert!(
            approved_client("http://127.0.0.1:1234/v1", false)
                .await
                .is_err()
        );
    }
    #[test]
    fn incomplete_tool_and_stream_are_errors() {
        assert!(Completion::default().finish().is_err());
        assert!(validate_message(&json!({"role":"assistant","tool_calls":[{"function":{"name":"x","arguments":"{}"}}]})).is_err());
    }
}
