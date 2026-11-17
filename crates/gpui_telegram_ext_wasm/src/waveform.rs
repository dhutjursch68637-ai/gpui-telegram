//! Telegram 5-bit 100-bar voice note waveform codec (1:1 parity with
//! `gpui_telegram_media::waveform::{encoder, decoder, normalizer}`).

pub const TELEGRAM_WAVEFORM_BARS: usize = 100;
pub const WAVEFORM_MAX_VALUE: u8 = 31;
pub const PEAK_AVERAGE_RATIO: f64 = 1.8;
pub const MINIMAL_PEAK_FLOOR: i32 = 2500;
pub const MAX_WAVEFORM_FLOAT_COUNT: usize = 4096;
pub const MAX_WAVEFORM_ENCODED_BYTES: usize = 2560;
pub const MAX_WAVEFORM_INPUT_SAMPLES: usize = 1_048_576;

pub fn encode_waveform_5bit(bars: &[u8]) -> Vec<u8> {
    let count = bars.len().min(TELEGRAM_WAVEFORM_BARS);
    if count == 0 {
        return Vec::new();
    }

    let bits_count = count * 5;
    let bytes_count = bits_count.div_ceil(8);
    let mut result = vec![0u8; bytes_count + 1];

    for (i, &bar) in bars.iter().take(count).enumerate() {
        let byte_index = (i * 5) / 8;
        let bit_shift = (i * 5) % 8;
        let value = ((bar & WAVEFORM_MAX_VALUE) as u16) << bit_shift;
        let previous = u16::from_le_bytes([result[byte_index], result[byte_index + 1]]);
        let combined = previous | value;
        let le = combined.to_le_bytes();
        result[byte_index] = le[0];
        result[byte_index + 1] = le[1];
    }

    result.truncate(bytes_count);
    result
}

pub fn decode_waveform_5bit(encoded: &[u8]) -> Vec<u8> {
    let clamped = if encoded.len() > MAX_WAVEFORM_ENCODED_BYTES {
        &encoded[..MAX_WAVEFORM_ENCODED_BYTES]
    } else {
        encoded
    };
    let bits_count = clamped.len().saturating_mul(8);
    let values_count = bits_count / 5;
    if values_count == 0 {
        return Vec::new();
    }

    let mut result = vec![0u8; values_count];
    for (i, slot) in result
        .iter_mut()
        .enumerate()
        .take(values_count.saturating_sub(1))
    {
        let byte_index = (i * 5) / 8;
        let bit_shift = (i * 5) % 8;
        let value = u16::from_le_bytes([clamped[byte_index], clamped[byte_index + 1]]);
        *slot = ((value >> bit_shift) & (WAVEFORM_MAX_VALUE as u16)) as u8;
    }

    let last_index = values_count - 1;
    let last_byte_index = (last_index * 5) / 8;
    let last_bit_shift = (last_index * 5) % 8;
    let last_value = if last_byte_index + 1 < clamped.len() {
        u16::from_le_bytes([clamped[last_byte_index], clamped[last_byte_index + 1]])
    } else {
        clamped[last_byte_index] as u16
    };
    result[last_index] = ((last_value >> last_bit_shift) & (WAVEFORM_MAX_VALUE as u16)) as u8;

    result
}

pub fn decode_waveform_to_floats(encoded: &[u8], count: usize) -> Vec<f32> {
    let bounded_count = count.min(MAX_WAVEFORM_FLOAT_COUNT);
    let bars = decode_waveform_5bit(encoded);
    let mut floats = Vec::with_capacity(bounded_count);
    for i in 0..bounded_count {
        if i < bars.len() {
            floats.push((bars[i] as f32) / 31.0);
        } else {
            floats.push(0.0);
        }
    }
    floats
}

pub fn normalize_pcm_peaks(peaks: &[u16]) -> Vec<u8> {
    if peaks.is_empty() {
        return Vec::new();
    }

    let count = peaks.len().min(TELEGRAM_WAVEFORM_BARS);
    let selected = &peaks[..count];
    let sum: i64 = selected.iter().map(|&p| p as i64).sum();
    let avg = (sum as f64) * PEAK_AVERAGE_RATIO / (count as f64);
    let dynamic_ceiling = (avg.round() as i32).max(MINIMAL_PEAK_FLOOR) as u32;

    selected
        .iter()
        .map(|&p| {
            let clamped = (p as u32).min(dynamic_ceiling);
            ((clamped * 31) / dynamic_ceiling).min(31) as u8
        })
        .collect()
}

pub fn bars_from_float_peaks(peaks: &[f32]) -> Vec<u8> {
    peaks
        .iter()
        .take(TELEGRAM_WAVEFORM_BARS)
        .map(|&p| (p.clamp(0.0, 1.0) * 31.0).round() as u8)
        .collect()
}

pub fn resample_and_normalize_waveform(samples: &[u8]) -> Vec<u8> {
    if samples.is_empty() {
        return Vec::new();
    }

    let count = samples.len() as i64;
    let target_bars = TELEGRAM_WAVEFORM_BARS as i64;

    if count < target_bars {
        let mut peaks = Vec::with_capacity(TELEGRAM_WAVEFORM_BARS);
        for i in 0..TELEGRAM_WAVEFORM_BARS {
            let src_idx = (i * samples.len()) / TELEGRAM_WAVEFORM_BARS;
            peaks.push((samples[src_idx] as u16) * 256);
        }
        return normalize_pcm_peaks(&peaks);
    }

    let mut peaks = Vec::with_capacity(TELEGRAM_WAVEFORM_BARS);
    let mut peak: u16 = 0;
    let mut sum: i64 = 0;

    for &sample in samples {
        let sample_val = (sample as u16) * 256;
        if peak < sample_val {
            peak = sample_val;
        }
        sum += target_bars;
        if sum >= count {
            sum -= count;
            peaks.push(peak);
            peak = 0;
        }
    }

    if peaks.len() < TELEGRAM_WAVEFORM_BARS && !peaks.is_empty() {
        let last = *peaks.last().expect("peaks non-empty");
        while peaks.len() < TELEGRAM_WAVEFORM_BARS {
            peaks.push(last);
        }
    }

    normalize_pcm_peaks(&peaks)
}
