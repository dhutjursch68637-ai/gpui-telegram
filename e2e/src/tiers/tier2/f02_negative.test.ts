import {
  assert,
  defineTest,
  type SharedTierContext,
} from '../../harness/index.ts';

function flipBase64Byte(b64: string, byteIndex = 0, xorMask = 0xff): string {
  const buf = Buffer.from(b64, 'base64');
  assert.ok(buf.length > byteIndex, `Base64 payload too short to flip byte ${byteIndex}`);
  buf[byteIndex] ^= xorMask;
  return buf.toString('base64');
}

function classifyPtsOutcome(resData: any): 'contiguous' | 'duplicate' | 'gap' | 'unknown' {
  const raw =
    typeof resData === 'string'
      ? resData
      : String(
          resData?.outcome ??
            resData?.status ??
            resData?.kind ??
            resData?.type ??
            JSON.stringify(resData ?? ''),
        );
  const lower = raw.toLowerCase();
  if (lower.includes('dup') || lower.includes('already') || lower.includes('stale') || lower.includes('ignore')) {
    return 'duplicate';
  }
  if (lower.includes('gap') || lower.includes('missing')) {
    return 'gap';
  }
  if (lower.includes('contiguous') || lower.includes('apply') || lower.includes('applied')) {
    return 'contiguous';
  }
  return 'unknown';
}

function extractDrainedPtsNumbers(resData: any): number[] {
  const arr: any[] = Array.isArray(resData)
    ? resData
    : Array.isArray(resData?.updates)
      ? resData.updates
      : Array.isArray(resData?.drained)
        ? resData.drained
        : Array.isArray(resData?.items)
          ? resData.items
          : [];
  return arr.map((item) =>
    typeof item === 'number' ? item : Number(item?.pts ?? item?.update?.pts ?? NaN),
  );
}

defineTest({
  id: 'T2-F02-01',
  title: 'Return { ok: false, error } without WASM unreachable trap on invalid UTF-8, truncated JSON, and unknown op in wasm_invoke_json',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const inspected = await page.inspectWasm();
      assert.ok(inspected.exports.includes('wasm_alloc'), 'Missing wasm_alloc export');
      assert.ok(inspected.exports.includes('wasm_dealloc'), 'Missing wasm_dealloc export');
      assert.ok(inspected.exports.includes('wasm_invoke_json'), 'Missing wasm_invoke_json export');

      // 1. Invalid UTF-8 bytes
      const invalidUtf8Res = await page.invokeWasmRaw([0xff, 0xfe, 0xfd, 0x80, 0xc3, 0x28]);
      assert.equal(invalidUtf8Res.ok, false, 'Invalid UTF-8 bytes must return ok: false');
      assert.ok(
        typeof invalidUtf8Res.error === 'string' && invalidUtf8Res.error.length > 0,
        'Invalid UTF-8 response must include error description',
      );

      // 2. Truncated JSON bytes ("{\"op\":")
      const truncatedJsonRes = await page.invokeWasmRaw('{"op":');
      assert.equal(truncatedJsonRes.ok, false, 'Truncated JSON must return ok: false');
      assert.ok(
        typeof truncatedJsonRes.error === 'string' && truncatedJsonRes.error.length > 0,
        'Truncated JSON response must include error description',
      );

      // 3. Empty 0-byte slice
      const emptySliceRes = await page.invokeWasmRaw([]);
      assert.equal(emptySliceRes.ok, false, 'Empty byte slice must return ok: false');
      assert.ok(typeof emptySliceRes.error === 'string' && emptySliceRes.error.length > 0);

      // 4. Unknown op name
      const unknownOpRes = await page.invokeWasm('nonexistent_wasm_op', { probe: 1 });
      assert.equal(unknownOpRes.ok, false, 'Unknown WASM op must return ok: false');
      assert.ok(
        typeof unknownOpRes.error === 'string' && unknownOpRes.error.length > 0,
        'Unknown op must return structured error string',
      );

      // 5. Verify zero WASM unreachable trap and healthy subsequent execution
      const traps = page.pageExceptions.filter((e) =>
        /RuntimeError|unreachable/i.test(`${e.text} ${e.description ?? ''}`),
      );
      assert.equal(traps.length, 0, `WASM must never trap with unreachable: ${JSON.stringify(traps)}`);

      const healthyFollowup = await page.invokeWasm('html_to_markdown', {
        html: '<h2>Post-Negative WASM Health</h2><p>Still alive.</p>',
      });
      assert.equal(healthyFollowup.ok, true, 'WASM instance must remain healthy after malformed calls');
      const md = String(healthyFollowup.data?.markdown ?? healthyFollowup.data ?? '');
      assert.ok(md.includes('Post-Negative WASM Health'), `Expected converted markdown, got ${md}`);
    });
  },
});

defineTest({
  id: 'T2-F02-02',
  title: 'Reject unknown variant tags, missing PtsPush fields, and negative unsigned IDs in validate_ws_frame',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      // Positive control first to prove validate_ws_frame genuinely accepts valid frames
      const validPing = JSON.stringify({ type: 'Ping', payload: { nonce: 42 } });
      const posCtrl = await page.invokeWasm('validate_ws_frame', {
        direction: 'client',
        raw: validPing,
        frame: { type: 'Ping', payload: { nonce: 42 } },
      });
      assert.equal(posCtrl.ok, true, `Positive control Ping frame must succeed: ${JSON.stringify(posCtrl)}`);
      if (posCtrl.data && typeof posCtrl.data === 'object' && 'valid' in posCtrl.data) {
        assert.equal(posCtrl.data.valid, true, 'Valid Ping frame must report valid: true');
      }

      const invalidCases = [
        {
          label: 'unknown_variant',
          payload: {
            direction: 'server',
            raw: JSON.stringify({ type: 'unknown_variant', payload: {} }),
            frame: { type: 'unknown_variant', payload: {} },
          },
        },
        {
          label: 'missing_pts_on_PtsPush',
          payload: {
            direction: 'server',
            raw: JSON.stringify({ type: 'PtsPush', payload: { chat_id: 10 } }),
            frame: { type: 'PtsPush', payload: { chat_id: 10 } },
          },
        },
        {
          label: 'negative_unsigned_pts_and_user_id',
          payload: {
            direction: 'server',
            raw: JSON.stringify({
              type: 'PtsPush',
              payload: {
                chat_id: 10,
                pts: -99,
                pts_count: 1,
                timestamp_ms: 1700000000000,
                event: { type: 'UserTyping', data: { chat_id: 10, user_id: -500 } },
              },
            }),
            frame: {
              type: 'PtsPush',
              payload: {
                chat_id: 10,
                pts: -99,
                pts_count: 1,
                timestamp_ms: 1700000000000,
                event: { type: 'UserTyping', data: { chat_id: 10, user_id: -500 } },
              },
            },
          },
        },
        {
          label: 'malformed_json_syntax',
          payload: {
            direction: 'server',
            raw: '{"type":"PtsPush","payload":',
          },
        },
      ];

      for (const tc of invalidCases) {
        const res = await page.invokeWasm('validate_ws_frame', tc.payload);
        const rejected =
          res.ok === false || (res.ok === true && res.data?.valid === false);
        assert.ok(
          rejected,
          `Expected validate_ws_frame to reject ${tc.label}, got ${JSON.stringify(res)}`,
        );
      }

      // Confirm WASM validator remains healthy on valid Pong frame afterward
      const validPong = JSON.stringify({ type: 'Pong', payload: { nonce: 99 } });
      const postCtrl = await page.invokeWasm('validate_ws_frame', {
        direction: 'server',
        raw: validPong,
        frame: { type: 'Pong', payload: { nonce: 99 } },
      });
      assert.equal(postCtrl.ok, true);
    });
  },
});

defineTest({
  id: 'T2-F02-03',
  title: 'Classify duplicate PTS updates (20 and 18 at local_pts=20) and hold multi-gap out-of-order buffer (25, 22, 24) until 21 and 23 arrive',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const chatId = 9_200_203;
      const makeUpdatePayload = (pts: number, localPts: number) => {
        const event = {
          type: 'ReadHistory',
          data: { chat_id: chatId, max_id: pts },
        };
        const update = {
          chat_id: chatId,
          pts,
          pts_count: 1,
          timestamp_ms: 1760000000000 + pts,
          event,
        };
        return {
          chat_id: chatId,
          local_pts: localPts,
          current_pts: localPts,
          pts,
          pts_count: 1,
          timestamp_ms: update.timestamp_ms,
          event,
          update,
        };
      };

      // Advance stateful coordinator cleanly from 1..20 so both stateful and local_pts-parameterized implementations sit at local_pts = 20
      for (let p = 1; p <= 20; p++) {
        const stepRes = await page.invokeWasm('pts_eval', makeUpdatePayload(p, p - 1));
        assert.equal(stepRes.ok, true, `Baseline pts_eval(${p}) failed: ${JSON.stringify(stepRes)}`);
      }

      // 1. Feed duplicate pts=20 and stale pts=18 when local_pts=20
      const dup20 = await page.invokeWasm('pts_eval', makeUpdatePayload(20, 20));
      assert.equal(dup20.ok, true);
      assert.equal(
        classifyPtsOutcome(dup20.data),
        'duplicate',
        `Expected pts=20 at local_pts=20 to be Duplicate, got ${JSON.stringify(dup20.data)}`,
      );

      const dup18 = await page.invokeWasm('pts_eval', makeUpdatePayload(18, 20));
      assert.equal(dup18.ok, true);
      assert.equal(
        classifyPtsOutcome(dup18.data),
        'duplicate',
        `Expected pts=18 at local_pts=20 to be Duplicate, got ${JSON.stringify(dup18.data)}`,
      );

      // 2. Feed out-of-order multi-gap sequence 25, 22, 24 while missing 21 and 23
      for (const gapPts of [25, 22, 24]) {
        const evalGap = await page.invokeWasm('pts_eval', makeUpdatePayload(gapPts, 20));
        assert.equal(evalGap.ok, true);
        assert.equal(
          classifyPtsOutcome(evalGap.data),
          'gap',
          `Expected pts=${gapPts} at local_pts=20 to be GapDetected, got ${JSON.stringify(evalGap.data)}`,
        );
        const bufRes = await page.invokeWasm('pts_buffer_gap', makeUpdatePayload(gapPts, 20));
        assert.equal(bufRes.ok, true, `pts_buffer_gap(${gapPts}) failed: ${JSON.stringify(bufRes)}`);
      }

      // Drain at local_pts=20 while 21 is still missing -> must drain []
      const drainBefore21 = await page.invokeWasm('pts_drain_contiguous', {
        chat_id: chatId,
        local_pts: 20,
        current_pts: 20,
      });
      assert.equal(drainBefore21.ok, true);
      assert.deepEqual(
        extractDrainedPtsNumbers(drainBefore21.data),
        [],
        `Must not drain buffered [22,24,25] while 21 is missing: ${JSON.stringify(drainBefore21.data)}`,
      );

      // 3. Deliver missing 21: buffer 21 and/or evaluate 21, then drain -> must yield [21, 22] (or [22] after 21 applied) and hold 24, 25!
      await page.invokeWasm('pts_buffer_gap', makeUpdatePayload(21, 20));
      const drainAt20With21 = await page.invokeWasm('pts_drain_contiguous', {
        chat_id: chatId,
        local_pts: 20,
        current_pts: 20,
      });
      assert.equal(drainAt20With21.ok, true);
      let firstWave = extractDrainedPtsNumbers(drainAt20With21.data);
      if (firstWave.length === 0) {
        // Stateful coordinator advances via pts_eval(21) first, then drains from 21
        const eval21 = await page.invokeWasm('pts_eval', makeUpdatePayload(21, 20));
        assert.equal(eval21.ok, true);
        const drainAfterEval21 = await page.invokeWasm('pts_drain_contiguous', {
          chat_id: chatId,
          local_pts: 21,
          current_pts: 21,
        });
        assert.equal(drainAfterEval21.ok, true);
        firstWave = [21, ...extractDrainedPtsNumbers(drainAfterEval21.data)];
      }
      assert.deepEqual(
        firstWave,
        [21, 22],
        `Expected contiguous drain through 22 while holding 24,25 (missing 23), got ${JSON.stringify(firstWave)}`,
      );

      // 4. Deliver missing 23 -> must drain remaining [23, 24, 25] in strict ascending order
      await page.invokeWasm('pts_buffer_gap', makeUpdatePayload(23, 22));
      const drainAt22With23 = await page.invokeWasm('pts_drain_contiguous', {
        chat_id: chatId,
        local_pts: 22,
        current_pts: 22,
      });
      assert.equal(drainAt22With23.ok, true);
      let secondWave = extractDrainedPtsNumbers(drainAt22With23.data);
      if (secondWave.length === 0) {
        const eval23 = await page.invokeWasm('pts_eval', makeUpdatePayload(23, 22));
        assert.equal(eval23.ok, true);
        const drainAfterEval23 = await page.invokeWasm('pts_drain_contiguous', {
          chat_id: chatId,
          local_pts: 23,
          current_pts: 23,
        });
        assert.equal(drainAfterEval23.ok, true);
        secondWave = [23, ...extractDrainedPtsNumbers(drainAfterEval23.data)];
      }
      assert.deepEqual(
        secondWave,
        [23, 24, 25],
        `Expected ordered drain [23, 24, 25] once 23 arrived, got ${JSON.stringify(secondWave)}`,
      );
    });
  },
});

defineTest({
  id: 'T2-F02-04',
  title: 'Reject 1-bit flipped Double Ratchet ciphertext, replayed ratchet header/ciphertext, and tampered X3DH prekey signature without poisoning session',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      const aliceSeed = Buffer.alloc(32, 0x11).toString('base64');
      const bobSeed = Buffer.alloc(32, 0x22).toString('base64');

      const aliceIdRes = await page.invokeWasm('e2ee_generate_identity', {
        seed: aliceSeed,
        spk_id: 1,
        otpk_count: 2,
        device_id: 'alice-dev',
      });
      const bobIdRes = await page.invokeWasm('e2ee_generate_identity', {
        seed: bobSeed,
        spk_id: 1,
        otpk_count: 2,
        device_id: 'bob-dev',
      });
      assert.equal(aliceIdRes.ok, true, `alice identity gen failed: ${JSON.stringify(aliceIdRes)}`);
      assert.equal(bobIdRes.ok, true, `bob identity gen failed: ${JSON.stringify(bobIdRes)}`);

      const aliceKeys = aliceIdRes.data;
      const bobKeys = bobIdRes.data;

      const aliceIkSec = aliceKeys.identity_secret ?? aliceKeys.x25519_sec ?? aliceKeys.ik_sec;
      const aliceIkPub = aliceKeys.identity_key ?? aliceKeys.x25519_pub ?? aliceKeys.ik_pub;
      const bobIkSec = bobKeys.identity_secret ?? bobKeys.x25519_sec ?? bobKeys.ik_sec;
      const bobIkPub = bobKeys.identity_key ?? bobKeys.x25519_pub ?? bobKeys.ik_pub;
      const bobIskPub = bobKeys.identity_signing_key ?? bobKeys.ed25519_pub;
      const bobSpk = bobKeys.signed_prekey;
      const bobSpkSec =
        bobSpk?.secret_key ?? bobSpk?.private_key ?? bobKeys.signed_prekey_secret ?? bobKeys.spk_sec;
      const bobSpkPub = bobSpk?.public_key ?? bobKeys.spk_pub;
      const bobSpkSig = bobSpk?.signature;

      assert.ok(aliceIkSec && bobIkPub && bobIskPub && bobSpkPub && bobSpkSig, 'Expected canonical identity & SPK fields');

      const validBundle = {
        device_id: 'bob-dev',
        identity_key: bobIkPub,
        identity_signing_key: bobIskPub,
        signed_prekey: {
          key_id: bobSpk.key_id ?? 1,
          public_key: bobSpkPub,
          signature: bobSpkSig,
          created_at_ms: bobSpk.created_at_ms ?? 1760000000000,
        },
        one_time_prekey: null,
      };

      // 1. Tamper Ed25519 signature on Bob's SignedPreKey -> e2ee_x3dh_initiator MUST reject with ok: false
      const tamperedBundle = {
        ...validBundle,
        signed_prekey: {
          ...validBundle.signed_prekey,
          signature: flipBase64Byte(bobSpkSig, 4, 0xff),
        },
      };
      const badX3dh = await page.invokeWasm('e2ee_x3dh_initiator', {
        ik_a_sec: aliceIkSec,
        identity_secret: aliceIkSec,
        bundle: tamperedBundle,
      });
      assert.equal(
        badX3dh.ok,
        false,
        `Tampered SPK Ed25519 signature must fail X3DH verification: ${JSON.stringify(badX3dh)}`,
      );

      // 2. Establish valid X3DH + Double Ratchet session
      const ekSeed = Buffer.alloc(32, 0x33).toString('base64');
      const okX3dhInit = await page.invokeWasm('e2ee_x3dh_initiator', {
        ik_a_sec: aliceIkSec,
        identity_secret: aliceIkSec,
        ek_a_sec: ekSeed,
        bundle: validBundle,
      });
      assert.equal(okX3dhInit.ok, true, `Valid X3DH initiator failed: ${JSON.stringify(okX3dhInit)}`);

      const sharedSecret = okX3dhInit.data.shared_secret;
      const associatedData = okX3dhInit.data.associated_data;
      const ekPub = okX3dhInit.data.ephemeral_pub ?? okX3dhInit.data.ek_a_pub;

      if (bobSpkSec && ekPub && aliceIkPub) {
        const okX3dhResp = await page.invokeWasm('e2ee_x3dh_responder', {
          ik_b_sec: bobIkSec,
          spk_b_sec: bobSpkSec,
          ik_a_pub: aliceIkPub,
          ek_a_pub: ekPub,
        });
        assert.equal(okX3dhResp.ok, true, `Valid X3DH responder failed: ${JSON.stringify(okX3dhResp)}`);
        assert.equal(okX3dhResp.data.shared_secret, sharedSecret, 'X3DH shared secrets must match');
      }

      const aliceRatchetInit = await page.invokeWasm('e2ee_ratchet_init', {
        role: 'alice',
        shared_secret: sharedSecret,
        remote_dh_pub: bobSpkPub,
        bob_dh_pub: bobSpkPub,
        associated_data: associatedData,
      });
      const bobRatchetInit = await page.invokeWasm('e2ee_ratchet_init', {
        role: 'bob',
        shared_secret: sharedSecret,
        self_dh_sec: bobSpkSec,
        bob_dh_sec: bobSpkSec,
        associated_data: associatedData,
      });
      assert.equal(aliceRatchetInit.ok, true, `Alice ratchet init failed: ${JSON.stringify(aliceRatchetInit)}`);
      assert.equal(bobRatchetInit.ok, true, `Bob ratchet init failed: ${JSON.stringify(bobRatchetInit)}`);

      const secretPlaintext = 'CONFIDENTIAL_LAUNCH_TOKEN_987654';
      const enc1 = await page.invokeWasm('e2ee_ratchet_encrypt', {
        session: aliceRatchetInit.data.session,
        plaintext: secretPlaintext,
      });
      assert.equal(enc1.ok, true, `Ratchet encrypt #1 failed: ${JSON.stringify(enc1)}`);

      // 3. Flip 1 bit in Double Ratchet ciphertext -> AEAD authentication failure (ok: false, zero plaintext leak)
      const flippedCiphertext = flipBase64Byte(enc1.data.ciphertext, 0, 0x01);
      const tamperedDec = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: bobRatchetInit.data.session,
        header: enc1.data.header,
        ciphertext: flippedCiphertext,
      });
      assert.equal(tamperedDec.ok, false, '1-bit flipped ciphertext must fail AEAD decryption');
      assert.ok(
        !JSON.stringify(tamperedDec).includes('CONFIDENTIAL_LAUNCH_TOKEN'),
        'Failed decrypt must never leak plaintext',
      );

      // 4. Untouched ciphertext decrypts cleanly (proving failed decrypt did not corrupt session state)
      const validDec1 = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: bobRatchetInit.data.session,
        header: enc1.data.header,
        ciphertext: enc1.data.ciphertext,
      });
      assert.equal(validDec1.ok, true, `Valid decrypt after tamper attempt failed: ${JSON.stringify(validDec1)}`);
      assert.equal(validDec1.data.plaintext, secretPlaintext);

      // 5. Replay exact same header + ciphertext against advanced bobSession -> MUST fail with ok: false
      const replayDec = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: validDec1.data.session,
        header: enc1.data.header,
        ciphertext: enc1.data.ciphertext,
      });
      assert.equal(
        replayDec.ok,
        false,
        `Replayed Double Ratchet message must be rejected: ${JSON.stringify(replayDec)}`,
      );

      // 6. Verify subsequent message #2 still decrypts cleanly after replay rejection
      const enc2 = await page.invokeWasm('e2ee_ratchet_encrypt', {
        session: enc1.data.session,
        plaintext: 'Ratchet healthy on message #2',
      });
      assert.equal(enc2.ok, true);
      const validDec2 = await page.invokeWasm('e2ee_ratchet_decrypt', {
        session: validDec1.data.session,
        header: enc2.data.header,
        ciphertext: enc2.data.ciphertext,
      });
      assert.equal(validDec2.ok, true);
      assert.equal(validDec2.data.plaintext, 'Ratchet healthy on message #2');
    });
  },
});

defineTest({
  id: 'T2-F02-05',
  title: 'Flag indirect prompt injection, zero-width Unicode steganography, and leaked API key from /adversarial/prompt-injection as high severity',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    const fixtureResp = await fetch(`${ctx.fixtureApp.baseUrl}/adversarial/prompt-injection`);
    assert.equal(fixtureResp.status, 200);
    const adversarialHtml = await fixtureResp.text();
    assert.ok(adversarialHtml.includes('Ignore previous instructions'));
    assert.ok(adversarialHtml.includes('\u200B'));
    assert.ok(adversarialHtml.includes('sk-proj-fake1234567890abcdef1234567890abcdef'));

    await ctx.withExtensionSurface('workspace', async (page) => {
      // Scan adversarial fixture content
      const scanRes = await page.invokeWasm('scan_content_for_injection', {
        text: adversarialHtml,
        content: adversarialHtml,
      });
      assert.equal(scanRes.ok, true, `scan_content_for_injection failed: ${JSON.stringify(scanRes)}`);
      const scanData = scanRes.data ?? scanRes;

      assert.equal(scanData.flagged, true, 'Adversarial prompt-injection payload must set flagged: true');
      assert.equal(
        String(scanData.severity ?? '').toLowerCase(),
        'high',
        `Expected severity === "high", got ${JSON.stringify(scanData)}`,
      );
      assert.ok(
        Array.isArray(scanData.findings) && scanData.findings.length >= 1,
        `Expected non-empty findings array, got ${JSON.stringify(scanData.findings)}`,
      );

      // Verify secret / override / unicode marker coverage
      const findingsStr = JSON.stringify(scanData.findings).toLowerCase();
      const hasSecuritySignal =
        (typeof scanData.secrets_detected === 'number' && scanData.secrets_detected >= 1) ||
        /override|ignore|inject|secret|key|unicode|zero.?width|exfil/.test(findingsStr);
      assert.ok(
        hasSecuritySignal,
        `Expected findings/secrets_detected to identify override/secret/zero-width markers: ${JSON.stringify(scanData)}`,
      );

      // Contrast with benign prose control to verify zero false-positive always-true stubbing
      const benignControl = await page.invokeWasm('scan_content_for_injection', {
        text: 'Prefer bounded channels for backpressure and structured task cancellation.',
        content: 'Prefer bounded channels for backpressure and structured task cancellation.',
      });
      assert.equal(benignControl.ok, true);
      const benignData = benignControl.data ?? benignControl;
      assert.equal(benignData.flagged, false, 'Benign technical prose must not be flagged');
    });
  },
});

defineTest({
  id: 'T2-F02-06',
  title: 'Sustain 1,000 wasm_alloc -> wasm_invoke_json -> wasm_dealloc cycles on 64 KB HTML and boundary 500-sample waveforms with stable linear memory',
  tier: 2,
  features: ['F2'],
  fn: async (ctx: SharedTierContext) => {
    await ctx.withExtensionSurface('workspace', async (page) => {
      // 1. Verify empty and oversized (500-sample out-of-range) waveform inputs clamp/normalize safely to 100 5-bit bars (0..31)
      const oversizedSamples = Array.from({ length: 500 }, (_, i) =>
        i % 3 === 0 ? 999 : i % 3 === 1 ? -40 : i % 32,
      );
      const oversizedFloats = oversizedSamples.map((v) => v / 31);

      const overEnc = await page.invokeWasm('waveform_encode_5bit', {
        bars: oversizedSamples,
        samples: oversizedSamples,
        peaks: oversizedFloats,
      });
      assert.equal(overEnc.ok, true, `Oversized waveform encode failed: ${JSON.stringify(overEnc)}`);
      const overDec = await page.invokeWasm('waveform_decode_5bit', {
        ...(overEnc.data?.encoded_b64 ? { encoded_b64: overEnc.data.encoded_b64 } : {}),
        ...(overEnc.data?.bytes ? { bytes: overEnc.data.bytes } : {}),
        count: 100,
      });
      assert.equal(overDec.ok, true, `Oversized waveform decode failed: ${JSON.stringify(overDec)}`);
      const overBars: number[] = overDec.data?.bars ?? overDec.data?.samples ?? overDec.data;
      assert.ok(Array.isArray(overBars) && overBars.length === 100, `Expected 100 normalized bars, got ${overBars?.length}`);
      for (const b of overBars) {
        assert.ok(Number.isInteger(b) && b >= 0 && b <= 31, `Waveform bar out of 5-bit [0..31] range: ${b}`);
      }

      const emptyEnc = await page.invokeWasm('waveform_encode_5bit', {
        bars: [],
        samples: [],
        peaks: [],
      });
      assert.equal(emptyEnc.ok, true, `Empty waveform encode must not panic: ${JSON.stringify(emptyEnc)}`);
      const emptyDec = await page.invokeWasm('waveform_decode_5bit', {
        ...(emptyEnc.data?.encoded_b64 ? { encoded_b64: emptyEnc.data.encoded_b64 } : {}),
        ...(emptyEnc.data?.bytes ? { bytes: emptyEnc.data.bytes } : {}),
        count: 100,
      });
      assert.equal(emptyDec.ok, true);
      const emptyBars: number[] = emptyDec.data?.bars ?? emptyDec.data?.samples ?? emptyDec.data;
      assert.ok(Array.isArray(emptyBars) && emptyBars.length <= 100);
      for (const b of emptyBars) {
        assert.ok(Number.isInteger(b) && b >= 0 && b <= 31);
      }

      // 2. Execute 1,000 consecutive alloc -> invoke -> dealloc cycles in V8 WASM runtime on 64 KB HTML + 500-sample waveforms
      await page.inspectWasm(); // Ensure __gpuiE2eWasmCache__ is initialized in page global scope
      const stressReport = await page.eval(async () => {
        const cacheEntry = (globalThis as any)['__gpuiE2eWasmCache__assets/gpui_telegram_ext_wasm.wasm'];
        if (!cacheEntry || !cacheEntry.exports) {
          throw new Error('WASM cache entry missing');
        }
        const exports = cacheEntry.exports;
        const encoder = new TextEncoder();
        const decoder = new TextDecoder('utf-8', { fatal: true });

        const chunk =
          '<section><h3>Benchmark Block</h3><p>Testing <strong>64KB</strong> allocation &amp; <a href="https://example.com">deallocation</a> safety.</p><script>ignored()</script></section>\n';
        const html64k = '<h1>Memory Stress Document</h1>\n' + chunk.repeat(420); // ~68 KB
        const htmlReqBytes = encoder.encode(
          JSON.stringify({ op: 'html_to_markdown', payload: { html: html64k } }),
        );

        const waveSamples = Array.from({ length: 500 }, (_, idx) => (idx * 7) % 64);
        const waveReqBytes = encoder.encode(
          JSON.stringify({
            op: 'waveform_encode_5bit',
            payload: { bars: waveSamples, samples: waveSamples },
          }),
        );

        function runOne(reqBytes: Uint8Array): any {
          const inPtr = exports.wasm_alloc(reqBytes.byteLength);
          if (!inPtr) throw new Error('wasm_alloc returned 0');
          let packed: bigint;
          try {
            new Uint8Array(exports.memory.buffer, inPtr >>> 0, reqBytes.byteLength).set(reqBytes);
            const ret = exports.wasm_invoke_json(inPtr, reqBytes.byteLength);
            packed = typeof ret === 'bigint' ? ret : BigInt(ret);
          } finally {
            exports.wasm_dealloc(inPtr, reqBytes.byteLength);
          }
          const outPtr = Number((packed >> 32n) & 0xffffffffn);
          const outLen = Number(packed & 0xffffffffn);
          if (!outPtr || outLen === 0) throw new Error('wasm_invoke_json returned empty slice');
          try {
            const outSlice = new Uint8Array(exports.memory.buffer, outPtr >>> 0, outLen);
            return JSON.parse(decoder.decode(outSlice));
          } finally {
            exports.wasm_dealloc(outPtr, outLen);
          }
        }

        // Warm up 10 iterations so initial allocator buckets settle
        for (let w = 0; w < 10; w++) {
          const r = runOne(w % 2 === 0 ? htmlReqBytes : waveReqBytes);
          if (!r.ok) throw new Error('Warmup iteration failed: ' + JSON.stringify(r));
        }

        const bytesAfterWarmup = exports.memory.buffer.byteLength;

        for (let i = 0; i < 1000; i++) {
          const r = runOne(i % 2 === 0 ? htmlReqBytes : waveReqBytes);
          if (!r.ok) {
            throw new Error(`Iteration ${i} failed: ${JSON.stringify(r)}`);
          }
        }

        const bytesAfter1000 = exports.memory.buffer.byteLength;
        return {
          htmlByteLen: htmlReqBytes.byteLength,
          bytesAfterWarmup,
          bytesAfter1000,
          growthBytes: bytesAfter1000 - bytesAfterWarmup,
        };
      });

      assert.ok(stressReport.htmlByteLen >= 65536, `Expected >= 64 KB HTML payload, got ${stressReport.htmlByteLen}`);
      assert.ok(
        stressReport.growthBytes <= 2 * 1024 * 1024,
        `WASM linear memory grew excessively across 1,000 cycles (${stressReport.bytesAfterWarmup} -> ${stressReport.bytesAfter1000}, +${stressReport.growthBytes} bytes)`,
      );
    });
  },
});
