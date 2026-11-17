import {
  assert,
  defineTest,
  type CdpPageHandle,
  type SharedTierContext,
} from '../../harness/index.ts';

interface ExtractedIdentity {
  raw: Record<string, any>;
  ikPub: string;
  ikSec: string;
  iskPub: string;
  spkId: number;
  spkPub: string;
  spkSec: string;
  spkSig: string;
  spkCreatedAtMs: number;
  otpkId?: number;
  otpkPub?: string;
  otpkSec?: string;
}

function normalizeIdentity(data: Record<string, any>): ExtractedIdentity {
  const ikPub = String(
    data.identity_key ??
      data.x25519_pub ??
      data.ik_pub ??
      data.identity_public_key ??
      '',
  );
  const ikSec = String(
    data.identity_secret ??
      data.identity_private_key ??
      data.identity_secret_key ??
      data.x25519_sec ??
      data.ik_sec ??
      '',
  );
  const iskPub = String(
    data.identity_signing_key ??
      data.ed25519_pub ??
      data.signing_public_key ??
      data.isk_pub ??
      '',
  );

  const spkObj = data.signed_prekey ?? data.spk ?? {};
  const spkId = Number(spkObj.key_id ?? data.spk_id ?? 1);
  const spkPub = String(
    spkObj.public_key ?? data.signed_prekey_public ?? data.spk_pub ?? '',
  );
  const spkSec = String(
    data.signed_prekey_secret ??
      data.signed_prekey_private_key ??
      data.spk_secret ??
      data.spk_sec ??
      spkObj.secret_key ??
      spkObj.private_key ??
      '',
  );
  const spkSig = String(spkObj.signature ?? data.signed_prekey_signature ?? data.spk_sig ?? '');
  const spkCreatedAtMs = Number(spkObj.created_at_ms ?? Date.now());

  const otpks = Array.isArray(data.one_time_prekeys) ? data.one_time_prekeys : [];
  const firstOtpk = otpks[0] ?? null;
  const otpkSecrets = data.one_time_prekey_secrets ?? data.otpk_secrets ?? {};
  const otpkId = firstOtpk ? Number(firstOtpk.key_id ?? 100) : undefined;
  const otpkPub = firstOtpk ? String(firstOtpk.public_key ?? '') : undefined;
  const otpkSec = firstOtpk
    ? String(
        firstOtpk.secret_key ??
          firstOtpk.private_key ??
          (Array.isArray(otpkSecrets)
            ? otpkSecrets[0]?.secret_key ?? otpkSecrets[0]?.private_key ?? otpkSecrets[0]
            : otpkSecrets[String(otpkId)]) ??
          '',
      ) || undefined
    : undefined;

  return {
    raw: data,
    ikPub,
    ikSec,
    iskPub,
    spkId,
    spkPub,
    spkSec,
    spkSig,
    spkCreatedAtMs,
    otpkId,
    otpkPub,
    otpkSec,
  };
}

async function performX3dhHandshakeInWasm(page: CdpPageHandle) {
  const aliceGen = await page.invokeWasm('e2ee_generate_identity', {
    device_id: 'alice_wasm_dev',
    spk_id: 1,
    otpk_count: 2,
  });
  assert.equal(aliceGen.ok, true, `Alice e2ee_generate_identity failed: ${JSON.stringify(aliceGen)}`);

  const bobGen = await page.invokeWasm('e2ee_generate_identity', {
    device_id: 'bob_wasm_dev',
    spk_id: 1,
    otpk_count: 2,
  });
  assert.equal(bobGen.ok, true, `Bob e2ee_generate_identity failed: ${JSON.stringify(bobGen)}`);

  const alice = normalizeIdentity(aliceGen.data);
  const bob = normalizeIdentity(bobGen.data);

  assert.ok(alice.ikPub.length >= 32, 'Expected non-empty Alice identity public key');
  assert.ok(alice.ikSec.length >= 32, 'Expected non-empty Alice identity secret key');
  assert.ok(bob.ikPub.length >= 32, 'Expected non-empty Bob identity public key');
  assert.ok(bob.iskPub.length >= 32, 'Expected non-empty Bob signing public key');
  assert.ok(bob.spkPub.length >= 32, 'Expected non-empty Bob signed prekey public key');
  assert.ok(bob.spkSec.length >= 32, 'Expected non-empty Bob signed prekey secret key');
  assert.ok(bob.spkSig.length >= 64, 'Expected non-empty Bob Ed25519 signed prekey signature');

  const bobBundle = {
    user_id: 200002,
    device_id: 'bob_wasm_dev',
    device_name: 'Bob MV3 Extension',
    identity_key: bob.ikPub,
    identity_signing_key: bob.iskPub,
    signed_prekey: {
      key_id: bob.spkId,
      public_key: bob.spkPub,
      signature: bob.spkSig,
      created_at_ms: bob.spkCreatedAtMs,
    },
    ...(bob.otpkPub && bob.otpkSec
      ? {
          one_time_prekey: {
            key_id: bob.otpkId ?? 100,
            public_key: bob.otpkPub,
          },
        }
      : {}),
  };

  const x3dhInit = await page.invokeWasm('e2ee_x3dh_initiator', {
    ik_a_sec: alice.ikSec,
    identity_secret: alice.ikSec,
    alice_identity_secret: alice.ikSec,
    ik_a_pub: alice.ikPub,
    identity_key: alice.ikPub,
    bundle: bobBundle,
    peer_bundle: bobBundle,
  });
  assert.equal(x3dhInit.ok, true, `e2ee_x3dh_initiator failed: ${JSON.stringify(x3dhInit)}`);

  const ekAPub = String(
    x3dhInit.data.ephemeral_pub ??
      x3dhInit.data.ephemeral_public_key ??
      x3dhInit.data.ek_a_pub ??
      x3dhInit.data.ek_pub ??
      '',
  );
  assert.ok(ekAPub.length >= 32, `Expected ephemeral public key from X3DH initiator: ${JSON.stringify(x3dhInit.data)}`);

  const x3dhResp = await page.invokeWasm('e2ee_x3dh_responder', {
    ik_b_sec: bob.ikSec,
    identity_secret: bob.ikSec,
    bob_identity_secret: bob.ikSec,
    ik_b_pub: bob.ikPub,
    spk_b_sec: bob.spkSec,
    signed_prekey_secret: bob.spkSec,
    ...(bob.otpkSec
      ? {
          opk_b_sec: bob.otpkSec,
          otpk_b_sec: bob.otpkSec,
          one_time_prekey_secret: bob.otpkSec,
        }
      : {}),
    ik_a_pub: alice.ikPub,
    peer_identity_key: alice.ikPub,
    alice_identity_key: alice.ikPub,
    ek_a_pub: ekAPub,
    ephemeral_pub: ekAPub,
    ephemeral_public_key: ekAPub,
  });
  assert.equal(x3dhResp.ok, true, `e2ee_x3dh_responder failed: ${JSON.stringify(x3dhResp)}`);

  const aliceSecret = String(
    x3dhInit.data.shared_secret ??
      x3dhInit.data.shared_secret_b64 ??
      x3dhInit.data.shared_secret_hex ??
      '',
  );
  const bobSecret = String(
    x3dhResp.data.shared_secret ??
      x3dhResp.data.shared_secret_b64 ??
      x3dhResp.data.shared_secret_hex ??
      '',
  );
  assert.ok(aliceSecret.length >= 40, `Expected 32-byte encoded shared secret, got "${aliceSecret}"`);
  assert.equal(aliceSecret, bobSecret, 'Alice and Bob must derive identical 32-byte X3DH shared secret');

  const associatedData =
    x3dhInit.data.associated_data ?? x3dhResp.data.associated_data ?? undefined;

  return {
    alice,
    bob,
    sharedSecret: aliceSecret,
    associatedData,
  };
}

defineTest({
  id: 'T1-F02-01',
  title: 'Instantiate gpui_telegram_ext_wasm in MV3 page and verify C-ABI exports + PTS contiguity/gap drain',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const wasmInfo = await page.inspectWasm();
      assert.equal(wasmInfo.exportTypes.wasm_alloc, 'function', 'Missing wasm_alloc export');
      assert.equal(wasmInfo.exportTypes.wasm_dealloc, 'function', 'Missing wasm_dealloc export');
      assert.equal(
        wasmInfo.exportTypes.wasm_invoke_json,
        'function',
        'Missing wasm_invoke_json export',
      );
      assert.ok(wasmInfo.memoryByteLength >= 65536, 'Expected valid WASM linear memory');

      const chatId = 920101;
      const makePtsUpdate = (pts: number) => ({
        chat_id: chatId,
        pts,
        pts_count: 1,
        timestamp_ms: 1763399000000 + pts,
        event: {
          type: 'ReadHistory',
          data: { chat_id: chatId, max_id: pts, user_id: 100001 },
        },
      });

      // 1. Seed / evaluate contiguous update: local_pts = 10 -> incoming pts = 11 (pts_count = 1)
      const eval11 = await page.invokeWasm('pts_eval', {
        local_pts: 10,
        current_pts: 10,
        ...makePtsUpdate(11),
        update: makePtsUpdate(11),
      });
      assert.equal(eval11.ok, true, `pts_eval(11) failed: ${JSON.stringify(eval11)}`);
      assert.match(
        JSON.stringify(eval11.data),
        /contiguous|apply|ok/i,
        `Expected Contiguous outcome for pts 10 -> 11, got ${JSON.stringify(eval11.data)}`,
      );

      // 2. Evaluate gap update: local_pts = 11 -> incoming pts = 14 (missing 12, 13)
      const eval14 = await page.invokeWasm('pts_eval', {
        local_pts: 11,
        current_pts: 11,
        ...makePtsUpdate(14),
        update: makePtsUpdate(14),
      });
      assert.equal(eval14.ok, true, `pts_eval(14) failed: ${JSON.stringify(eval14)}`);
      assert.match(
        JSON.stringify(eval14.data),
        /gap/i,
        `Expected GapDetected outcome for pts 11 -> 14, got ${JSON.stringify(eval14.data)}`,
      );

      // 3. Buffer out-of-order updates [13, 14, 12]
      for (const pts of [13, 14, 12]) {
        const bufRes = await page.invokeWasm('pts_buffer_gap', {
          local_pts: 11,
          current_pts: 11,
          ...makePtsUpdate(pts),
          update: makePtsUpdate(pts),
        });
        assert.equal(bufRes.ok, true, `pts_buffer_gap(${pts}) failed: ${JSON.stringify(bufRes)}`);
      }

      // 4. Drain contiguous sequence starting after pts = 11 -> must yield ordered [12, 13, 14]
      const drainRes = await page.invokeWasm('pts_drain_contiguous', {
        chat_id: chatId,
        local_pts: 11,
        current_pts: 11,
      });
      assert.equal(drainRes.ok, true, `pts_drain_contiguous failed: ${JSON.stringify(drainRes)}`);

      const rawItems: any[] = Array.isArray(drainRes.data)
        ? drainRes.data
        : drainRes.data?.updates ?? drainRes.data?.drained ?? drainRes.data?.items ?? [];
      const drainedPts = rawItems.map((item) => (typeof item === 'number' ? item : Number(item?.pts)));
      assert.deepEqual(
        drainedPts,
        [12, 13, 14],
        `Expected drained contiguous PTS sequence [12, 13, 14], got ${JSON.stringify(drainedPts)} (raw=${JSON.stringify(drainRes.data)})`,
      );
    });
  },
});

defineTest({
  id: 'T1-F02-02',
  title: 'Validate WsClientFrame::Ping, WsServerFrame::Pong, and WsServerFrame::PtsPush via WASM validate_ws_frame',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const pingFrame = { type: 'Ping', payload: { nonce: 42 } };
      const pingRes = await page.invokeWasm('validate_ws_frame', {
        direction: 'client',
        kind: 'client',
        raw: JSON.stringify(pingFrame),
        frame: pingFrame,
      });
      assert.equal(pingRes.ok, true, `validate_ws_frame(Ping) failed: ${JSON.stringify(pingRes)}`);
      assert.notEqual(pingRes.data?.valid, false);
      assert.match(JSON.stringify(pingRes.data), /ping/i);

      const pongFrame = { type: 'Pong', payload: { nonce: 42 } };
      const pongRes = await page.invokeWasm('validate_ws_frame', {
        direction: 'server',
        kind: 'server',
        raw: JSON.stringify(pongFrame),
        frame: pongFrame,
      });
      assert.equal(pongRes.ok, true, `validate_ws_frame(Pong) failed: ${JSON.stringify(pongRes)}`);
      assert.notEqual(pongRes.data?.valid, false);
      assert.match(JSON.stringify(pongRes.data), /pong/i);

      const ptsPushFrame = {
        type: 'PtsPush',
        payload: {
          chat_id: 700100001,
          pts: 9,
          pts_count: 1,
          timestamp_ms: 1763399000123,
          event: {
            type: 'ReadHistory',
            data: { chat_id: 700100001, max_id: 9, user_id: 100001 },
          },
        },
      };
      const pushRes = await page.invokeWasm('validate_ws_frame', {
        direction: 'server',
        kind: 'server',
        raw: JSON.stringify(ptsPushFrame),
        frame: ptsPushFrame,
      });
      assert.equal(pushRes.ok, true, `validate_ws_frame(PtsPush) failed: ${JSON.stringify(pushRes)}`);
      assert.notEqual(pushRes.data?.valid, false);
      assert.match(JSON.stringify(pushRes.data), /ptspush|pts_push/i);
    });
  },
});

defineTest({
  id: 'T1-F02-03',
  title: 'Derive matching X3DH shared secrets and commutative safety_number_emojis in gpui_telegram_ext_wasm',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const { alice, bob } = await performX3dhHandshakeInWasm(page);

      const safetyAB = await page.invokeWasm('safety_number_emojis', {
        local_ik: alice.ikPub,
        remote_ik: bob.ikPub,
        local_identity_key: alice.ikPub,
        remote_identity_key: bob.ikPub,
        ik_a: alice.ikPub,
        ik_b: bob.ikPub,
      });
      const safetyBA = await page.invokeWasm('safety_number_emojis', {
        local_ik: bob.ikPub,
        remote_ik: alice.ikPub,
        local_identity_key: bob.ikPub,
        remote_identity_key: alice.ikPub,
        ik_a: bob.ikPub,
        ik_b: alice.ikPub,
      });

      assert.equal(safetyAB.ok, true, `safety_number_emojis(A,B) failed: ${JSON.stringify(safetyAB)}`);
      assert.equal(safetyBA.ok, true, `safety_number_emojis(B,A) failed: ${JSON.stringify(safetyBA)}`);

      const emojisAB = safetyAB.data?.emojis ?? safetyAB.data;
      const emojisBA = safetyBA.data?.emojis ?? safetyBA.data;
      const strAB = Array.isArray(emojisAB) ? emojisAB.join('') : String(emojisAB ?? '');
      const strBA = Array.isArray(emojisBA) ? emojisBA.join('') : String(emojisBA ?? '');

      assert.ok(strAB.length > 0, 'Expected non-empty safety number emoji fingerprint');
      assert.equal(
        strAB,
        strBA,
        `safety_number_emojis must be commutative: A->B "${strAB}" !== B->A "${strBA}"`,
      );

      // Distinct third identity must yield a distinct safety fingerprint
      const charlieGen = await page.invokeWasm('e2ee_generate_identity', {
        device_id: 'charlie_wasm_dev',
        spk_id: 1,
        otpk_count: 1,
      });
      assert.equal(charlieGen.ok, true);
      const charlie = normalizeIdentity(charlieGen.data);
      const safetyAC = await page.invokeWasm('safety_number_emojis', {
        local_ik: alice.ikPub,
        remote_ik: charlie.ikPub,
        local_identity_key: alice.ikPub,
        remote_identity_key: charlie.ikPub,
        ik_a: alice.ikPub,
        ik_b: charlie.ikPub,
      });
      assert.equal(safetyAC.ok, true);
      const emojisAC = safetyAC.data?.emojis ?? safetyAC.data;
      const strAC = Array.isArray(emojisAC) ? emojisAC.join('') : String(emojisAC ?? '');
      assert.notEqual(strAB, strAC, 'Distinct peer identity key must produce different safety emojis');
    });
  },
});

defineTest({
  id: 'T1-F02-04',
  title: 'Encrypt and decrypt bidirectional UTF-8 messages with forward secrecy via WASM Double Ratchet',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const { bob, sharedSecret, associatedData } = await performX3dhHandshakeInWasm(page);

      const aliceInit = await page.invokeWasm('e2ee_ratchet_init', {
        role: 'alice',
        is_initiator: true,
        shared_secret: sharedSecret,
        remote_dh_pub: bob.spkPub,
        bob_dh_pub: bob.spkPub,
        ...(associatedData ? { associated_data: associatedData } : {}),
      });
      assert.equal(aliceInit.ok, true, `Alice e2ee_ratchet_init failed: ${JSON.stringify(aliceInit)}`);

      const bobInit = await page.invokeWasm('e2ee_ratchet_init', {
        role: 'bob',
        is_initiator: false,
        shared_secret: sharedSecret,
        self_dh_sec: bob.spkSec,
        bob_dh_sec: bob.spkSec,
        self_dh_pub: bob.spkPub,
        bob_dh_pub: bob.spkPub,
        ...(associatedData ? { associated_data: associatedData } : {}),
      });
      assert.equal(bobInit.ok, true, `Bob e2ee_ratchet_init failed: ${JSON.stringify(bobInit)}`);

      let aliceSession = aliceInit.data?.session ?? aliceInit.data?.state ?? aliceInit.data;
      let bobSession = bobInit.data?.session ?? bobInit.data?.state ?? bobInit.data;

      const decodePlaintext = (decData: any): string => {
        if (typeof decData?.plaintext === 'string') return decData.plaintext;
        if (typeof decData?.text === 'string') return decData.text;
        if (typeof decData?.plaintext_b64 === 'string') {
          return Buffer.from(decData.plaintext_b64, 'base64').toString('utf-8');
        }
        return String(decData ?? '');
      };

      // Turn 1: Alice -> Bob ("Hello MV3 WASM")
      const msg1 = 'Hello MV3 WASM';
      const enc1 = await page.invokeWasm('e2ee_ratchet_encrypt', {
        session: aliceSession,
        plaintext: msg1,
      });
      assert.equal(enc1.ok, true, `enc1 failed: ${JSON.stringify(enc1)}`);
      aliceSession = enc1.data.session ?? enc1.data.state ?? aliceSession;
      const ct1 = String(enc1.data.ciphertext ?? enc1.data.ciphertext_b64 ?? '');
      assert.ok(ct1.length > 0 && !ct1.includes(msg1), 'Ciphertext 1 must not expose plaintext');

      const dec1 = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: bobSession,
        header: enc1.data.header,
        ciphertext: ct1,
        envelope: enc1.data,
      });
      assert.equal(dec1.ok, true, `dec1 failed: ${JSON.stringify(dec1)}`);
      bobSession = dec1.data.session ?? dec1.data.state ?? bobSession;
      assert.equal(decodePlaintext(dec1.data), msg1);

      // Turn 2: Bob -> Alice ("中文加密测试")
      const msg2 = '中文加密测试';
      const enc2 = await page.invokeWasm('e2ee_ratchet_encrypt', {
        session: bobSession,
        plaintext: msg2,
      });
      assert.equal(enc2.ok, true, `enc2 failed: ${JSON.stringify(enc2)}`);
      bobSession = enc2.data.session ?? enc2.data.state ?? bobSession;
      const ct2 = String(enc2.data.ciphertext ?? enc2.data.ciphertext_b64 ?? '');
      assert.ok(ct2.length > 0 && !ct2.includes(msg2));

      const dec2 = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: aliceSession,
        header: enc2.data.header,
        ciphertext: ct2,
        envelope: enc2.data,
      });
      assert.equal(dec2.ok, true, `dec2 failed: ${JSON.stringify(dec2)}`);
      aliceSession = dec2.data.session ?? dec2.data.state ?? aliceSession;
      assert.equal(decodePlaintext(dec2.data), msg2);

      // Turn 3: Alice -> Bob with identical plaintext as Turn 1 ("Hello MV3 WASM") -> must produce new ciphertext!
      const enc3 = await page.invokeWasm('e2ee_ratchet_encrypt', {
        session: aliceSession,
        plaintext: msg1,
      });
      assert.equal(enc3.ok, true, `enc3 failed: ${JSON.stringify(enc3)}`);
      const ct3 = String(enc3.data.ciphertext ?? enc3.data.ciphertext_b64 ?? '');
      assert.notEqual(
        ct3,
        ct1,
        'Double Ratchet must advance keys so identical plaintexts produce distinct ciphertexts',
      );

      const dec3 = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: bobSession,
        header: enc3.data.header,
        ciphertext: ct3,
        envelope: enc3.data,
      });
      assert.equal(dec3.ok, true, `dec3 failed: ${JSON.stringify(dec3)}`);
      assert.equal(decodePlaintext(dec3.data), msg1);
    });
  },
});

defineTest({
  id: 'T1-F02-05',
  title: 'Encode 100 5-bit voice waveform bars into exact 63 bytes and losslessly decode in WASM',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const inputBars = Array.from({ length: 100 }, (_, i) => (i * 7 + 5) % 32);

      const encRes = await page.invokeWasm('waveform_encode_5bit', {
        bars: inputBars,
        samples: inputBars,
        values: inputBars,
      });
      assert.equal(encRes.ok, true, `waveform_encode_5bit failed: ${JSON.stringify(encRes)}`);

      let packedBytes: Buffer;
      const b64Field =
        encRes.data?.encoded_b64 ??
        encRes.data?.data_base64 ??
        encRes.data?.waveform_b64 ??
        encRes.data?.b64 ??
        (typeof encRes.data === 'string' ? encRes.data : undefined);

      if (typeof b64Field === 'string' && b64Field.length > 0) {
        packedBytes = Buffer.from(b64Field, 'base64');
      } else if (Array.isArray(encRes.data?.bytes ?? encRes.data?.encoded ?? encRes.data)) {
        const arr = encRes.data?.bytes ?? encRes.data?.encoded ?? encRes.data;
        packedBytes = Buffer.from(arr);
      } else {
        assert.fail(`Unexpected waveform_encode_5bit output shape: ${JSON.stringify(encRes.data)}`);
      }

      assert.equal(
        packedBytes.byteLength,
        63,
        `Expected ceil(100 * 5 / 8) === 63 packed bytes, got ${packedBytes.byteLength}`,
      );

      const decRes = await page.invokeWasm('waveform_decode_5bit', {
        encoded_b64: packedBytes.toString('base64'),
        waveform_b64: packedBytes.toString('base64'),
        b64: packedBytes.toString('base64'),
        bytes: Array.from(packedBytes),
        encoded: Array.from(packedBytes),
        count: 100,
        bar_count: 100,
      });
      assert.equal(decRes.ok, true, `waveform_decode_5bit failed: ${JSON.stringify(decRes)}`);

      const decodedBars: number[] = Array.isArray(decRes.data)
        ? decRes.data
        : decRes.data?.bars ?? decRes.data?.samples ?? decRes.data?.values ?? [];
      assert.equal(decodedBars.length, 100, `Expected 100 decoded bars, got ${decodedBars.length}`);
      assert.deepEqual(
        decodedBars,
        inputBars,
        'waveform_decode_5bit must losslessly recover all 100 5-bit bars (0..31)',
      );
    });
  },
});

defineTest({
  id: 'T1-F02-06',
  title: 'Convert HTML to clean Markdown stripping scripts and verify benign scan_content_for_injection in WASM',
  tier: 1,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const sampleHtml = [
        '<html><head><title>Guide</title><style>.secret{display:none}</style></head>',
        '<body>',
        '<h1>Title</h1>',
        '<p>Read <a href="https://example.com">Docs</a> &amp; <strong>bold</strong></p>',
        '<script>alert(1)</script>',
        '</body></html>',
      ].join('');

      const mdRes = await page.invokeWasm('html_to_markdown', {
        html: sampleHtml,
        include_links: true,
      });
      assert.equal(mdRes.ok, true, `html_to_markdown failed: ${JSON.stringify(mdRes)}`);

      const markdown =
        typeof mdRes.data === 'string' ? mdRes.data : String(mdRes.data?.markdown ?? '');
      assert.ok(markdown.includes('Title'), `Expected heading "Title" in markdown: ${markdown}`);
      assert.ok(
        markdown.includes('[Docs](https://example.com)') || markdown.includes('https://example.com'),
        `Expected preserved Docs link in markdown: ${markdown}`,
      );
      assert.ok(
        markdown.includes('**bold**') || markdown.includes('bold'),
        `Expected bold text in markdown: ${markdown}`,
      );
      assert.ok(
        !markdown.includes('alert(1)') && !markdown.includes('<script'),
        `html_to_markdown must strip <script> blocks, got: ${markdown}`,
      );

      const scanRes = await page.invokeWasm('scan_content_for_injection', {
        text: 'Rust async channels tutorial: prefer bounded mpsc channels for backpressure.',
        content: 'Rust async channels tutorial: prefer bounded mpsc channels for backpressure.',
      });
      assert.equal(
        scanRes.ok,
        true,
        `scan_content_for_injection failed: ${JSON.stringify(scanRes)}`,
      );
      assert.equal(
        scanRes.data?.flagged,
        false,
        `Benign article should have flagged === false, got ${JSON.stringify(scanRes.data)}`,
      );
      assert.equal(
        String(scanRes.data?.severity ?? 'none').toLowerCase(),
        'none',
        `Expected severity "none" on benign text, got ${JSON.stringify(scanRes.data?.severity)}`,
      );
      assert.ok(
        Array.isArray(scanRes.data?.findings) && scanRes.data.findings.length === 0,
        `Expected empty findings array on benign text, got ${JSON.stringify(scanRes.data?.findings)}`,
      );
    });
  },
});
