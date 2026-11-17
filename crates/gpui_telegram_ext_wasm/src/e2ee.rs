//! Pure-Rust WASM E2EE Engine (X3DH + Ed25519 Signed PreKeys + ChaCha20-Poly1305 Double Ratchet
//! + SenderKey Group E2EE + 4-Emoji Safety Numbers) with 100% wire parity to
//! `gpui_telegram_client::e2ee` and zero `getrandom`.

use base64::{engine::general_purpose::STANDARD as BASE64_STD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use gpui_telegram_proto::e2ee::{
    DevicePreKeyBundle, GroupCiphertext, OneTimePreKeyDto, PublishPreKeysRequest, RatchetHeaderDto,
    SenderKeyDistributionMessage, SignedPreKeyDto,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

pub const SPK_SIGN_DOMAIN: &[u8] = b"gpui-e2ee-spk-v1";
pub const SAFETY_DOMAIN: &[u8] = b"gpui-e2ee-safety-v1";
pub const X3DH_HKDF_INFO: &[u8] = b"gpui-telegram-x3dh-v1";
pub const RATCHET_RK_INFO: &[u8] = b"gpui-e2ee-rk-v1";
pub const SENDER_KEY_SIGN_DOMAIN: &[u8] = b"gpui-e2ee-sk-v1";
pub const SENDER_KEY_SEED_HKDF_INFO: &[u8] = b"gpui-e2ee-sk-seed-v1";
pub const MAX_SKIP: u32 = 256;
pub const MAX_SKIPPED_STORAGE: usize = 2000;
pub const MAX_GROUP_SKIP: u32 = 256;
pub const MAX_GROUP_SKIPPED_STORAGE: usize = 2000;

const SAFETY_EMOJIS: [&str; 32] = [
    "🔐", "🛡️", "🗝️", "🦊", "🐋", "🦉", "🐢", "🐬", "🦅", "🐝", "🌵", "🌻", "🍄", "🌊", "🔥", "❄️",
    "⚡", "🌙", "⭐", "💎", "🧭", "⚓", "🎯", "🧩", "🎻", "🚀", "🛸", "🏔️", "🌋", "🍀", "🍁", "🪷",
];

pub fn b64_encode(bytes: &[u8]) -> String {
    BASE64_STD.encode(bytes)
}

pub fn b64_decode_vec(s: &str) -> Result<Vec<u8>, String> {
    BASE64_STD
        .decode(s.trim())
        .map_err(|e| format!("invalid base64: {e}"))
}

pub fn b64_decode_32(s: &str) -> Result<[u8; 32], String> {
    let bytes = b64_decode_vec(s)?;
    if bytes.len() != 32 {
        return Err(format!("expected 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn b64_decode_64(s: &str) -> Result<[u8; 64], String> {
    let bytes = b64_decode_vec(s)?;
    if bytes.len() != 64 {
        return Err(format!("expected 64 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn x25519_pub_from_secret(sec: &[u8; 32]) -> [u8; 32] {
    let static_sec = StaticSecret::from(*sec);
    X25519PublicKey::from(&static_sec).to_bytes()
}

pub fn x25519_dh(sec: &[u8; 32], pub_bytes: &[u8; 32]) -> Result<[u8; 32], String> {
    let s = StaticSecret::from(*sec);
    let p = X25519PublicKey::from(*pub_bytes);
    let shared = s.diffie_hellman(&p).to_bytes();
    if shared.iter().all(|&b| b == 0) {
        return Err("low-order X25519 point produced all-zero shared secret".into());
    }
    Ok(shared)
}

pub fn sign_signed_prekey(ed25519_sec: &[u8; 32], spk_pub: &[u8; 32]) -> [u8; 64] {
    let signing = SigningKey::from_bytes(ed25519_sec);
    let mut msg = Vec::with_capacity(SPK_SIGN_DOMAIN.len() + 32);
    msg.extend_from_slice(SPK_SIGN_DOMAIN);
    msg.extend_from_slice(spk_pub);
    signing.sign(&msg).to_bytes()
}

pub fn verify_signed_prekey(
    signing_pub: &[u8; 32],
    spk_pub: &[u8; 32],
    sig: &[u8; 64],
) -> Result<(), String> {
    let verifying = VerifyingKey::from_bytes(signing_pub)
        .map_err(|e| format!("invalid Ed25519 verifying key: {e}"))?;
    let signature = Signature::from_bytes(sig);
    let mut msg = Vec::with_capacity(SPK_SIGN_DOMAIN.len() + 32);
    msg.extend_from_slice(SPK_SIGN_DOMAIN);
    msg.extend_from_slice(spk_pub);
    verifying
        .verify(&msg, &signature)
        .map_err(|e| format!("signed prekey Ed25519 signature verification failed: {e}"))
}

pub fn compute_safety_number_emojis(local_ik: &[u8; 32], remote_ik: &[u8; 32]) -> String {
    let (a, b) = if local_ik <= remote_ik {
        (local_ik, remote_ik)
    } else {
        (remote_ik, local_ik)
    };
    let mut hasher = Sha256::new();
    hasher.update(SAFETY_DOMAIN);
    hasher.update(a);
    hasher.update(b);
    let digest = hasher.finalize();
    let mut out = String::new();
    for idx in 0..4 {
        let emoji = SAFETY_EMOJIS[(digest[idx] as usize) % SAFETY_EMOJIS.len()];
        out.push_str(emoji);
    }
    out
}

#[derive(Debug, Clone, Deserialize)]
pub struct OneTimeSeedInput {
    pub key_id: u32,
    pub seed_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedOneTimeSecret {
    pub key_id: u32,
    pub secret_b64: String,
    pub public_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedDeviceKeysOutput {
    pub publish_request: PublishPreKeysRequest,
    pub public_bundle: DevicePreKeyBundle,
    pub identity_x25519_sec_b64: String,
    pub identity_x25519_pub_b64: String,
    pub identity_ed25519_sec_b64: String,
    pub identity_ed25519_pub_b64: String,
    pub signed_prekey_sec_b64: String,
    pub one_time_secrets: Vec<GeneratedOneTimeSecret>,
}

pub fn generate_device_bundle_from_seeds(
    user_id: u64,
    device_id: String,
    device_name: Option<String>,
    ik_x25519_seed: [u8; 32],
    ik_ed25519_seed: [u8; 32],
    spk_id: u32,
    spk_seed: [u8; 32],
    created_at_ms: i64,
    otpk_seeds: &[OneTimeSeedInput],
) -> Result<GeneratedDeviceKeysOutput, String> {
    let ik_x25519_pub = x25519_pub_from_secret(&ik_x25519_seed);
    let signing = SigningKey::from_bytes(&ik_ed25519_seed);
    let ik_ed25519_pub = signing.verifying_key().to_bytes();

    let spk_pub = x25519_pub_from_secret(&spk_seed);
    let spk_sig = sign_signed_prekey(&ik_ed25519_seed, &spk_pub);

    let signed_prekey = SignedPreKeyDto {
        key_id: spk_id,
        public_key: b64_encode(&spk_pub),
        signature: b64_encode(&spk_sig),
        created_at_ms,
    };

    let mut one_time_dtos = Vec::with_capacity(otpk_seeds.len());
    let mut one_time_secrets = Vec::with_capacity(otpk_seeds.len());

    for item in otpk_seeds {
        let seed = b64_decode_32(&item.seed_b64)?;
        let pub_bytes = x25519_pub_from_secret(&seed);
        let pub_b64 = b64_encode(&pub_bytes);
        one_time_dtos.push(OneTimePreKeyDto {
            key_id: item.key_id,
            public_key: pub_b64.clone(),
        });
        one_time_secrets.push(GeneratedOneTimeSecret {
            key_id: item.key_id,
            secret_b64: b64_encode(&seed),
            public_b64: pub_b64,
        });
    }

    let ik_x25519_pub_b64 = b64_encode(&ik_x25519_pub);
    let ik_ed25519_pub_b64 = b64_encode(&ik_ed25519_pub);

    let public_bundle = DevicePreKeyBundle {
        user_id,
        device_id: device_id.clone(),
        device_name: device_name.clone(),
        identity_key: ik_x25519_pub_b64.clone(),
        identity_signing_key: ik_ed25519_pub_b64.clone(),
        signed_prekey: signed_prekey.clone(),
        one_time_prekey: one_time_dtos.first().cloned(),
    };

    let publish_request = PublishPreKeysRequest {
        device_id,
        device_name,
        identity_key: ik_x25519_pub_b64.clone(),
        identity_signing_key: ik_ed25519_pub_b64.clone(),
        signed_prekey,
        one_time_prekeys: one_time_dtos,
    };

    Ok(GeneratedDeviceKeysOutput {
        publish_request,
        public_bundle,
        identity_x25519_sec_b64: b64_encode(&ik_x25519_seed),
        identity_x25519_pub_b64: ik_x25519_pub_b64,
        identity_ed25519_sec_b64: b64_encode(&ik_ed25519_seed),
        identity_ed25519_pub_b64: ik_ed25519_pub_b64,
        signed_prekey_sec_b64: b64_encode(&spk_seed),
        one_time_secrets,
    })
}

pub struct X3dhAgreementOutput {
    pub shared_secret: Zeroizing<[u8; 32]>,
    pub associated_data: Vec<u8>,
    pub remote_ik_pub: [u8; 32],
    pub remote_spk_pub: [u8; 32],
}

pub fn x3dh_initiator(
    ik_a_sec: &[u8; 32],
    ek_a_sec: &[u8; 32],
    bundle: &DevicePreKeyBundle,
) -> Result<X3dhAgreementOutput, String> {
    let ik_b_pub = b64_decode_32(&bundle.identity_key)?;
    let ik_b_sign_pub = b64_decode_32(&bundle.identity_signing_key)?;
    let spk_b_pub = b64_decode_32(&bundle.signed_prekey.public_key)?;
    let spk_b_sig = b64_decode_64(&bundle.signed_prekey.signature)?;

    verify_signed_prekey(&ik_b_sign_pub, &spk_b_pub, &spk_b_sig)?;

    let dh1 = x25519_dh(ik_a_sec, &spk_b_pub)?;
    let dh2 = x25519_dh(ek_a_sec, &ik_b_pub)?;
    let dh3 = x25519_dh(ek_a_sec, &spk_b_pub)?;

    let mut ikm = Zeroizing::new(Vec::with_capacity(32 * 5));
    ikm.extend_from_slice(&[0xFFu8; 32]);
    ikm.extend_from_slice(&dh1);
    ikm.extend_from_slice(&dh2);
    ikm.extend_from_slice(&dh3);

    if let Some(ref otpk) = bundle.one_time_prekey {
        let opk_b_pub = b64_decode_32(&otpk.public_key)?;
        let dh4 = x25519_dh(ek_a_sec, &opk_b_pub)?;
        ikm.extend_from_slice(&dh4);
    }

    let mut okm = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, &ikm)
        .expand(X3DH_HKDF_INFO, &mut *okm)
        .map_err(|_| "X3DH HKDF expand failed".to_string())?;

    let ik_a_pub = x25519_pub_from_secret(ik_a_sec);
    let mut associated_data = Vec::with_capacity(64);
    associated_data.extend_from_slice(&ik_a_pub);
    associated_data.extend_from_slice(&ik_b_pub);

    Ok(X3dhAgreementOutput {
        shared_secret: okm,
        associated_data,
        remote_ik_pub: ik_b_pub,
        remote_spk_pub: spk_b_pub,
    })
}

pub fn x3dh_responder(
    ik_b_sec: &[u8; 32],
    spk_b_sec: &[u8; 32],
    opk_b_sec: Option<&[u8; 32]>,
    ik_a_pub: &[u8; 32],
    ek_a_pub: &[u8; 32],
) -> Result<(Zeroizing<[u8; 32]>, Vec<u8>), String> {
    let dh1 = x25519_dh(spk_b_sec, ik_a_pub)?;
    let dh2 = x25519_dh(ik_b_sec, ek_a_pub)?;
    let dh3 = x25519_dh(spk_b_sec, ek_a_pub)?;

    let mut ikm = Zeroizing::new(Vec::with_capacity(32 * 5));
    ikm.extend_from_slice(&[0xFFu8; 32]);
    ikm.extend_from_slice(&dh1);
    ikm.extend_from_slice(&dh2);
    ikm.extend_from_slice(&dh3);

    if let Some(opk_sec) = opk_b_sec {
        let dh4 = x25519_dh(opk_sec, ek_a_pub)?;
        ikm.extend_from_slice(&dh4);
    }

    let mut okm = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, &ikm)
        .expand(X3DH_HKDF_INFO, &mut *okm)
        .map_err(|_| "X3DH HKDF expand failed".to_string())?;

    let ik_b_pub = x25519_pub_from_secret(ik_b_sec);
    let mut associated_data = Vec::with_capacity(64);
    associated_data.extend_from_slice(ik_a_pub);
    associated_data.extend_from_slice(&ik_b_pub);

    Ok((okm, associated_data))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SkippedEntrySerde {
    dh_pub: [u8; 32],
    msg_num: u32,
    mk: [u8; 32],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ReplayEntrySerde {
    dh_pub: [u8; 32],
    msg_num: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DoubleRatchetWire {
    dh_self_sec: [u8; 32],
    dh_self_pub: [u8; 32],
    dh_remote: Option<[u8; 32]>,
    root_key: [u8; 32],
    send_chain_key: Option<[u8; 32]>,
    recv_chain_key: Option<[u8; 32]>,
    send_n: u32,
    recv_n: u32,
    prev_send_n: u32,
    skipped: Vec<SkippedEntrySerde>,
    replay: Vec<ReplayEntrySerde>,
    ad: Vec<u8>,
    pending_x3dh_ek_pub: Option<[u8; 32]>,
    pending_x3dh_spk_id: Option<u32>,
    pending_x3dh_otpk_id: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct WasmDoubleRatchetSession {
    pub dh_self_sec: [u8; 32],
    pub dh_self_pub: [u8; 32],
    pub dh_remote: Option<[u8; 32]>,
    pub root_key: [u8; 32],
    pub send_chain_key: Option<[u8; 32]>,
    pub recv_chain_key: Option<[u8; 32]>,
    pub send_n: u32,
    pub recv_n: u32,
    pub prev_send_n: u32,
    skipped_keys: HashMap<([u8; 32], u32), [u8; 32]>,
    skipped_order: VecDeque<([u8; 32], u32)>,
    seen_replay: HashSet<([u8; 32], u32)>,
    pub ad: Vec<u8>,
    pub pending_x3dh_ek_pub: Option<[u8; 32]>,
    pub pending_x3dh_spk_id: Option<u32>,
    pub pending_x3dh_otpk_id: Option<u32>,
}

impl WasmDoubleRatchetSession {
    pub fn to_json(&self) -> Result<String, String> {
        let skipped = self
            .skipped_order
            .iter()
            .filter_map(|k| {
                self.skipped_keys.get(k).map(|mk| SkippedEntrySerde {
                    dh_pub: k.0,
                    msg_num: k.1,
                    mk: *mk,
                })
            })
            .collect();
        let replay = self
            .seen_replay
            .iter()
            .map(|&(dh_pub, msg_num)| ReplayEntrySerde { dh_pub, msg_num })
            .collect();
        let wire = DoubleRatchetWire {
            dh_self_sec: self.dh_self_sec,
            dh_self_pub: self.dh_self_pub,
            dh_remote: self.dh_remote,
            root_key: self.root_key,
            send_chain_key: self.send_chain_key,
            recv_chain_key: self.recv_chain_key,
            send_n: self.send_n,
            recv_n: self.recv_n,
            prev_send_n: self.prev_send_n,
            skipped,
            replay,
            ad: self.ad.clone(),
            pending_x3dh_ek_pub: self.pending_x3dh_ek_pub,
            pending_x3dh_spk_id: self.pending_x3dh_spk_id,
            pending_x3dh_otpk_id: self.pending_x3dh_otpk_id,
        };
        serde_json::to_string(&wire).map_err(|e| format!("session serialize failed: {e}"))
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let wire: DoubleRatchetWire =
            serde_json::from_str(json).map_err(|e| format!("session deserialize failed: {e}"))?;
        let mut skipped_keys = HashMap::with_capacity(wire.skipped.len());
        let mut skipped_order = VecDeque::with_capacity(wire.skipped.len());
        for entry in wire.skipped {
            let k = (entry.dh_pub, entry.msg_num);
            skipped_keys.insert(k, entry.mk);
            skipped_order.push_back(k);
        }
        let mut seen_replay = HashSet::with_capacity(wire.replay.len());
        for entry in wire.replay {
            seen_replay.insert((entry.dh_pub, entry.msg_num));
        }
        Ok(Self {
            dh_self_sec: wire.dh_self_sec,
            dh_self_pub: wire.dh_self_pub,
            dh_remote: wire.dh_remote,
            root_key: wire.root_key,
            send_chain_key: wire.send_chain_key,
            recv_chain_key: wire.recv_chain_key,
            send_n: wire.send_n,
            recv_n: wire.recv_n,
            prev_send_n: wire.prev_send_n,
            skipped_keys,
            skipped_order,
            seen_replay,
            ad: wire.ad,
            pending_x3dh_ek_pub: wire.pending_x3dh_ek_pub,
            pending_x3dh_spk_id: wire.pending_x3dh_spk_id,
            pending_x3dh_otpk_id: wire.pending_x3dh_otpk_id,
        })
    }

    pub fn init_alice(
        shared_secret: [u8; 32],
        bob_dh_pub: [u8; 32],
        dh_self_sec: [u8; 32],
        ad: Vec<u8>,
    ) -> Result<Self, String> {
        let dh_self_pub = x25519_pub_from_secret(&dh_self_sec);
        let dh_out = x25519_dh(&dh_self_sec, &bob_dh_pub)?;
        let (root_key, send_ck) = kdf_rk(&shared_secret, &dh_out)?;
        Ok(Self {
            dh_self_sec,
            dh_self_pub,
            dh_remote: Some(bob_dh_pub),
            root_key,
            send_chain_key: Some(send_ck),
            recv_chain_key: None,
            send_n: 0,
            recv_n: 0,
            prev_send_n: 0,
            skipped_keys: HashMap::new(),
            skipped_order: VecDeque::new(),
            seen_replay: HashSet::new(),
            ad,
            pending_x3dh_ek_pub: None,
            pending_x3dh_spk_id: None,
            pending_x3dh_otpk_id: None,
        })
    }

    pub fn init_bob(shared_secret: [u8; 32], bob_dh_sec: [u8; 32], ad: Vec<u8>) -> Self {
        let bob_dh_pub = x25519_pub_from_secret(&bob_dh_sec);
        Self {
            dh_self_sec: bob_dh_sec,
            dh_self_pub: bob_dh_pub,
            dh_remote: None,
            root_key: shared_secret,
            send_chain_key: None,
            recv_chain_key: None,
            send_n: 0,
            recv_n: 0,
            prev_send_n: 0,
            skipped_keys: HashMap::new(),
            skipped_order: VecDeque::new(),
            seen_replay: HashSet::new(),
            ad,
            pending_x3dh_ek_pub: None,
            pending_x3dh_spk_id: None,
            pending_x3dh_otpk_id: None,
        }
    }

    pub fn set_pending_x3dh_prekey_info(
        &mut self,
        ek_pub: [u8; 32],
        spk_id: u32,
        otpk_id: Option<u32>,
    ) {
        self.pending_x3dh_ek_pub = Some(ek_pub);
        self.pending_x3dh_spk_id = Some(spk_id);
        self.pending_x3dh_otpk_id = otpk_id;
    }

    pub fn clear_pending_x3dh_prekey_info(&mut self) {
        self.pending_x3dh_ek_pub = None;
        self.pending_x3dh_spk_id = None;
        self.pending_x3dh_otpk_id = None;
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(RatchetHeaderDto, String), String> {
        let Some(ck_s) = self.send_chain_key else {
            return Err("send chain key not initialized yet".into());
        };
        let (mk, next_ck_s) = kdf_ck(&ck_s)?;
        let header = RatchetHeaderDto {
            dh_pub: b64_encode(&self.dh_self_pub),
            prev_chain_len: self.prev_send_n,
            msg_num: self.send_n,
        };
        let aad = build_header_aad(
            &self.ad,
            &self.dh_self_pub,
            header.prev_chain_len,
            header.msg_num,
        );
        let nonce = msg_nonce(header.msg_num);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&mk));
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| "AEAD encryption error".to_string())?;

        self.send_chain_key = Some(next_ck_s);
        self.send_n = self.send_n.saturating_add(1);
        Ok((header, b64_encode(&ciphertext)))
    }

    pub fn decrypt(
        &mut self,
        header: &RatchetHeaderDto,
        ciphertext_b64: &str,
        next_dh_sec: [u8; 32],
    ) -> Result<Vec<u8>, String> {
        let remote_dh_pub = b64_decode_32(&header.dh_pub)?;
        let ciphertext = b64_decode_vec(ciphertext_b64)?;
        let replay_key = (remote_dh_pub, header.msg_num);
        if self.seen_replay.contains(&replay_key) {
            return Err("REPLAY_DETECTED: duplicate message header/num".into());
        }

        let aad = build_header_aad(
            &self.ad,
            &remote_dh_pub,
            header.prev_chain_len,
            header.msg_num,
        );
        let nonce = msg_nonce(header.msg_num);

        // Operate on a staged copy so failed AEAD verification never mutates ratchet state.
        let mut staged = self.clone();

        if let Some(mk) = staged.skipped_keys.remove(&replay_key) {
            let plaintext = aead_decrypt(&mk, &nonce, &ciphertext, &aad)?;
            staged.seen_replay.insert(replay_key);
            *self = staged;
            return Ok(plaintext);
        }

        if staged.dh_remote != Some(remote_dh_pub) {
            staged.skip_message_keys(header.prev_chain_len)?;
            staged.dh_ratchet(remote_dh_pub, next_dh_sec)?;
            staged.clear_pending_x3dh_prekey_info();
        }

        staged.skip_message_keys(header.msg_num)?;
        let ck_r = staged
            .recv_chain_key
            .ok_or_else(|| "missing receive chain key after DH ratchet".to_string())?;
        let (mk, next_ck_r) = kdf_ck(&ck_r)?;
        staged.recv_chain_key = Some(next_ck_r);
        staged.recv_n = staged.recv_n.saturating_add(1);

        let plaintext = aead_decrypt(&mk, &nonce, &ciphertext, &aad)?;
        staged.seen_replay.insert(replay_key);
        *self = staged;
        Ok(plaintext)
    }

    fn skip_message_keys(&mut self, until: u32) -> Result<(), String> {
        if self.recv_n.saturating_add(MAX_SKIP) < until {
            return Err("OUT_OF_ORDER_LIMIT: skipped message key limit exceeded".into());
        }
        if let Some(mut ck_r) = self.recv_chain_key {
            let remote = self
                .dh_remote
                .ok_or_else(|| "missing dh_remote while skipping keys".to_string())?;
            while self.recv_n < until {
                let (mk, next_ck_r) = kdf_ck(&ck_r)?;
                ck_r = next_ck_r;
                let key = (remote, self.recv_n);
                if !self.skipped_keys.contains_key(&key) {
                    if self.skipped_order.len() >= MAX_SKIPPED_STORAGE
                        && let Some(oldest) = self.skipped_order.pop_front()
                    {
                        self.skipped_keys.remove(&oldest);
                    }
                    self.skipped_keys.insert(key, mk);
                    self.skipped_order.push_back(key);
                }
                self.recv_n = self.recv_n.saturating_add(1);
            }
            self.recv_chain_key = Some(ck_r);
        }
        Ok(())
    }

    fn dh_ratchet(
        &mut self,
        remote_dh_pub: [u8; 32],
        next_self_sec: [u8; 32],
    ) -> Result<(), String> {
        self.prev_send_n = self.send_n;
        self.send_n = 0;
        self.recv_n = 0;
        self.dh_remote = Some(remote_dh_pub);

        let dh_recv = x25519_dh(&self.dh_self_sec, &remote_dh_pub)?;
        let (rk1, ck_r) = kdf_rk(&self.root_key, &dh_recv)?;
        self.root_key = rk1;
        self.recv_chain_key = Some(ck_r);

        let next_self_pub = x25519_pub_from_secret(&next_self_sec);
        let dh_send = x25519_dh(&next_self_sec, &remote_dh_pub)?;
        let (rk2, ck_s) = kdf_rk(&self.root_key, &dh_send)?;
        self.dh_self_sec = next_self_sec;
        self.dh_self_pub = next_self_pub;
        self.root_key = rk2;
        self.send_chain_key = Some(ck_s);
        Ok(())
    }
}

fn kdf_rk(rk: &[u8; 32], dh_out: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), String> {
    let mut out = [0u8; 64];
    Hkdf::<Sha256>::new(Some(rk), dh_out)
        .expand(RATCHET_RK_INFO, &mut out)
        .map_err(|_| "ratchet HKDF expand failed".to_string())?;
    let mut next_rk = [0u8; 32];
    let mut next_ck = [0u8; 32];
    next_rk.copy_from_slice(&out[..32]);
    next_ck.copy_from_slice(&out[32..]);
    Ok((next_rk, next_ck))
}

fn kdf_ck(ck: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), String> {
    let mut mac_mk =
        <HmacSha256 as Mac>::new_from_slice(ck).map_err(|_| "HMAC key error".to_string())?;
    mac_mk.update(&[0x01]);
    let mk_bytes = mac_mk.finalize().into_bytes();

    let mut mac_ck =
        <HmacSha256 as Mac>::new_from_slice(ck).map_err(|_| "HMAC key error".to_string())?;
    mac_ck.update(&[0x02]);
    let ck_bytes = mac_ck.finalize().into_bytes();

    let mut mk = [0u8; 32];
    let mut next_ck = [0u8; 32];
    mk.copy_from_slice(&mk_bytes);
    next_ck.copy_from_slice(&ck_bytes);
    Ok((mk, next_ck))
}

fn msg_nonce(msg_num: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[8..12].copy_from_slice(&msg_num.to_be_bytes());
    nonce
}

fn build_header_aad(ad: &[u8], dh_pub: &[u8; 32], prev_chain_len: u32, msg_num: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(ad.len() + 40);
    out.extend_from_slice(ad);
    out.extend_from_slice(dh_pub);
    out.extend_from_slice(&prev_chain_len.to_be_bytes());
    out.extend_from_slice(&msg_num.to_be_bytes());
    out
}

fn aead_decrypt(
    mk: &[u8; 32],
    nonce: &[u8; 12],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if ciphertext.len() < 16 {
        return Err("AEAD_TAG_SHORT: ciphertext shorter than authentication tag".into());
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(mk));
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| "AEAD_DECRYPT_FAILED: authentication tag verification failed".into())
}

// ============================================================================
// Group E2EE SenderKey State Machine (1:1 parity with `SenderKeyState`)
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WasmSenderKeyState {
    pub chat_id: i64,
    pub sender_user_id: u64,
    pub sender_device_id: String,
    pub chain_id: u32,
    pub iteration: u32,
    pub chain_key: [u8; 32],
    pub signing_key_sec: Option<[u8; 32]>,
    pub signing_key_pub: [u8; 32],
    pub skipped_keys: HashMap<u32, [u8; 32]>,
    pub skipped_order: VecDeque<u32>,
    pub seen_iterations: HashSet<u32>,
}

impl WasmSenderKeyState {
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("sender key state serialize failed: {e}"))
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("sender key state deserialize failed: {e}"))
    }

    pub fn derive_seeds_from_master(seed: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), String> {
        let mut out = Zeroizing::new([0u8; 64]);
        Hkdf::<Sha256>::new(None, seed)
            .expand(SENDER_KEY_SEED_HKDF_INFO, &mut *out)
            .map_err(|_| "sender key HKDF seed expand failed".to_string())?;
        let mut chain_key = [0u8; 32];
        let mut signing_sec = [0u8; 32];
        chain_key.copy_from_slice(&out[..32]);
        signing_sec.copy_from_slice(&out[32..]);
        Ok((chain_key, signing_sec))
    }

    pub fn create_from_seeds(
        chat_id: i64,
        sender_user_id: u64,
        sender_device_id: String,
        chain_id: Option<u32>,
        iteration: u32,
        chain_key: [u8; 32],
        signing_sec: [u8; 32],
    ) -> (Self, SenderKeyDistributionMessage) {
        let signing_pub = SigningKey::from_bytes(&signing_sec)
            .verifying_key()
            .to_bytes();
        let effective_chain_id = match chain_id {
            Some(id) => id.max(1),
            None => {
                let mut hasher = Sha256::new();
                hasher.update(SENDER_KEY_SIGN_DOMAIN);
                hasher.update(chain_key);
                hasher.update(signing_pub);
                let digest = hasher.finalize();
                let raw_id = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
                raw_id.max(1)
            }
        };

        let state = Self {
            chat_id,
            sender_user_id,
            sender_device_id,
            chain_id: effective_chain_id,
            iteration,
            chain_key,
            signing_key_sec: Some(signing_sec),
            signing_key_pub: signing_pub,
            skipped_keys: HashMap::new(),
            skipped_order: VecDeque::new(),
            seen_iterations: HashSet::new(),
        };
        let dist = state.distribution_message();
        (state, dist)
    }

    pub fn distribution_message(&self) -> SenderKeyDistributionMessage {
        SenderKeyDistributionMessage {
            chat_id: self.chat_id,
            sender_user_id: self.sender_user_id,
            sender_device_id: self.sender_device_id.clone(),
            chain_id: self.chain_id,
            iteration: self.iteration,
            chain_key: b64_encode(&self.chain_key),
            signing_public_key: b64_encode(&self.signing_key_pub),
        }
    }

    pub fn from_distribution(msg: &SenderKeyDistributionMessage) -> Result<Self, String> {
        let chain_key = b64_decode_32(&msg.chain_key)?;
        let signing_key_pub = b64_decode_32(&msg.signing_public_key)?;
        let vk = VerifyingKey::from_bytes(&signing_key_pub)
            .map_err(|e| format!("invalid Ed25519 sender public key: {e}"))?;
        if vk.is_weak() {
            return Err("low-order weak Ed25519 sender public key rejected".into());
        }
        Ok(Self {
            chat_id: msg.chat_id,
            sender_user_id: msg.sender_user_id,
            sender_device_id: msg.sender_device_id.clone(),
            chain_id: msg.chain_id,
            iteration: msg.iteration,
            chain_key,
            signing_key_sec: None,
            signing_key_pub,
            skipped_keys: HashMap::new(),
            skipped_order: VecDeque::new(),
            seen_iterations: HashSet::new(),
        })
    }

    pub fn encrypt_group_message(&mut self, plaintext: &[u8]) -> Result<GroupCiphertext, String> {
        let signing_sec = self
            .signing_key_sec
            .ok_or_else(|| "cannot encrypt with peer's receive-only SenderKeyState".to_string())?;
        let iter = self.iteration;
        let (mk, next_ck) = derive_sender_message_key(&self.chain_key, iter)?;

        let nonce = group_nonce(iter);
        let aad = build_group_aad(
            self.chat_id,
            self.chain_id,
            iter,
            self.sender_user_id,
            &self.sender_device_id,
        );
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&mk));
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| "group AEAD encryption failed".to_string())?;

        let sig_input = build_group_sig_input(self.chat_id, self.chain_id, iter, &ciphertext);
        let signature = SigningKey::from_bytes(&signing_sec)
            .sign(&sig_input)
            .to_bytes();

        self.chain_key = next_ck;
        self.iteration = iter.saturating_add(1);

        Ok(GroupCiphertext {
            chat_id: self.chat_id,
            chain_id: self.chain_id,
            iteration: iter,
            ciphertext: b64_encode(&ciphertext),
            signature: b64_encode(&signature),
        })
    }

    pub fn decrypt_group_message(&mut self, msg: &GroupCiphertext) -> Result<Vec<u8>, String> {
        if msg.chat_id != self.chat_id || msg.chain_id != self.chain_id {
            return Err(format!(
                "SESSION_MISMATCH: SenderKey chat/chain mismatch (expected {}/{}, got {}/{})",
                self.chat_id, self.chain_id, msg.chat_id, msg.chain_id
            ));
        }

        let ciphertext = b64_decode_vec(&msg.ciphertext)?;
        if ciphertext.len() < 16 {
            return Err("DECRYPT_FAILED: group ciphertext shorter than AEAD tag".into());
        }
        let sig_bytes = b64_decode_64(&msg.signature)?;
        let verifying = VerifyingKey::from_bytes(&self.signing_key_pub)
            .map_err(|e| format!("INVALID_KEY: {e}"))?;
        let sig_input =
            build_group_sig_input(msg.chat_id, msg.chain_id, msg.iteration, &ciphertext);
        verifying
            .verify(&sig_input, &Signature::from_bytes(&sig_bytes))
            .map_err(|e| {
                format!("SIGNATURE_FAILED: group sender key Ed25519 verification failed: {e}")
            })?;

        if self.seen_iterations.contains(&msg.iteration) {
            return Err(format!(
                "REPLAY_DETECTED: duplicate group sender key iteration {}",
                msg.iteration
            ));
        }

        // Operate on a staged copy so failed AEAD verification never mutates sender-key state.
        let mut staged = self.clone();
        let aad = build_group_aad(
            staged.chat_id,
            staged.chain_id,
            msg.iteration,
            staged.sender_user_id,
            &staged.sender_device_id,
        );
        let nonce = group_nonce(msg.iteration);

        let mk = if let Some(skipped_mk) = staged.skipped_keys.remove(&msg.iteration) {
            staged.skipped_order.retain(|&it| it != msg.iteration);
            skipped_mk
        } else {
            if msg.iteration < staged.iteration {
                return Err(format!(
                    "REPLAY_DETECTED: stale group sender key iteration {} < {}",
                    msg.iteration, staged.iteration
                ));
            }
            if msg.iteration.saturating_sub(staged.iteration) > MAX_GROUP_SKIP {
                return Err(format!(
                    "OUT_OF_ORDER_LIMIT: iteration jump {} -> {} exceeds MAX_GROUP_SKIP ({MAX_GROUP_SKIP})",
                    staged.iteration, msg.iteration
                ));
            }
            while staged.iteration < msg.iteration {
                let (skip_mk, next_ck) =
                    derive_sender_message_key(&staged.chain_key, staged.iteration)?;
                if staged.skipped_order.len() >= MAX_GROUP_SKIPPED_STORAGE
                    && let Some(oldest) = staged.skipped_order.pop_front()
                {
                    staged.skipped_keys.remove(&oldest);
                }
                staged.skipped_keys.insert(staged.iteration, skip_mk);
                staged.skipped_order.push_back(staged.iteration);
                staged.chain_key = next_ck;
                staged.iteration = staged.iteration.saturating_add(1);
            }
            let (curr_mk, next_ck) =
                derive_sender_message_key(&staged.chain_key, staged.iteration)?;
            staged.chain_key = next_ck;
            staged.iteration = staged.iteration.saturating_add(1);
            curr_mk
        };

        let plaintext = aead_decrypt(&mk, &nonce, &ciphertext, &aad)?;
        staged.seen_iterations.insert(msg.iteration);
        *self = staged;
        Ok(plaintext)
    }
}

fn derive_sender_message_key(
    ck: &[u8; 32],
    iteration: u32,
) -> Result<([u8; 32], [u8; 32]), String> {
    let mut mac_mk = <HmacSha256 as Mac>::new_from_slice(ck)
        .map_err(|_| "sender key HMAC init error".to_string())?;
    mac_mk.update(b"msg");
    mac_mk.update(&iteration.to_be_bytes());
    let mk_bytes = mac_mk.finalize().into_bytes();

    let mut mac_ck = <HmacSha256 as Mac>::new_from_slice(ck)
        .map_err(|_| "sender key HMAC init error".to_string())?;
    mac_ck.update(b"chain");
    let ck_bytes = mac_ck.finalize().into_bytes();

    let mut mk = [0u8; 32];
    let mut next_ck = [0u8; 32];
    mk.copy_from_slice(&mk_bytes);
    next_ck.copy_from_slice(&ck_bytes);
    Ok((mk, next_ck))
}

fn group_nonce(iteration: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[8..12].copy_from_slice(&iteration.to_be_bytes());
    nonce
}

fn build_group_aad(
    chat_id: i64,
    chain_id: u32,
    iteration: u32,
    sender_user_id: u64,
    sender_device_id: &str,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(32 + sender_device_id.len());
    aad.extend_from_slice(&chat_id.to_be_bytes());
    aad.extend_from_slice(&chain_id.to_be_bytes());
    aad.extend_from_slice(&iteration.to_be_bytes());
    aad.extend_from_slice(&sender_user_id.to_be_bytes());
    aad.extend_from_slice(sender_device_id.as_bytes());
    aad
}

fn build_group_sig_input(
    chat_id: i64,
    chain_id: u32,
    iteration: u32,
    ciphertext: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(SENDER_KEY_SIGN_DOMAIN.len() + 16 + ciphertext.len());
    buf.extend_from_slice(SENDER_KEY_SIGN_DOMAIN);
    buf.extend_from_slice(&chat_id.to_be_bytes());
    buf.extend_from_slice(&chain_id.to_be_bytes());
    buf.extend_from_slice(&iteration.to_be_bytes());
    buf.extend_from_slice(ciphertext);
    buf
}
