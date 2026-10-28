#![cfg(unix)]
use rstrbot_plugin::{InstanceContext, Manifest, PluginError, PluginHost, Timeouts};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn manifest() -> Manifest {
    Manifest {
        id: "diagnostic".into(),
        version: "0.1.0".into(),
        executable: env!("CARGO_BIN_EXE_rstrbot-diagnostic").into(),
        args: vec![],
        capabilities: vec!["model".into(), "tools".into()],
        permissions: vec![],
        sha256: None,
        timeouts: Timeouts::default(),
    }
}
fn context() -> InstanceContext {
    InstanceContext {
        workspace_id: "workspace-a".into(),
        instance_id: "instance-a".into(),
        generation: 7,
    }
}

#[tokio::test]
async fn provider_rejections_remain_classified_and_do_not_expose_response_bodies() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, expected) in [
        (401, "provider_authentication_failed"),
        (403, "provider_access_denied"),
        (429, "provider_rate_limited"),
        (500, "plugin_error"),
    ] {
        for method in ["model.list", "model.generate", "model.test"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 65536];
                let count = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(request.starts_with(if method == "model.list" {
                    "GET /v1/models"
                } else {
                    "POST /v1/chat/completions"
                }));
                let body = "FIXTURE-SECRET-NEVER-SHOW";
                let response = format!(
                    "HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let host = PluginHost::new(dir.path().into());
            let mut provider = manifest();
            provider.executable = env!("CARGO_BIN_EXE_rstrbot-openai").into();
            provider.capabilities = vec!["model".into()];
            let error = host.call(&provider, &context(), method, json!({"base_url":format!("http://{address}/v1"),"allow_private_network":true,"model":"fixture-upstream","messages":[{"role":"user","content":"test"}],"stream":true}), CancellationToken::new(), None).await.unwrap_err();
            assert_eq!(error.code(), expected, "{method} HTTP {status}");
            assert!(!error.to_string().contains("FIXTURE-SECRET-NEVER-SHOW"));
            server.await.unwrap();
        }
    }
}

#[tokio::test]
async fn authority_is_rechecked_after_handshake_before_business_rpc() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let directory = tempfile::Builder::new()
        .prefix("rb-host-")
        .tempdir()
        .unwrap();
    let host = PluginHost::new(directory.path().into());
    let checks = AtomicUsize::new(0);
    let (sender, mut events) = tokio::sync::mpsc::channel(4);
    let result = host
        .call_authorized(
            &manifest(),
            &context(),
            (
                "tools.call",
                json!({"name":"echo","arguments":{"text":"must-not-run"}}),
            ),
            CancellationToken::new(),
            Some(sender),
            || async {
                // The first check allows worker startup; the second denies the
                // business call after a real protocol handshake has completed.
                if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err(PluginError::Cancelled)
                }
            },
        )
        .await;
    assert!(matches!(result, Err(PluginError::Cancelled)));
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    assert!(
        events.try_recv().is_err(),
        "no tool progress may precede authorization"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn real_process_echo_handshake_stream_and_cleanup() {
    let dir = tempfile::Builder::new()
        .prefix("rb-host-")
        .tempdir()
        .unwrap();
    let host = PluginHost::new(dir.path().into());
    let (sender, mut receiver) = tokio::sync::mpsc::channel(16);
    let result = host
        .call(
            &manifest(),
            &context(),
            "tools.call",
            json!({"name":"echo","arguments":{"text":"你好\nworld"}}),
            CancellationToken::new(),
            Some(sender),
        )
        .await
        .unwrap();
    assert_eq!(result["content"], "你好\nworld");
    assert_eq!(receiver.recv().await.unwrap().method, "tool.progress");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn denial_happens_without_starting_a_worker() {
    let dir = tempfile::tempdir().unwrap();
    let host = PluginHost::new(dir.path().into());
    let error = host
        .call(
            &manifest(),
            &context(),
            "platform.send",
            json!({}),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, PluginError::CapabilityDenied(_)));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn cancellation_and_deadline_reclaim_worker_and_socket() {
    let dir = tempfile::Builder::new()
        .prefix("rb-host-")
        .tempdir()
        .unwrap();
    let host = PluginHost::new(dir.path().into());
    let token = CancellationToken::new();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.cancel();
    });
    let error = host
        .call(
            &manifest(),
            &context(),
            "model.generate",
            json!({"messages":[{"role":"user","content":"/diagnostic/wait"}]}),
            token,
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, PluginError::Cancelled));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let mut short = manifest();
    short.timeouts.call_ms = 100;
    let error = host
        .call(
            &short,
            &context(),
            "model.generate",
            json!({"messages":[{"role":"user","content":"/diagnostic/wait"}]}),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, PluginError::Timeout("invocation")));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn checksum_failure_prevents_execution() {
    let dir = tempfile::tempdir().unwrap();
    let host = PluginHost::new(dir.path().into());
    let mut bad = manifest();
    bad.sha256 = Some("0".repeat(64));
    let error = host
        .call(
            &bad,
            &context(),
            "tools.list",
            json!({}),
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, PluginError::ChecksumMismatch));
}

#[tokio::test]
async fn model_provider_preserves_streamed_tool_calls_and_unknown_usage() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 65536];
        let count = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..count]);
        assert!(request.starts_with("POST /v1/chat/completions"));
        let chunks = [
            json!({"choices":[{"delta":{"tool_calls":[{"index":3,"id":"call-42","type":"function","function":{"name":"echo","arguments":"{\"text\":"}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":3,"function":{"arguments":"\"ok\"}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let body = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            chunks[0], chunks[1]
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    let dir = tempfile::Builder::new()
        .prefix("rb-host-")
        .tempdir()
        .unwrap();
    let host = PluginHost::new(dir.path().into());
    let mut provider = manifest();
    provider.executable = env!("CARGO_BIN_EXE_rstrbot-openai").into();
    provider.capabilities = vec!["model".into()];
    let result=host.call(&provider,&context(),"model.generate",json!({"base_url":format!("http://{address}/v1"),"allow_private_network":true,"model":"fixture-upstream","messages":[{"role":"user","content":"test"}],"stream":true}),CancellationToken::new(),None).await.unwrap();
    assert_eq!(
        result.pointer("/message/tool_calls/0/id"),
        Some(&json!("call-42"))
    );
    assert_eq!(
        result.pointer("/message/tool_calls/0/function/arguments"),
        Some(&json!("{\"text\":\"ok\"}"))
    );
    assert!(result["usage"].is_null());
    server.await.unwrap();
}

#[tokio::test]
async fn durable_webhook_receipt_prevents_replay_and_parameter_changes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 4096];
        let count = stream.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..count])
                .to_ascii_lowercase()
                .contains("idempotency-key: send-1")
        );
        stream
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let journal = tempfile::tempdir().unwrap();
    let parameters = json!({"url":format!("http://{address}/messages"),"allow_private_network":true,"operation_id":"send-1","text":"hello"});
    let first = rstrbot_plugin::webhook::send_once(journal.path(), &parameters)
        .await
        .unwrap();
    assert_eq!(first["delivery"], "accepted");
    server.await.unwrap();
    let repeated = rstrbot_plugin::webhook::send_once(journal.path(), &parameters)
        .await
        .unwrap();
    assert_eq!(repeated, first);
    let mut changed = parameters;
    changed["text"] = "different intent".into();
    assert!(
        rstrbot_plugin::webhook::send_once(journal.path(), &changed)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn unknown_webhook_delivery_remains_unknown_after_restart() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        // Simulate a destination accepting the body but losing its receipt.
        drop(stream);
    });
    let journal = tempfile::tempdir().unwrap();
    let parameters = json!({"url":format!("http://{address}/messages"),"allow_private_network":true,"operation_id":"send-unknown","text":"hello"});
    let first = rstrbot_plugin::webhook::send_once(journal.path(), &parameters)
        .await
        .unwrap();
    assert_eq!(first["delivery"], "unknown");
    server.await.unwrap();
    let repeated = rstrbot_plugin::webhook::send_once(journal.path(), &parameters)
        .await
        .unwrap();
    assert_eq!(repeated, first);
}

#[tokio::test]
async fn cancellation_terminates_worker_descendants_in_its_process_group() {
    use std::os::unix::fs::PermissionsExt;
    let python = ["/usr/bin/python3", "/usr/local/bin/python3"]
        .iter()
        .map(std::path::Path::new)
        .find(|path| path.exists())
        .expect("Python 3 is required only for the descendant process test fixture");
    let fixture = tempfile::tempdir().unwrap();
    let script = fixture.path().join("worker.py");
    std::fs::write(&script,r#"import json, os, socket, subprocess, sys, time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(os.environ['RSTRBOT_SOCKET']);f=s.makefile('rwb')
def send(v):f.write(json.dumps(v).encode()+b'\n');f.flush()
h=json.loads(f.readline());c=json.loads(os.environ['RSTRBOT_CONTEXT']);send({'jsonrpc':'2.0','id':h['id'],'result':dict(c,protocol_version='1.0',capabilities=['tools'])})
r=json.loads(f.readline());p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
send({'jsonrpc':'2.0','method':'tool.progress','params':{'request_id':r['id'],'child_pid':p.pid}})
time.sleep(60)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut worker = manifest();
    worker.executable = python.into();
    worker.args = vec![script.to_string_lossy().into()];
    worker.capabilities = vec!["tools".into()];
    let runtime = tempfile::Builder::new()
        .prefix("rb-host-")
        .tempdir()
        .unwrap();
    let host = PluginHost::new(runtime.path().into());
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
    let execution = tokio::spawn(async move {
        host.call(
            &worker,
            &context(),
            "tools.call",
            json!({}),
            cancel,
            Some(sender),
        )
        .await
    });
    let event = tokio::time::timeout(Duration::from_secs(3), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    let child = event.params["child_pid"].as_u64().unwrap();
    signal.cancel();
    assert!(matches!(
        execution.await.unwrap(),
        Err(PluginError::Cancelled)
    ));
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{child}/stat");
        for _ in 0..20 {
            match std::fs::read_to_string(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Ok(stat)
                    if stat
                        .split(')')
                        .nth(1)
                        .and_then(|s| s.split_whitespace().next())
                        == Some("Z") =>
                {
                    return;
                }
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        panic!("worker descendant remained live after process-group cancellation");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = child;
}
