//! `gpui_telegram_ext_wasm` — Shared Rust→WASM Core for the Chrome/Chromium MV3 Browser Extension.
//!
//! Exposes a zero-`wasm-bindgen` C-ABI (`wasm_alloc`, `wasm_dealloc`, `wasm_invoke_json`,
//! `wasm_exec_json`, `wasm_reset_state`) over linear memory using UTF-8 JSON envelopes
//! (`PROJECT.md § Interface Contracts § 5`):
//!
//! - Request:  `{ "op": "<op_name>", "payload": { ... } }` (also accepts flat `{ "op": "<op_name>", ... }`)
//! - Response: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "...", "error_code": "..." }`

pub mod e2ee;
pub mod pts_sync;
pub mod waveform;
pub mod web_security;

use crate::e2ee::{
    b64_decode_32, b64_decode_vec, b64_encode, compute_safety_number_emojis,
    generate_device_bundle_from_seeds, sign_signed_prekey, x25519_pub_from_secret, x3dh_initiator,
    x3dh_responder, OneTimeSeedInput, WasmDoubleRatchetSession, WasmSenderKeyState,
};
use crate::pts_sync::{parse_pts_update_flexible, PtsEvalOutcomeDto, WasmPtsCoordinator};
use crate::waveform::{
    bars_from_float_peaks, decode_waveform_5bit, decode_waveform_to_floats, encode_waveform_5bit,
    normalize_pcm_peaks, resample_and_normalize_waveform, MAX_WAVEFORM_ENCODED_BYTES,
    MAX_WAVEFORM_FLOAT_COUNT, MAX_WAVEFORM_INPUT_SAMPLES,
};
use crate::web_security::{html_to_markdown, scan_content_for_injection};
use ed25519_dalek::SigningKey;
use gpui_telegram_core::types::ChatId;
use gpui_telegram_proto::browser_contracts::{
    canonical_browser_tool_descriptors, BrowserBridgeFrame,
};
use gpui_telegram_proto::e2ee::{
    DevicePreKeyBundle, GroupCiphertext, RatchetHeaderDto, SenderKeyDistributionMessage,
};
use gpui_telegram_proto::ws::{WsClientFrame, WsServerFrame};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr;

/// Hard upper bound (`32 MiB`) for any single C-ABI allocation or JSON request buffer.
pub const MAX_WASM_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// Canonical list of supported `wasm_invoke_json` / `wasm_exec_json` operations
/// covering all `PROJECT.md § 5` and `SCOPE.md § F1.3` names and aliases.
pub const SUPPORTED_OPS: [&str; 31] = [
    "version",
    "validate_ws_frame",
    "ws_validate_client_frame",
    "ws_parse_server_frame",
    "pts_get_set",
    "pts_eval",
    "pts_buffer_gap",
    "pts_drain_contiguous",
    "pts_drain_buffer",
    "e2ee_generate_identity",
    "e2ee_generate_bundle",
    "e2ee_x3dh_initiator",
    "e2ee_x3dh_responder",
    "e2ee_x3dh_init",
    "e2ee_ratchet_init",
    "e2ee_ratchet_encrypt",
    "e2ee_ratchet_decrypt",
    "e2ee_sender_key_create",
    "e2ee_sender_key_generate",
    "e2ee_sender_key_init",
    "e2ee_sender_key_from_distribution",
    "e2ee_sender_key_import",
    "e2ee_sender_key_encrypt",
    "e2ee_sender_key_decrypt",
    "safety_number_emojis",
    "e2ee_safety_emojis",
    "waveform_encode_5bit",
    "waveform_decode_5bit",
    "html_to_markdown",
    "scan_content_for_injection",
    "scan_injection",
];

#[derive(Default)]
struct WasmCoreState {
    pts: WasmPtsCoordinator,
    e2ee_sessions: HashMap<String, WasmDoubleRatchetSession>,
    sender_key_sessions: HashMap<String, WasmSenderKeyState>,
    #[cfg(not(target_pointer_width = "32"))]
    native_invoke_ptrs: HashMap<u32, usize>,
    #[cfg(not(target_pointer_width = "32"))]
    next_native_handle: u32,
}

impl WasmCoreState {
    fn reset(&mut self) {
        self.pts.clear();
        self.e2ee_sessions.clear();
        self.sender_key_sessions.clear();
        #[cfg(not(target_pointer_width = "32"))]
        {
            self.native_invoke_ptrs.clear();
            self.next_native_handle = 0;
        }
    }
}

thread_local! {
    static STATE: RefCell<WasmCoreState> = RefCell::new(WasmCoreState::default());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmResponseEnvelope {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<WasmErrorBody>,
}

impl WasmResponseEnvelope {
    fn success(data: Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
            error_code: None,
            error_detail: None,
        }
    }

    fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code_str = code.into();
        let msg_str = message.into();
        Self {
            ok: false,
            data: None,
            error: Some(format!("{code_str}: {msg_str}")),
            error_code: Some(code_str.clone()),
            error_detail: Some(WasmErrorBody {
                code: code_str,
                message: msg_str,
            }),
        }
    }

    fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"ok":false,"error":"SERIALIZE_ERROR: failed to encode response","error_code":"SERIALIZE_ERROR"}"#
                .to_string()
        })
    }
}

/// Allocates an exact-sized `Box<[u8]>` buffer (`len` bytes) in WASM linear memory.
/// Returns null if `len == 0` or `len > MAX_WASM_BUFFER_BYTES`.
#[unsafe(no_mangle)]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    if len == 0 || len > MAX_WASM_BUFFER_BYTES {
        return ptr::null_mut();
    }
    let mut boxed: Box<[u8]> = vec![0u8; len].into_boxed_slice();
    let raw_ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    raw_ptr
}

/// Frees an exact-sized `Box<[u8]>` buffer previously returned by [`wasm_alloc`],
/// [`wasm_invoke_json`], or [`wasm_exec_json`].
///
/// # Safety
/// If `ptr` is non-null and `0 < len <= MAX_WASM_BUFFER_BYTES`, `(ptr, len)` must have been
/// allocated via `Box<[u8]>` of exact length `len` in this module and not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 || len > MAX_WASM_BUFFER_BYTES {
        return;
    }
    let slice_ptr = ptr::slice_from_raw_parts_mut(ptr, len);
    // SAFETY: Caller upholds exact `(ptr, len)` ownership from `wasm_alloc` / `wasm_invoke_json`.
    unsafe {
        drop(Box::from_raw(slice_ptr));
    }
}

/// Resets all in-memory PTS & E2EE state in the WASM instance.
#[unsafe(no_mangle)]
pub extern "C" fn wasm_reset_state() {
    reset_state();
}

fn eval_raw_input_to_boxed_json(req_ptr: *const u8, req_len: usize) -> (*mut u8, usize) {
    let response_json = if req_len > MAX_WASM_BUFFER_BYTES {
        WasmResponseEnvelope::failure(
            "PAYLOAD_TOO_LARGE",
            format!("request length {req_len} exceeds max {MAX_WASM_BUFFER_BYTES}"),
        )
        .to_json_string()
    } else if req_len == 0 {
        WasmResponseEnvelope::failure("EMPTY_REQUEST", "request JSON buffer is empty")
            .to_json_string()
    } else if req_ptr.is_null() {
        WasmResponseEnvelope::failure("NULL_POINTER", "req_ptr is null with non-zero req_len")
            .to_json_string()
    } else {
        // SAFETY: `req_ptr` is non-null and `req_len <= MAX_WASM_BUFFER_BYTES`.
        let bytes = unsafe { std::slice::from_raw_parts(req_ptr, req_len) };
        match std::str::from_utf8(bytes) {
            Ok(raw_str) => exec_json_str(raw_str),
            Err(e) => {
                WasmResponseEnvelope::failure("INVALID_UTF8", format!("invalid UTF-8 input: {e}"))
                    .to_json_string()
            }
        }
    };

    let mut out_boxed: Box<[u8]> = response_json.into_bytes().into_boxed_slice();
    let out_len = out_boxed.len();
    let out_ptr = out_boxed.as_mut_ptr();
    std::mem::forget(out_boxed);
    (out_ptr, out_len)
}

/// Canonical `PROJECT.md § 5` C-ABI entrypoint:
/// `wasm_invoke_json(ptr: *const u8, len: usize) -> u64`
///
/// Packs the owned UTF-8 JSON response buffer into a single `u64`:
/// - **Upper 32 bits**: output pointer (`(out_ptr as u32 as u64) << 32` on `wasm32`)
/// - **Lower 32 bits**: output byte length (`out_len as u32 as u64`)
///
/// The caller reads `out_len` bytes from `out_ptr` in WASM linear memory and frees the buffer
/// via `wasm_dealloc(out_ptr, out_len)`.
///
/// # Safety
/// When `len > 0`, `ptr` must be non-null and point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_invoke_json(ptr: *const u8, len: usize) -> u64 {
    let (out_ptr, out_len) = eval_raw_input_to_boxed_json(ptr, len);
    #[cfg(target_pointer_width = "32")]
    {
        ((out_ptr as usize as u64) << 32) | (out_len as u32 as u64)
    }
    #[cfg(not(target_pointer_width = "32"))]
    {
        let handle = STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            st.next_native_handle = st.next_native_handle.wrapping_add(1).max(1);
            let h = st.next_native_handle;
            st.native_invoke_ptrs.insert(h, out_ptr as usize);
            h
        });
        ((handle as u64) << 32) | (out_len as u32 as u64)
    }
}

/// Unpacks the `(out_ptr, out_len)` pair returned by [`wasm_invoke_json`].
/// On `wasm32`, directly extracts `((packed >> 32) as *mut u8, (packed & 0xFFFF_FFFF) as usize)`.
/// On 64-bit native test hosts, resolves the 32-bit handle back to the full 64-bit heap pointer.
pub fn unpack_invoke_json_return(packed: u64) -> (*mut u8, usize) {
    let upper = (packed >> 32) as u32;
    let out_len = (packed & 0xFFFF_FFFF) as usize;
    #[cfg(target_pointer_width = "32")]
    {
        (upper as usize as *mut u8, out_len)
    }
    #[cfg(not(target_pointer_width = "32"))]
    {
        let raw_addr = STATE
            .with(|cell| cell.borrow_mut().native_invoke_ptrs.remove(&upper))
            .unwrap_or(0);
        (raw_addr as *mut u8, out_len)
    }
}

/// Companion C-ABI entrypoint writing output byte length to `*out_len_ptr` and returning `*mut u8`.
///
/// # Safety
/// - `out_len_ptr` must be null or point to a valid writable `usize`.
/// - When `req_len > 0`, `req_ptr` must be non-null and point to `req_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_exec_json(
    req_ptr: *const u8,
    req_len: usize,
    out_len_ptr: *mut usize,
) -> *mut u8 {
    if out_len_ptr.is_null() {
        return ptr::null_mut();
    }
    let (out_ptr, out_len) = eval_raw_input_to_boxed_json(req_ptr, req_len);
    // SAFETY: `out_len_ptr` was checked non-null above.
    unsafe {
        ptr::write_unaligned(out_len_ptr, out_len);
    }
    out_ptr
}

/// Safe Rust entrypoint resetting in-memory PTS & E2EE state.
pub fn reset_state() {
    STATE.with(|cell| cell.borrow_mut().reset());
}

/// Normalizes `{ "op": "...", "payload": { ... } }` and flat `{ "op": "...", ... }` into
/// a unified parameter object so both calling conventions work identically.
fn normalize_params(top: &Map<String, Value>) -> Value {
    if let Some(Value::Object(payload_map)) = top.get("payload") {
        let mut merged = top.clone();
        for (k, v) in payload_map {
            merged.insert(k.clone(), v.clone());
        }
        Value::Object(merged)
    } else {
        Value::Object(top.clone())
    }
}

/// Safe Rust entrypoint executing a raw JSON request string and returning a JSON response string.
pub fn exec_json_str(raw: &str) -> String {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return WasmResponseEnvelope::failure("INVALID_JSON", format!("JSON parse error: {e}"))
                .to_json_string();
        }
    };

    let Some(obj) = parsed.as_object() else {
        return WasmResponseEnvelope::failure(
            "INVALID_REQUEST",
            "top-level request must be a JSON object with an 'op' string field",
        )
        .to_json_string();
    };

    let Some(op) = obj.get("op").and_then(|v| v.as_str()) else {
        return WasmResponseEnvelope::failure("MISSING_OP", "missing string field 'op'")
            .to_json_string();
    };

    let params = normalize_params(obj);
    let resp = match dispatch_op(op.trim(), &params) {
        Ok(data) => WasmResponseEnvelope::success(data),
        Err((code, msg)) => WasmResponseEnvelope::failure(code, msg),
    };
    resp.to_json_string()
}

fn dispatch_op(op: &str, req: &Value) -> Result<Value, (&'static str, String)> {
    match op {
        "version" => Ok(json!({
            "crate": env!("CARGO_PKG_NAME"),
            "version": env!("CARGO_PKG_VERSION"),
            "ops": SUPPORTED_OPS,
            "canonical_browser_tools": 26,
        })),

        "validate_ws_frame" => op_validate_ws_frame(req),
        "ws_validate_client_frame" => op_ws_validate_client_frame(req),
        "ws_parse_server_frame" => op_ws_parse_server_frame(req),

        "pts_get_set" => op_pts_get_set(req),
        "pts_eval" => op_pts_eval(req),
        "pts_buffer_gap" => op_pts_buffer_gap(req),
        "pts_drain_contiguous" | "pts_drain_buffer" => op_pts_drain_buffer(req),

        "e2ee_generate_identity" | "e2ee_generate_bundle" => op_e2ee_generate_bundle(req),
        "safety_number_emojis" | "e2ee_safety_emojis" => op_e2ee_safety_emojis(req),
        "e2ee_x3dh_initiator" => op_e2ee_x3dh_role("initiator", req),
        "e2ee_x3dh_responder" => op_e2ee_x3dh_role("responder", req),
        "e2ee_x3dh_init" => {
            let role = req
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("initiator");
            op_e2ee_x3dh_role(role, req)
        }
        "e2ee_ratchet_init" => op_e2ee_ratchet_init(req),
        "e2ee_ratchet_encrypt" => op_e2ee_ratchet_encrypt(req),
        "e2ee_ratchet_decrypt" => op_e2ee_ratchet_decrypt(req),
        "e2ee_sender_key_create" | "e2ee_sender_key_generate" | "e2ee_sender_key_init" => {
            op_e2ee_sender_key_create(req)
        }
        "e2ee_sender_key_from_distribution" | "e2ee_sender_key_import" => {
            op_e2ee_sender_key_from_distribution(req)
        }
        "e2ee_sender_key_encrypt" => op_e2ee_sender_key_encrypt(req),
        "e2ee_sender_key_decrypt" => op_e2ee_sender_key_decrypt(req),

        "waveform_encode_5bit" => op_waveform_encode_5bit(req),
        "waveform_decode_5bit" => op_waveform_decode_5bit(req),

        "html_to_markdown" => op_html_to_markdown(req),
        "scan_content_for_injection" | "scan_injection" => op_scan_injection(req),

        "browser_validate_frame" => op_browser_validate_frame(req),
        "browser_tool_descriptors" => {
            let descriptors = canonical_browser_tool_descriptors();
            serde_json::to_value(&descriptors)
                .map(|v| json!({ "count": descriptors.len(), "tools": v }))
                .map_err(|e| ("SERIALIZE_ERROR", e.to_string()))
        }

        unknown => Err(("UNKNOWN_OP", format!("unsupported wasm op '{unknown}'"))),
    }
}

fn op_validate_ws_frame(req: &Value) -> Result<Value, (&'static str, String)> {
    let direction = req
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("auto");
    match direction {
        "client" => op_ws_validate_client_frame(req),
        "server" => op_ws_parse_server_frame(req),
        _ => op_ws_validate_client_frame(req).or_else(|_| op_ws_parse_server_frame(req)),
    }
}

fn op_ws_validate_client_frame(req: &Value) -> Result<Value, (&'static str, String)> {
    let raw_target = req
        .get("frame")
        .or_else(|| req.get("raw"))
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'frame' or 'raw' field".into()))?;

    let frame: WsClientFrame = match raw_target {
        Value::String(s) => serde_json::from_str(s).map_err(|e| {
            (
                "INVALID_WS_CLIENT_FRAME",
                format!("invalid WsClientFrame JSON: {e}"),
            )
        })?,
        other => serde_json::from_value(other.clone()).map_err(|e| {
            (
                "INVALID_WS_CLIENT_FRAME",
                format!("invalid WsClientFrame object: {e}"),
            )
        })?,
    };

    let canonical_val =
        serde_json::to_value(&frame).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
    let canonical_json =
        serde_json::to_string(&frame).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
    let frame_type = canonical_val
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    Ok(json!({
        "direction": "client",
        "frame_type": frame_type,
        "frame": canonical_val,
        "json": canonical_json,
    }))
}

fn op_ws_parse_server_frame(req: &Value) -> Result<Value, (&'static str, String)> {
    let raw_target = req
        .get("raw")
        .or_else(|| req.get("frame"))
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'raw' or 'frame' field".into()))?;

    let frame: WsServerFrame = match raw_target {
        Value::String(s) => serde_json::from_str(s).map_err(|e| {
            (
                "INVALID_WS_SERVER_FRAME",
                format!("invalid WsServerFrame JSON: {e}"),
            )
        })?,
        other => serde_json::from_value(other.clone()).map_err(|e| {
            (
                "INVALID_WS_SERVER_FRAME",
                format!("invalid WsServerFrame object: {e}"),
            )
        })?,
    };

    let canonical_val =
        serde_json::to_value(&frame).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
    let frame_type = canonical_val
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    Ok(json!({
        "direction": "server",
        "frame_type": frame_type,
        "frame": canonical_val,
    }))
}

fn op_pts_get_set(req: &Value) -> Result<Value, (&'static str, String)> {
    let chat_id_raw = req
        .get("chat_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ("INVALID_PARAMS", "missing integer 'chat_id'".into()))?;
    let set_pts = req
        .get("set_pts")
        .or_else(|| req.get("pts"))
        .and_then(|v| v.as_u64());

    let chat_id = ChatId(chat_id_raw);
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        if let Some(new_pts) = set_pts {
            st.pts.set_pts(chat_id, new_pts);
        }
        Ok(json!({
            "chat_id": chat_id_raw,
            "pts": st.pts.last_pts(chat_id),
            "buffered_count": st.pts.buffered_count(chat_id),
        }))
    })
}

fn op_pts_eval(req: &Value) -> Result<Value, (&'static str, String)> {
    let upd_val = req.get("update").unwrap_or(req);
    let update = parse_pts_update_flexible(upd_val).map_err(|e| ("INVALID_PARAMS", e))?;
    let auto_buffer = req
        .get("auto_buffer_gap")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let outcome = st.pts.evaluate_update(&update);
        let mut buffered_count = st.pts.buffered_count(update.chat_id);
        if auto_buffer && matches!(outcome, PtsEvalOutcomeDto::GapDetected { .. }) {
            buffered_count = st.pts.buffer_gap_update(update);
        }
        let mut val =
            serde_json::to_value(&outcome).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
        if let Some(map) = val.as_object_mut() {
            map.insert("buffered_count".into(), json!(buffered_count));
        }
        Ok(val)
    })
}

fn op_pts_buffer_gap(req: &Value) -> Result<Value, (&'static str, String)> {
    let upd_val = req.get("update").unwrap_or(req);
    let update = parse_pts_update_flexible(upd_val).map_err(|e| ("INVALID_PARAMS", e))?;
    let chat_id_raw = update.chat_id.0;
    let buffered_pts = update.pts;

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let count = st.pts.buffer_gap_update(update);
        Ok(json!({
            "chat_id": chat_id_raw,
            "buffered_pts": buffered_pts,
            "buffered_count": count,
        }))
    })
}

fn op_pts_drain_buffer(req: &Value) -> Result<Value, (&'static str, String)> {
    let chat_id_raw = req
        .get("chat_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ("INVALID_PARAMS", "missing integer 'chat_id'".into()))?;
    let set_pts = req.get("set_pts").and_then(|v| v.as_u64());
    let chat_id = ChatId(chat_id_raw);

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        if let Some(reconciled_pts) = set_pts {
            st.pts.set_pts(chat_id, reconciled_pts);
        }
        let drained = st.pts.drain_contiguous_buffer(chat_id);
        let current_pts = st.pts.last_pts(chat_id);
        let remaining = st.pts.buffered_count(chat_id);
        Ok(json!({
            "chat_id": chat_id_raw,
            "current_pts": current_pts,
            "drained_count": drained.len(),
            "drained": drained,
            "remaining_buffered": remaining,
        }))
    })
}

fn op_e2ee_generate_bundle(req: &Value) -> Result<Value, (&'static str, String)> {
    let user_id = req.get("user_id").and_then(|v| v.as_u64()).unwrap_or(0);
    let device_id = req
        .get("device_id")
        .and_then(|v| v.as_str())
        .unwrap_or("browser-ext")
        .to_string();
    let device_name = req
        .get("device_name")
        .and_then(|v| v.as_str())
        .map(String::from);

    let ik_x_b64 = req
        .get("identity_x25519_seed_b64")
        .or_else(|| req.get("x25519_seed_b64"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'identity_x25519_seed_b64'".into()))?;
    let ik_ed_b64 = req
        .get("identity_ed25519_seed_b64")
        .or_else(|| req.get("ed25519_seed_b64"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'identity_ed25519_seed_b64'".into()))?;

    let ik_x = b64_decode_32(ik_x_b64).map_err(|e| ("INVALID_KEY", e))?;
    let ik_ed = b64_decode_32(ik_ed_b64).map_err(|e| ("INVALID_KEY", e))?;

    // If signed_prekey_seed_b64 is omitted (e.g. lightweight `e2ee_generate_identity` call),
    // return the X25519 + Ed25519 identity pair directly; otherwise generate full prekey bundle.
    let Some(spk_seed_b64) = req.get("signed_prekey_seed_b64").and_then(|v| v.as_str()) else {
        let ik_x_pub = x25519_pub_from_secret(&ik_x);
        let ik_ed_pub = SigningKey::from_bytes(&ik_ed).verifying_key().to_bytes();
        let spk_sig_self = sign_signed_prekey(&ik_ed, &ik_x_pub);
        return Ok(json!({
            "device_id": device_id,
            "identity_x25519_sec_b64": b64_encode(&ik_x),
            "identity_x25519_pub_b64": b64_encode(&ik_x_pub),
            "identity_ed25519_sec_b64": b64_encode(&ik_ed),
            "identity_ed25519_pub_b64": b64_encode(&ik_ed_pub),
            "identity_self_signature_b64": b64_encode(&spk_sig_self),
        }));
    };

    let spk_seed = b64_decode_32(spk_seed_b64).map_err(|e| ("INVALID_KEY", e))?;
    let spk_id_u64 = req
        .get("signed_prekey_id")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    let spk_id = u32::try_from(spk_id_u64)
        .map_err(|_| ("INVALID_PARAMS", "signed_prekey_id overflows u32".into()))?;
    let created_at_ms = req
        .get("created_at_ms")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let otpk_seeds: Vec<OneTimeSeedInput> = match req.get("one_time_prekeys") {
        Some(v) if !v.is_null() => serde_json::from_value(v.clone())
            .map_err(|e| ("INVALID_PARAMS", format!("invalid 'one_time_prekeys': {e}")))?,
        _ => Vec::new(),
    };

    let out = generate_device_bundle_from_seeds(
        user_id,
        device_id,
        device_name,
        ik_x,
        ik_ed,
        spk_id,
        spk_seed,
        created_at_ms,
        &otpk_seeds,
    )
    .map_err(|e| ("E2EE_KEYGEN_FAILED", e))?;

    serde_json::to_value(out).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))
}

fn op_e2ee_safety_emojis(req: &Value) -> Result<Value, (&'static str, String)> {
    let local_b64 = req
        .get("local_identity_key_b64")
        .or_else(|| req.get("local_ik_b64"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'local_identity_key_b64'".into()))?;
    let remote_b64 = req
        .get("remote_identity_key_b64")
        .or_else(|| req.get("remote_ik_b64"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'remote_identity_key_b64'".into()))?;

    let local_ik = b64_decode_32(local_b64).map_err(|e| ("INVALID_KEY", e))?;
    let remote_ik = b64_decode_32(remote_b64).map_err(|e| ("INVALID_KEY", e))?;
    let emojis = compute_safety_number_emojis(&local_ik, &remote_ik);

    Ok(json!({ "emojis": emojis }))
}

fn op_e2ee_x3dh_role(role: &str, req: &Value) -> Result<Value, (&'static str, String)> {
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    match role {
        "initiator" | "alice" => {
            let ik_a_sec = b64_decode_32(
                req.get("ik_a_sec_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'ik_a_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let ek_a_sec = b64_decode_32(
                req.get("ek_a_sec_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'ek_a_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let bundle_val = req
                .get("remote_bundle")
                .or_else(|| req.get("bundle"))
                .ok_or_else(|| ("INVALID_PARAMS", "missing 'remote_bundle'".into()))?;
            let bundle: DevicePreKeyBundle = serde_json::from_value(bundle_val.clone())
                .map_err(|e| ("INVALID_PARAMS", format!("invalid 'remote_bundle': {e}")))?;

            let x3dh =
                x3dh_initiator(&ik_a_sec, &ek_a_sec, &bundle).map_err(|e| ("X3DH_FAILED", e))?;
            let ek_a_pub = x25519_pub_from_secret(&ek_a_sec);
            let ik_a_pub = x25519_pub_from_secret(&ik_a_sec);
            let safety_emojis = compute_safety_number_emojis(&ik_a_pub, &x3dh.remote_ik_pub);
            let otpk_id = bundle.one_time_prekey.as_ref().map(|o| o.key_id);

            // If `ratchet_dh_sec_b64` is supplied, also initialize Alice's DoubleRatchetSession immediately;
            // otherwise return `shared_secret_b64` + `associated_data_b64` for a follow-up `e2ee_ratchet_init`.
            let mut session_json: Option<String> = None;
            if let Some(ratchet_b64) = req.get("ratchet_dh_sec_b64").and_then(|v| v.as_str()) {
                let ratchet_dh_sec =
                    b64_decode_32(ratchet_b64).map_err(|e| ("INVALID_KEY", e))?;
                let mut session = WasmDoubleRatchetSession::init_alice(
                    *x3dh.shared_secret,
                    x3dh.remote_spk_pub,
                    ratchet_dh_sec,
                    x3dh.associated_data.clone(),
                )
                .map_err(|e| ("RATCHET_INIT_FAILED", e))?;
                session.set_pending_x3dh_prekey_info(
                    ek_a_pub,
                    bundle.signed_prekey.key_id,
                    otpk_id,
                );
                let encoded = session.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;
                if let Some(ref sid) = session_id {
                    STATE.with(|cell| {
                        cell.borrow_mut().e2ee_sessions.insert(sid.clone(), session);
                    });
                }
                session_json = Some(encoded);
            }

            Ok(json!({
                "role": "initiator",
                "session_id": session_id,
                "session_json": session_json,
                "shared_secret_b64": b64_encode(&*x3dh.shared_secret),
                "associated_data_b64": b64_encode(&x3dh.associated_data),
                "remote_spk_pub_b64": b64_encode(&x3dh.remote_spk_pub),
                "identity_pub_b64": b64_encode(&ik_a_pub),
                "ephemeral_pub_b64": b64_encode(&ek_a_pub),
                "used_signed_prekey_id": bundle.signed_prekey.key_id,
                "used_one_time_prekey_id": otpk_id,
                "safety_emojis": safety_emojis,
            }))
        }

        "responder" | "bob" => {
            let ik_b_sec = b64_decode_32(
                req.get("ik_b_sec_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'ik_b_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let spk_b_sec = b64_decode_32(
                req.get("spk_b_sec_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'spk_b_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let opk_b_sec = match req.get("opk_b_sec_b64").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => {
                    Some(b64_decode_32(s).map_err(|e| ("INVALID_KEY", e))?)
                }
                _ => None,
            };
            let ik_a_pub = b64_decode_32(
                req.get("ik_a_pub_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'ik_a_pub_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let ek_a_pub = b64_decode_32(
                req.get("ek_a_pub_b64")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'ek_a_pub_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;

            let (shared_secret, ad) = x3dh_responder(
                &ik_b_sec,
                &spk_b_sec,
                opk_b_sec.as_ref(),
                &ik_a_pub,
                &ek_a_pub,
            )
            .map_err(|e| ("X3DH_FAILED", e))?;

            let ik_b_pub = x25519_pub_from_secret(&ik_b_sec);
            let safety_emojis = compute_safety_number_emojis(&ik_b_pub, &ik_a_pub);
            let session = WasmDoubleRatchetSession::init_bob(*shared_secret, spk_b_sec, ad.clone());
            let session_json = session.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;

            if let Some(ref sid) = session_id {
                STATE.with(|cell| {
                    cell.borrow_mut().e2ee_sessions.insert(sid.clone(), session);
                });
            }

            Ok(json!({
                "role": "responder",
                "session_id": session_id,
                "session_json": session_json,
                "shared_secret_b64": b64_encode(&*shared_secret),
                "associated_data_b64": b64_encode(&ad),
                "safety_emojis": safety_emojis,
            }))
        }

        other => Err((
            "INVALID_PARAMS",
            format!("unsupported X3DH role '{other}'"),
        )),
    }
}

fn op_e2ee_ratchet_init(req: &Value) -> Result<Value, (&'static str, String)> {
    let role = req
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("alice");
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let shared_secret = b64_decode_32(
        req.get("shared_secret_b64")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ("INVALID_PARAMS", "missing 'shared_secret_b64'".into()))?,
    )
    .map_err(|e| ("INVALID_KEY", e))?;
    let ad = match req.get("associated_data_b64").or_else(|| req.get("ad_b64")).and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => b64_decode_vec(s).map_err(|e| ("INVALID_PARAMS", e))?,
        _ => Vec::new(),
    };

    let session = match role {
        "alice" | "initiator" => {
            let remote_dh_pub = b64_decode_32(
                req.get("remote_dh_pub_b64")
                    .or_else(|| req.get("bob_dh_pub_b64"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'remote_dh_pub_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            let dh_self_sec = b64_decode_32(
                req.get("self_dh_sec_b64")
                    .or_else(|| req.get("ratchet_dh_sec_b64"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'self_dh_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            WasmDoubleRatchetSession::init_alice(shared_secret, remote_dh_pub, dh_self_sec, ad)
                .map_err(|e| ("RATCHET_INIT_FAILED", e))?
        }
        "bob" | "responder" => {
            let bob_dh_sec = b64_decode_32(
                req.get("self_dh_sec_b64")
                    .or_else(|| req.get("bob_dh_sec_b64"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ("INVALID_PARAMS", "missing 'self_dh_sec_b64'".into()))?,
            )
            .map_err(|e| ("INVALID_KEY", e))?;
            WasmDoubleRatchetSession::init_bob(shared_secret, bob_dh_sec, ad)
        }
        other => {
            return Err((
                "INVALID_PARAMS",
                format!("unsupported e2ee_ratchet_init role '{other}'"),
            ));
        }
    };

    let session_json = session.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;
    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut().e2ee_sessions.insert(sid.clone(), session);
        });
    }

    Ok(json!({
        "role": role,
        "session_id": session_id,
        "session_json": session_json,
    }))
}

fn load_ratchet_session(
    req: &Value,
) -> Result<(Option<String>, WasmDoubleRatchetSession), (&'static str, String)> {
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(raw_json) = req.get("session_json").and_then(|v| v.as_str()) {
        let sess =
            WasmDoubleRatchetSession::from_json(raw_json).map_err(|e| ("INVALID_SESSION", e))?;
        return Ok((session_id, sess));
    }

    if let Some(ref sid) = session_id {
        let found = STATE.with(|cell| cell.borrow().e2ee_sessions.get(sid).cloned());
        if let Some(sess) = found {
            return Ok((session_id, sess));
        }
        return Err((
            "SESSION_NOT_FOUND",
            format!("no E2EE session stored for session_id '{sid}'"),
        ));
    }

    Err((
        "INVALID_PARAMS",
        "provide either 'session_id' or 'session_json'".into(),
    ))
}

fn op_e2ee_ratchet_encrypt(req: &Value) -> Result<Value, (&'static str, String)> {
    let (session_id, mut session) = load_ratchet_session(req)?;
    let plaintext: Vec<u8> = if let Some(b64) = req.get("plaintext_b64").and_then(|v| v.as_str()) {
        b64_decode_vec(b64).map_err(|e| ("INVALID_PARAMS", e))?
    } else if let Some(utf8) = req
        .get("plaintext_utf8")
        .or_else(|| req.get("plaintext"))
        .and_then(|v| v.as_str())
    {
        utf8.as_bytes().to_vec()
    } else {
        return Err((
            "INVALID_PARAMS",
            "provide either 'plaintext_b64' or 'plaintext_utf8'".into(),
        ));
    };

    let (header, ciphertext_b64) = session
        .encrypt(&plaintext)
        .map_err(|e| ("ENCRYPT_FAILED", e))?;
    let ek_b64 = session.pending_x3dh_ek_pub.map(|k| b64_encode(&k));
    let spk_id = session.pending_x3dh_spk_id;
    let otpk_id = session.pending_x3dh_otpk_id;
    let session_json = session.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;

    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut().e2ee_sessions.insert(sid.clone(), session);
        });
    }

    Ok(json!({
        "session_id": session_id,
        "header": header,
        "ciphertext_b64": ciphertext_b64,
        "ephemeral_key_b64": ek_b64,
        "used_signed_prekey_id": spk_id,
        "used_one_time_prekey_id": otpk_id,
        "session_json": session_json,
    }))
}

fn op_e2ee_ratchet_decrypt(req: &Value) -> Result<Value, (&'static str, String)> {
    let (session_id, mut session) = load_ratchet_session(req)?;
    let header_val = req
        .get("header")
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'header'".into()))?;
    let header: RatchetHeaderDto = serde_json::from_value(header_val.clone())
        .map_err(|e| ("INVALID_PARAMS", format!("invalid 'header': {e}")))?;
    let ciphertext_b64 = req
        .get("ciphertext_b64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'ciphertext_b64'".into()))?;
    let next_dh_sec = b64_decode_32(
        req.get("next_dh_sec_b64")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ("INVALID_PARAMS", "missing 'next_dh_sec_b64'".into()))?,
    )
    .map_err(|e| ("INVALID_KEY", e))?;

    let plaintext = session
        .decrypt(&header, ciphertext_b64, next_dh_sec)
        .map_err(|e| {
            if e.starts_with("REPLAY_DETECTED") {
                ("REPLAY_DETECTED", e)
            } else {
                ("DECRYPT_FAILED", e)
            }
        })?;

    let session_json = session.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;
    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut().e2ee_sessions.insert(sid.clone(), session);
        });
    }

    let plaintext_utf8 = String::from_utf8(plaintext.clone()).ok();
    Ok(json!({
        "session_id": session_id,
        "plaintext_b64": b64_encode(&plaintext),
        "plaintext_utf8": plaintext_utf8,
        "session_json": session_json,
    }))
}

fn op_e2ee_sender_key_create(req: &Value) -> Result<Value, (&'static str, String)> {
    let chat_id = req
        .get("chat_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ("INVALID_PARAMS", "missing integer 'chat_id'".into()))?;
    let sender_user_id = req
        .get("sender_user_id")
        .or_else(|| req.get("user_id"))
        .and_then(|v| v.as_u64())
        .ok_or_else(|| ("INVALID_PARAMS", "missing integer 'sender_user_id'".into()))?;
    let sender_device_id = req
        .get("sender_device_id")
        .or_else(|| req.get("device_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("browser-ext")
        .to_string();
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    let chain_id = match req.get("chain_id").or_else(|| req.get("key_id")) {
        Some(v) if !v.is_null() => {
            let n = v.as_u64().ok_or_else(|| {
                (
                    "INVALID_PARAMS",
                    "'chain_id' / 'key_id' must be a non-negative integer".into(),
                )
            })?;
            let id = u32::try_from(n)
                .map_err(|_| ("INVALID_PARAMS", "'chain_id' overflows u32".into()))?;
            Some(id.max(1))
        }
        _ => None,
    };

    let iteration = match req.get("iteration") {
        Some(v) if !v.is_null() => {
            let n = v.as_u64().ok_or_else(|| {
                (
                    "INVALID_PARAMS",
                    "'iteration' must be a non-negative integer".into(),
                )
            })?;
            u32::try_from(n).map_err(|_| ("INVALID_PARAMS", "'iteration' overflows u32".into()))?
        }
        _ => 0,
    };

    let ck_opt = req
        .get("chain_key_b64")
        .or_else(|| req.get("chain_key_seed_b64"))
        .and_then(|v| v.as_str());
    let sk_opt = req
        .get("signing_key_seed_b64")
        .or_else(|| req.get("signing_seed_b64"))
        .or_else(|| req.get("identity_ed25519_seed_b64"))
        .or_else(|| req.get("ed25519_seed_b64"))
        .and_then(|v| v.as_str());

    let (chain_key, signing_sec) = match (ck_opt, sk_opt) {
        (Some(ck_s), Some(sk_s)) => {
            let ck = b64_decode_32(ck_s).map_err(|e| ("INVALID_KEY", e))?;
            let sk = b64_decode_32(sk_s).map_err(|e| ("INVALID_KEY", e))?;
            (ck, sk)
        }
        _ => {
            let master_b64 = req
                .get("seed_b64")
                .or_else(|| req.get("master_seed_b64"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    (
                        "INVALID_PARAMS",
                        "provide ('chain_key_b64' + 'signing_key_seed_b64') or 'seed_b64'".into(),
                    )
                })?;
            let master = b64_decode_32(master_b64).map_err(|e| ("INVALID_KEY", e))?;
            WasmSenderKeyState::derive_seeds_from_master(&master)
                .map_err(|e| ("SENDER_KEY_INIT_FAILED", e))?
        }
    };

    let (state, dist) = WasmSenderKeyState::create_from_seeds(
        chat_id,
        sender_user_id,
        sender_device_id,
        chain_id,
        iteration,
        chain_key,
        signing_sec,
    );
    let state_json = state.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;
    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut()
                .sender_key_sessions
                .insert(sid.clone(), state);
        });
    }

    Ok(json!({
        "session_id": session_id,
        "state_json": state_json,
        "chat_id": dist.chat_id,
        "sender_user_id": dist.sender_user_id,
        "sender_device_id": dist.sender_device_id,
        "chain_id": dist.chain_id,
        "key_id": dist.chain_id,
        "iteration": dist.iteration,
        "distribution": dist,
    }))
}

fn op_e2ee_sender_key_from_distribution(req: &Value) -> Result<Value, (&'static str, String)> {
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let dist_val = req
        .get("distribution")
        .or_else(|| req.get("distribution_message"))
        .or_else(|| req.get("msg"))
        .unwrap_or(req);
    let dist: SenderKeyDistributionMessage = serde_json::from_value(dist_val.clone())
        .map_err(|e| ("INVALID_PARAMS", format!("invalid 'distribution': {e}")))?;

    let state =
        WasmSenderKeyState::from_distribution(&dist).map_err(|e| ("INVALID_KEY", e))?;
    let chat_id = state.chat_id;
    let sender_user_id = state.sender_user_id;
    let sender_device_id = state.sender_device_id.clone();
    let chain_id = state.chain_id;
    let iteration = state.iteration;
    let state_json = state.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;

    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut()
                .sender_key_sessions
                .insert(sid.clone(), state);
        });
    }

    Ok(json!({
        "session_id": session_id,
        "state_json": state_json,
        "chat_id": chat_id,
        "sender_user_id": sender_user_id,
        "sender_device_id": sender_device_id,
        "chain_id": chain_id,
        "key_id": chain_id,
        "iteration": iteration,
    }))
}

fn load_sender_key_state(
    req: &Value,
) -> Result<(Option<String>, WasmSenderKeyState), (&'static str, String)> {
    let session_id = req
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(raw_json) = req
        .get("state_json")
        .or_else(|| req.get("session_json"))
        .and_then(|v| v.as_str())
    {
        let st =
            WasmSenderKeyState::from_json(raw_json).map_err(|e| ("INVALID_SESSION", e))?;
        return Ok((session_id, st));
    }

    if let Some(ref sid) = session_id {
        let found = STATE.with(|cell| cell.borrow().sender_key_sessions.get(sid).cloned());
        if let Some(st) = found {
            return Ok((session_id, st));
        }
        return Err((
            "SESSION_NOT_FOUND",
            format!("no SenderKey state stored for session_id '{sid}'"),
        ));
    }

    Err((
        "INVALID_PARAMS",
        "provide either 'session_id' or 'state_json'".into(),
    ))
}

fn op_e2ee_sender_key_encrypt(req: &Value) -> Result<Value, (&'static str, String)> {
    let (session_id, mut state) = load_sender_key_state(req)?;
    let plaintext: Vec<u8> = if let Some(b64) = req.get("plaintext_b64").and_then(|v| v.as_str()) {
        b64_decode_vec(b64).map_err(|e| ("INVALID_PARAMS", e))?
    } else if let Some(utf8) = req
        .get("plaintext_utf8")
        .or_else(|| req.get("plaintext"))
        .and_then(|v| v.as_str())
    {
        utf8.as_bytes().to_vec()
    } else {
        return Err((
            "INVALID_PARAMS",
            "provide 'plaintext', 'plaintext_utf8', or 'plaintext_b64'".into(),
        ));
    };

    let group_ciphertext = state
        .encrypt_group_message(&plaintext)
        .map_err(|e| ("ENCRYPT_FAILED", e))?;
    let state_json = state.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;

    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut()
                .sender_key_sessions
                .insert(sid.clone(), state);
        });
    }

    Ok(json!({
        "session_id": session_id,
        "group_ciphertext": group_ciphertext,
        "state_json": state_json,
    }))
}

fn op_e2ee_sender_key_decrypt(req: &Value) -> Result<Value, (&'static str, String)> {
    let (session_id, mut state) = load_sender_key_state(req)?;
    let ct_val = req
        .get("group_ciphertext")
        .or_else(|| req.get("ciphertext_msg"))
        .or_else(|| req.get("msg"))
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'group_ciphertext'".into()))?;
    let group_ct: GroupCiphertext = serde_json::from_value(ct_val.clone())
        .map_err(|e| ("INVALID_PARAMS", format!("invalid 'group_ciphertext': {e}")))?;

    let plaintext = state.decrypt_group_message(&group_ct).map_err(|e| {
        if e.starts_with("REPLAY_DETECTED") {
            ("REPLAY_DETECTED", e)
        } else if e.starts_with("SIGNATURE_FAILED") {
            ("SIGNATURE_VERIFICATION_FAILED", e)
        } else if e.starts_with("OUT_OF_ORDER_LIMIT") {
            ("OUT_OF_ORDER_LIMIT", e)
        } else if e.starts_with("SESSION_MISMATCH") {
            ("SESSION_MISMATCH", e)
        } else {
            ("DECRYPT_FAILED", e)
        }
    })?;

    let state_json = state.to_json().map_err(|e| ("SERIALIZE_ERROR", e))?;
    if let Some(ref sid) = session_id {
        STATE.with(|cell| {
            cell.borrow_mut()
                .sender_key_sessions
                .insert(sid.clone(), state);
        });
    }

    let plaintext_utf8 = String::from_utf8(plaintext.clone()).ok();
    Ok(json!({
        "session_id": session_id,
        "plaintext_b64": b64_encode(&plaintext),
        "plaintext_utf8": plaintext_utf8,
        "state_json": state_json,
    }))
}

fn validate_waveform_input_array_len(
    arr: &Value,
    field_name: &str,
) -> Result<(), (&'static str, String)> {
    let Some(items) = arr.as_array() else {
        return Err((
            "INVALID_PARAMS",
            format!("'{field_name}' must be a JSON array"),
        ));
    };
    if items.len() > MAX_WAVEFORM_INPUT_SAMPLES {
        return Err((
            "INVALID_PARAMS",
            format!(
                "'{field_name}' length ({}) exceeds maximum ({MAX_WAVEFORM_INPUT_SAMPLES})",
                items.len()
            ),
        ));
    }
    Ok(())
}

fn op_waveform_encode_5bit(req: &Value) -> Result<Value, (&'static str, String)> {
    let bars: Vec<u8> = if let Some(arr) = req.get("bars") {
        validate_waveform_input_array_len(arr, "bars")?;
        serde_json::from_value(arr.clone())
            .map_err(|e| ("INVALID_PARAMS", format!("invalid 'bars': {e}")))?
    } else if let Some(arr) = req.get("pcm_peaks") {
        validate_waveform_input_array_len(arr, "pcm_peaks")?;
        let peaks: Vec<u16> = serde_json::from_value(arr.clone())
            .map_err(|e| ("INVALID_PARAMS", format!("invalid 'pcm_peaks': {e}")))?;
        normalize_pcm_peaks(&peaks)
    } else if let Some(arr) = req.get("float_peaks").or_else(|| req.get("peaks")) {
        validate_waveform_input_array_len(arr, "float_peaks")?;
        let floats: Vec<f32> = serde_json::from_value(arr.clone())
            .map_err(|e| ("INVALID_PARAMS", format!("invalid 'float_peaks': {e}")))?;
        bars_from_float_peaks(&floats)
    } else if let Some(arr) = req.get("samples_u8").or_else(|| req.get("samples")) {
        validate_waveform_input_array_len(arr, "samples_u8")?;
        let samples: Vec<u8> = serde_json::from_value(arr.clone())
            .map_err(|e| ("INVALID_PARAMS", format!("invalid 'samples_u8': {e}")))?;
        resample_and_normalize_waveform(&samples)
    } else {
        return Err((
            "INVALID_PARAMS",
            "provide 'bars', 'pcm_peaks', 'float_peaks', or 'samples_u8'".into(),
        ));
    };

    let clamped_bars: Vec<u8> = bars.iter().take(100).map(|&b| b.min(31)).collect();
    let encoded = encode_waveform_5bit(&clamped_bars);
    Ok(json!({
        "encoded_b64": b64_encode(&encoded),
        "bytes_len": encoded.len(),
        "bars": clamped_bars,
    }))
}

fn op_waveform_decode_5bit(req: &Value) -> Result<Value, (&'static str, String)> {
    let encoded_b64 = req
        .get("encoded_b64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'encoded_b64'".into()))?;
    if encoded_b64.len() > MAX_WAVEFORM_ENCODED_BYTES * 2 {
        return Err((
            "INVALID_PARAMS",
            format!(
                "'encoded_b64' length ({}) exceeds maximum ({})",
                encoded_b64.len(),
                MAX_WAVEFORM_ENCODED_BYTES * 2
            ),
        ));
    }
    let encoded = b64_decode_vec(encoded_b64).map_err(|e| ("INVALID_PARAMS", e))?;
    if encoded.len() > MAX_WAVEFORM_ENCODED_BYTES {
        return Err((
            "INVALID_PARAMS",
            format!(
                "decoded waveform byte length ({}) exceeds maximum ({MAX_WAVEFORM_ENCODED_BYTES})",
                encoded.len()
            ),
        ));
    }

    let bars = decode_waveform_5bit(&encoded);
    let float_count = match req.get("float_count").or_else(|| req.get("bar_count")) {
        Some(v) if !v.is_null() => {
            let n = v.as_u64().ok_or_else(|| {
                (
                    "INVALID_PARAMS",
                    "'float_count' / 'bar_count' must be a non-negative integer".into(),
                )
            })?;
            if n > MAX_WAVEFORM_FLOAT_COUNT as u64 {
                return Err((
                    "INVALID_PARAMS",
                    format!(
                        "'float_count' ({n}) exceeds maximum allowed ({MAX_WAVEFORM_FLOAT_COUNT})"
                    ),
                ));
            }
            n as usize
        }
        _ => bars.len(),
    };
    let floats = decode_waveform_to_floats(&encoded, float_count);
    Ok(json!({
        "bars": bars,
        "floats": floats,
    }))
}

fn op_html_to_markdown(req: &Value) -> Result<Value, (&'static str, String)> {
    let html = req
        .get("html")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'html' string".into()))?;
    let include_links = req
        .get("include_links")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let offset = req
        .get("offset")
        .and_then(|v| v.as_u64())
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
        .unwrap_or(0);
    let max_chars = req
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
    let scan_inj = req
        .get("scan_injection")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let page = html_to_markdown(html, include_links, offset, max_chars, scan_inj);
    serde_json::to_value(page).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))
}

fn op_scan_injection(req: &Value) -> Result<Value, (&'static str, String)> {
    let text = req
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_PARAMS", "missing 'text' string".into()))?;
    let res = scan_content_for_injection(text);
    serde_json::to_value(res).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))
}

fn op_browser_validate_frame(req: &Value) -> Result<Value, (&'static str, String)> {
    let raw = match req.get("raw").or_else(|| req.get("frame")) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string(other)
            .map_err(|e| ("INVALID_PARAMS", format!("invalid frame JSON: {e}")))?,
        None => return Err(("INVALID_PARAMS", "missing 'raw' or 'frame' field".into())),
    };

    let parsed =
        BrowserBridgeFrame::parse_json(&raw).map_err(|e| ("INVALID_BRIDGE_FRAME", e))?;
    let canonical = parsed
        .to_json_string()
        .map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
    let canonical_val: Value =
        serde_json::from_str(&canonical).map_err(|e| ("SERIALIZE_ERROR", e.to_string()))?;
    Ok(json!({
        "frame": canonical_val,
        "json": canonical,
    }))
}
