use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use gpui_telegram_desktop::browser_bridge::{
    DesktopBrowserBridge, DesktopBrowserBridgeStartOptions,
};
use gpui_telegram_proto::browser_contracts::{BrowserRpcErrorCode, BrowserTabDto};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

fn loopback_http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build loopback reqwest client")
}

#[tokio::test]
async fn test_desktop_bridge_persistence_health_and_security_guards() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let expected_token = "pair-test-token-0123456789abcdef";
    let bridge = Arc::new(DesktopBrowserBridge::new(
        0,
        tmp.path().to_path_buf(),
        Some(expected_token.to_string()),
    ));
    let port = bridge
        .start_loopback_server(DesktopBrowserBridgeStartOptions {
            port: 0,
            config_dir: tmp.path().to_path_buf(),
            explicit_pairing_token: Some(expected_token.to_string()),
        })
        .await
        .expect("start loopback server");
    assert!(port > 0);

    // 1. Verify persisted browser_bridge.json permissions (0600) and fields
    let cfg_path = bridge.config_file_path();
    assert!(cfg_path.exists(), "browser_bridge.json must exist");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&cfg_path)
            .expect("stat browser_bridge.json")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "browser_bridge.json must have 0600 mode");
    }
    let persisted: Value =
        serde_json::from_str(&std::fs::read_to_string(&cfg_path).expect("read cfg"))
            .expect("parse cfg");
    assert_eq!(persisted["port"].as_u64(), Some(port as u64));
    assert_eq!(persisted["pairing_token"].as_str(), Some(expected_token));
    assert_eq!(
        persisted["ws_url"].as_str(),
        Some(format!("ws://127.0.0.1:{port}/ext/ws").as_str())
    );

    let http = loopback_http();
    let base = format!("http://127.0.0.1:{port}");

    // 2. Verify /health unpaired baseline
    let health_resp = http
        .get(format!("{base}/health"))
        .send()
        .await
        .expect("GET /health");
    assert_eq!(health_resp.status(), reqwest::StatusCode::OK);
    let health_json: Value = health_resp.json().await.expect("health json");
    assert_eq!(health_json["ok"], json!(true));
    assert_eq!(health_json["host_kind"], json!("desktop"));
    assert_eq!(health_json["port"], json!(port));
    assert_eq!(health_json["extension_connected"], json!(false));
    assert_eq!(health_json["active_tabs"], json!(0));

    // 3. DNS-rebinding Host header rejection on /health and /json/list
    let rebind_resp = http
        .get(format!("{base}/health"))
        .header("Host", "evil-rebind.attacker.com")
        .send()
        .await
        .expect("spoofed Host GET /health");
    assert_eq!(rebind_resp.status(), reqwest::StatusCode::FORBIDDEN);

    // 4. /json/list requires valid pairing_token
    let unauthed_list = http
        .get(format!("{base}/json/list"))
        .send()
        .await
        .expect("unauthed /json/list");
    assert_eq!(unauthed_list.status(), reqwest::StatusCode::UNAUTHORIZED);

    let wrong_tok_list = http
        .get(format!("{base}/json/list?token=wrong-token"))
        .send()
        .await
        .expect("wrong token /json/list");
    assert_eq!(wrong_tok_list.status(), reqwest::StatusCode::UNAUTHORIZED);

    let authed_list = http
        .get(format!("{base}/json/list"))
        .header("Authorization", format!("Bearer {expected_token}"))
        .send()
        .await
        .expect("bearer /json/list");
    assert_eq!(authed_list.status(), reqwest::StatusCode::OK);

    // 5. /ext/ws Origin, Host, and token guards
    for bad_origin in [
        "https://evil.example",
        "http://localhost:8080",
        "null",
    ] {
        let mut req = format!("ws://127.0.0.1:{port}/ext/ws?token={expected_token}")
            .into_client_request()
            .expect("ws req");
        req.headers_mut()
            .insert("Origin", bad_origin.parse().expect("origin header"));
        let err = tokio_tungstenite::connect_async(req)
            .await
            .expect_err("web Origin must be rejected on /ext/ws");
        match err {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                assert_eq!(
                    resp.status(),
                    StatusCode::FORBIDDEN,
                    "Origin {bad_origin} must return 403"
                );
            }
            other => panic!("expected HTTP 403 for {bad_origin}, got {other:?}"),
        }
    }

    // Spoofed Host on /ext/ws -> 403
    {
        let mut req = format!("ws://127.0.0.1:{port}/ext/ws?token={expected_token}")
            .into_client_request()
            .expect("ws req");
        req.headers_mut()
            .insert("Host", "evil.attacker.com".parse().expect("host"));
        req.headers_mut().insert(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
                .parse()
                .expect("origin"),
        );
        let err = tokio_tungstenite::connect_async(req)
            .await
            .expect_err("spoofed Host must fail");
        match err {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            }
            other => panic!("expected HTTP 403 for spoofed Host, got {other:?}"),
        }
    }

    // Wrong ?token= on /ext/ws -> 401
    {
        let mut req = format!("ws://127.0.0.1:{port}/ext/ws?token=invalid-token")
            .into_client_request()
            .expect("ws req");
        req.headers_mut().insert(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
                .parse()
                .expect("origin"),
        );
        let err = tokio_tungstenite::connect_async(req)
            .await
            .expect_err("wrong query token must fail");
        match err {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
            }
            other => panic!("expected HTTP 401 for wrong token, got {other:?}"),
        }
    }

    // Unauthenticated upgrade followed by wrong pairing_token in bridge.hello -> -32001
    {
        let mut req = format!("ws://127.0.0.1:{port}/ext/ws")
            .into_client_request()
            .expect("ws req");
        req.headers_mut().insert(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
                .parse()
                .expect("origin"),
        );
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .expect("upgrade before hello");
        ws.send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": "bad-hello-1",
                "method": "bridge.hello",
                "params": {
                    "protocol_version": 1,
                    "extension_version": "0.1.0",
                    "pairing_token": "wrong-hello-token"
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send bad hello");

        let reply = ws
            .next()
            .await
            .expect("frame")
            .expect("ok frame");
        let parsed: Value = serde_json::from_str(reply.to_text().expect("text")).expect("json");
        assert_eq!(
            parsed["error"]["code"].as_i64(),
            Some(BrowserRpcErrorCode::UnauthorizedBridge.code() as i64)
        );
    }

    bridge.stop();
}

#[tokio::test]
async fn test_desktop_bridge_extension_session_reconnect_exec_and_emergency_stop() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let token = "pair-live-session-abcdef0123456789";
    let bridge = Arc::new(DesktopBrowserBridge::new(
        0,
        tmp.path().to_path_buf(),
        Some(token.to_string()),
    ));
    let port = bridge
        .start_loopback_server(DesktopBrowserBridgeStartOptions {
            port: 0,
            config_dir: tmp.path().to_path_buf(),
            explicit_pairing_token: Some(token.to_string()),
        })
        .await
        .expect("start loopback server");

    // Verify local HermesEngine is wired with DesktopBrowserBridgeProvider
    let hermes = bridge
        .local_hermes_engine()
        .expect("local HermesEngine initialized");
    assert!(hermes.browser_provider().is_some());

    let ext_origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    let connect_ext = |label: &'static str| async move {
        let mut req = format!("ws://127.0.0.1:{port}/ext/ws?token={token}")
            .into_client_request()
            .expect("ws req");
        req.headers_mut()
            .insert("Origin", ext_origin.parse().expect("origin"));
        let (mut ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .unwrap_or_else(|e| panic!("connect {label} failed: {e}"));
        ws.send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": format!("hello-{label}"),
                "method": "bridge.hello",
                "params": {
                    "protocol_version": 1,
                    "extension_version": "0.1.0",
                    "extension_id": "abcdefghijklmnopabcdefghijklmnop",
                    "device_id": format!("dev-{label}"),
                    "pairing_token": token
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send hello");
        let ack_msg = ws.next().await.expect("ack frame").expect("ack ok");
        let ack: Value = serde_json::from_str(ack_msg.to_text().expect("text")).expect("ack json");
        assert_eq!(ack["method"], json!("bridge.hello_ack"));
        assert_eq!(ack["params"]["accepted"], json!(true));
        assert_eq!(ack["params"]["host_kind"], json!("desktop"));
        assert!(ack["params"]["ping_interval_secs"].as_u64().unwrap_or(0) > 0);
        ws
    };

    // Connect session 1, then overlap session 2 BEFORE closing session 1 (T2-F05-06 regression check)
    let mut ws1 = connect_ext("s1").await;
    let mut ws2 = connect_ext("s2").await;
    let _ = ws1.close(None).await;
    drop(ws1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(
        bridge.snapshot().extension_connected,
        "closing superseded ws1 must NOT evict active ws2 session"
    );

    // Ping / Pong
    ws2.send(Message::Text(
        json!({
            "jsonrpc": "2.0",
            "id": "ping-1",
            "method": "bridge.ping",
            "params": { "ts": 12345 }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send ping");
    let pong_frame = ws2.next().await.expect("pong").expect("pong ok");
    let pong: Value = serde_json::from_str(pong_frame.to_text().expect("text")).expect("pong json");
    assert_eq!(pong["id"], json!("ping-1"));
    assert_eq!(pong["method"], json!("bridge.pong"));
    assert_eq!(pong["params"]["ts"], json!(12345));

    // Tabs sync -> reflected in /health and /json/list
    let synced_tabs = vec![
        BrowserTabDto {
            tab_id: 101,
            window_id: 1,
            url: "https://example.com/dashboard".to_string(),
            title: "Example Dashboard".to_string(),
            active: true,
            controllable: true,
            ..Default::default()
        },
        BrowserTabDto {
            tab_id: 102,
            window_id: 1,
            url: "https://docs.example.com".to_string(),
            title: "Docs".to_string(),
            active: false,
            controllable: true,
            ..Default::default()
        },
    ];
    ws2.send(Message::Text(
        json!({
            "jsonrpc": "2.0",
            "method": "bridge.tabs_sync",
            "params": { "tabs": synced_tabs }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send tabs_sync");
    tokio::time::sleep(Duration::from_millis(60)).await;

    let http = loopback_http();
    let base = format!("http://127.0.0.1:{port}");
    let health: Value = http
        .get(format!("{base}/health"))
        .send()
        .await
        .expect("health")
        .json()
        .await
        .expect("health json");
    assert_eq!(health["extension_connected"], json!(true));
    assert_eq!(health["active_tabs"], json!(2));

    let tabs_list: Value = http
        .get(format!("{base}/json/list?token={token}"))
        .send()
        .await
        .expect("json/list")
        .json()
        .await
        .expect("tabs json");
    assert_eq!(tabs_list.as_array().map(|a| a.len()), Some(2));

    // Spawn mock extension responder for browser.invoke on ws2
    let responder = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws2.next().await {
            let Ok(txt) = msg.to_text() else { continue };
            let Ok(frame) = serde_json::from_str::<Value>(txt) else {
                continue;
            };
            if frame["method"] == json!("browser.invoke") {
                let req_id = frame["id"].clone();
                let tool = frame["params"]["tool"].as_str().unwrap_or("");
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "ok": true,
                        "tool": tool,
                        "snapshot": "[ref=e1] button \"Submit\"",
                        "tab_id": 101
                    }
                });
                let _ = ws2.send(Message::Text(resp.to_string().into())).await;
            }
        }
    });

    // POST /exec roundtrip
    let exec_resp: Value = http
        .post(format!("{base}/exec"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "tool": "browser_snapshot",
            "arguments": { "tab_id": 101 }
        }))
        .send()
        .await
        .expect("POST /exec")
        .json()
        .await
        .expect("exec json");
    assert_eq!(exec_resp["ok"], json!(true));
    assert!(
        exec_resp["data"]["snapshot"]
            .as_str()
            .unwrap_or("")
            .contains("[ref=e1]")
    );

    // Emergency stop immediately blocks subsequent commands with -32003 POLICY_DISABLED
    bridge.trigger_emergency_stop(Some("unit-test stop".to_string()));
    let stopped_resp: Value = http
        .post(format!("{base}/exec"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "tool": "browser_snapshot",
            "arguments": { "tab_id": 101 }
        }))
        .send()
        .await
        .expect("POST /exec after stop")
        .json()
        .await
        .expect("stopped json");
    assert_eq!(stopped_resp["ok"], json!(false));
    assert_eq!(
        stopped_resp["rpc_code"].as_i64(),
        Some(BrowserRpcErrorCode::PolicyDisabled.code() as i64)
    );

    bridge.stop();
    responder.abort();
}
