//! Pure-Rust HTML-to-Markdown converter and indirect prompt-injection + secret-redaction
//! scanner (1:1 parity with `gpui_telegram_agent::hermes::{tools_web_media, security}`).

use gpui_telegram_proto::browser_contracts::{
    BrowserInjectionFindingDto, BrowserInjectionScanDto, BrowserInjectionSeverity, BrowserLinkDto,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedMarkdownPage {
    pub title: String,
    pub markdown: String,
    pub total_chars: usize,
    pub links: Vec<BrowserLinkDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injection_scan: Option<BrowserInjectionScanDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FullInjectionScanOutput {
    pub flagged: bool,
    pub severity: BrowserInjectionSeverity,
    pub findings: Vec<BrowserInjectionFindingDto>,
    pub secrets_detected: usize,
    pub sanitized_text: String,
}

pub fn html_to_markdown(
    html: &str,
    include_links: bool,
    offset: usize,
    max_chars: Option<usize>,
    run_injection_scan: bool,
) -> ExtractedMarkdownPage {
    let uncommented = strip_html_comments(html);
    let title = extract_tag_inner(&uncommented, "title")
        .map(|s| decode_html_entities(s.trim()))
        .unwrap_or_default();

    let mut cleaned = strip_tag_blocks(&uncommented, "script");
    cleaned = strip_tag_blocks(&cleaned, "style");
    cleaned = strip_tag_blocks(&cleaned, "noscript");
    cleaned = strip_tag_blocks(&cleaned, "svg");
    cleaned = strip_tag_blocks(&cleaned, "head");

    let mut out = String::with_capacity(cleaned.len() / 2);
    let mut links = Vec::new();
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    let mut link_href: Option<String> = None;
    let mut link_md_text = String::new();
    let mut link_plain_text = String::new();
    let mut in_pre = false;

    while i < cleaned.len() {
        if bytes[i] == b'<' {
            if let Some(rel_end) = try_parse_html_tag_end(&cleaned[i..]) {
                let tag_raw = &cleaned[i + 1..i + rel_end];
                let tag_trim = tag_raw.trim();
                let is_close = tag_trim.starts_with('/');
                let tag_name = tag_trim
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '/')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();

                match (tag_name.as_str(), is_close) {
                    ("h1", false) => out.push_str("\n# "),
                    ("h2", false) => out.push_str("\n## "),
                    ("h3", false) => out.push_str("\n### "),
                    ("h4", false) => out.push_str("\n#### "),
                    ("h5", false) => out.push_str("\n##### "),
                    ("h6", false) => out.push_str("\n###### "),
                    (
                        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "section"
                        | "article" | "blockquote" | "header" | "footer" | "main" | "nav"
                        | "aside",
                        true,
                    ) => {
                        out.push('\n');
                    }
                    (
                        "p" | "div" | "br" | "tr" | "header" | "footer" | "main" | "nav" | "aside",
                        false,
                    ) => out.push('\n'),
                    ("li", false) => out.push_str("\n- "),
                    ("pre", false) => {
                        in_pre = true;
                        out.push_str("\n```\n");
                    }
                    ("pre", true) => {
                        in_pre = false;
                        out.push_str("\n```\n");
                    }
                    ("code", false) if !in_pre => {
                        if link_href.is_some() {
                            link_md_text.push('`');
                        } else {
                            out.push('`');
                        }
                    }
                    ("code", true) if !in_pre => {
                        if link_href.is_some() {
                            link_md_text.push('`');
                        } else {
                            out.push('`');
                        }
                    }
                    ("strong" | "b", _) => {
                        if link_href.is_some() {
                            link_md_text.push_str("**");
                        } else {
                            out.push_str("**");
                        }
                    }
                    ("em" | "i", _) => {
                        if link_href.is_some() {
                            link_md_text.push('*');
                        } else {
                            out.push('*');
                        }
                    }
                    ("a", false) if include_links => {
                        if link_href.is_some() {
                            flush_active_link(
                                &mut link_href,
                                &mut link_md_text,
                                &mut link_plain_text,
                                &mut links,
                                &mut out,
                            );
                        }
                        link_href = extract_attr(tag_raw, "href");
                        link_md_text.clear();
                        link_plain_text.clear();
                    }
                    ("a", true) if include_links => {
                        flush_active_link(
                            &mut link_href,
                            &mut link_md_text,
                            &mut link_plain_text,
                            &mut links,
                            &mut out,
                        );
                    }
                    _ => {}
                }
                i += rel_end + 1;
                continue;
            }

            // Bare `<` (e.g. `"2 < 5"`), `<` at EOF, or unclosed `<tag` with no closing `'>'`:
            // emit literal `'<'` and strictly advance `i += 1` so the loop always terminates.
            if link_href.is_some() {
                link_md_text.push('<');
                link_plain_text.push('<');
            } else {
                out.push('<');
            }
            i += 1;
            continue;
        }

        let next_tag = cleaned[i..]
            .find('<')
            .map(|p| i + p)
            .unwrap_or(cleaned.len());
        let chunk = decode_html_entities(&cleaned[i..next_tag]);
        if link_href.is_some() {
            link_md_text.push_str(&chunk);
            link_plain_text.push_str(&chunk);
        } else if in_pre {
            out.push_str(&chunk);
        } else {
            let collapsed = collapse_inline_whitespace(&chunk);
            if !collapsed.is_empty() {
                if !out.is_empty()
                    && !out.ends_with(['\n', ' ', '`', '*', '<', '[', '('])
                    && !collapsed.starts_with([' ', '.', ',', ':', ';', '!', '?'])
                {
                    out.push(' ');
                }
                out.push_str(&collapsed);
            }
        }
        i = next_tag;
    }

    if link_href.is_some() {
        flush_active_link(
            &mut link_href,
            &mut link_md_text,
            &mut link_plain_text,
            &mut links,
            &mut out,
        );
    }

    let normalized = normalize_markdown_newlines(&out);
    let total_chars = normalized.chars().count();

    let injection_scan = if run_injection_scan {
        let scan = scan_content_for_injection(&normalized);
        Some(BrowserInjectionScanDto {
            flagged: scan.flagged,
            severity: scan.severity,
            findings: scan.findings,
            secrets_detected: scan.secrets_detected,
        })
    } else {
        None
    };

    let paginated = paginate_chars(&normalized, offset, max_chars);

    ExtractedMarkdownPage {
        title,
        markdown: paginated,
        total_chars,
        links,
        injection_scan,
    }
}

fn flush_active_link(
    link_href: &mut Option<String>,
    link_md_text: &mut String,
    link_plain_text: &mut String,
    links: &mut Vec<BrowserLinkDto>,
    out: &mut String,
) {
    if let Some(href) = link_href.take() {
        let md_label = collapse_inline_whitespace(link_md_text).trim().to_string();
        let plain_label = collapse_inline_whitespace(link_plain_text).trim().to_string();
        let dto_label = if plain_label.is_empty() {
            md_label.clone()
        } else {
            plain_label
        };
        if !md_label.is_empty() && !href.is_empty() {
            links.push(BrowserLinkDto {
                text: dto_label,
                href: href.clone(),
                element_ref: None,
            });
            if !out.is_empty() && !out.ends_with(['\n', ' ', '`', '*', '<', '[', '(']) {
                out.push(' ');
            }
            out.push_str(&format!("[{md_label}]({href})"));
        } else {
            out.push_str(&md_label);
        }
        link_md_text.clear();
        link_plain_text.clear();
    }
}

fn paginate_chars(s: &str, offset: usize, max_chars: Option<usize>) -> String {
    let iter = s.chars().skip(offset);
    match max_chars {
        Some(limit) => iter.take(limit).collect(),
        None => iter.collect(),
    }
}

fn is_invisible_or_bidi_char(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'
            | '\u{200C}'
            | '\u{200D}'
            | '\u{2060}'
            | '\u{FEFF}'
            | '\u{00AD}'
            | '\u{180E}'
            | '\u{034F}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{061C}'
            | '\u{2061}'..='\u{2064}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn build_normalized_injection_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_ws = false;
    for c in text.chars() {
        if is_invisible_or_bidi_char(c) {
            continue;
        }
        if c.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_ws = false;
        }
    }
    out
}

pub fn scan_content_for_injection(text: &str) -> FullInjectionScanOutput {
    let lower = text.to_ascii_lowercase();
    let normalized_lower = build_normalized_injection_text(text);
    let mut findings = Vec::new();

    const INJECTION_SIGNATURES: &[(&str, &str, BrowserInjectionSeverity, &str)] = &[
        (
            "ignore_previous_instructions",
            "ignore previous instructions",
            BrowserInjectionSeverity::High,
            "Indirect prompt injection attempting to override system/user instructions",
        ),
        (
            "ignore_all_previous",
            "ignore all previous",
            BrowserInjectionSeverity::High,
            "Indirect prompt injection attempting to override prior instructions",
        ),
        (
            "disregard_prior",
            "disregard prior instructions",
            BrowserInjectionSeverity::High,
            "Indirect prompt injection attempting to disregard instructions",
        ),
        (
            "forget_instructions",
            "forget your instructions",
            BrowserInjectionSeverity::High,
            "Indirect prompt injection attempting to wipe instructions",
        ),
        (
            "new_system_prompt",
            "new system prompt",
            BrowserInjectionSeverity::High,
            "Attempt to inject a synthetic system prompt",
        ),
        (
            "system_override",
            "system override:",
            BrowserInjectionSeverity::High,
            "Synthetic system override directive detected",
        ),
        (
            "chatml_system_tag",
            "<|im_start|>system",
            BrowserInjectionSeverity::High,
            "Raw ChatML system delimiter injection detected",
        ),
        (
            "llama_inst_tag",
            "[inst]",
            BrowserInjectionSeverity::Medium,
            "Raw instruction delimiter [INST] detected in external content",
        ),
        (
            "stealth_exfiltrate",
            "do not tell the user",
            BrowserInjectionSeverity::High,
            "Stealth instruction attempting to conceal actions from the user",
        ),
        (
            "secret_exfil_directive",
            "send the contents of .env",
            BrowserInjectionSeverity::High,
            "Prompt injection instructing model to exfiltrate .env secrets",
        ),
        (
            "reveal_system_prompt",
            "reveal your system prompt",
            BrowserInjectionSeverity::Medium,
            "Attempt to extract system instructions",
        ),
        (
            "bypass_safety",
            "bypass safety",
            BrowserInjectionSeverity::Medium,
            "Attempt to bypass safety checks",
        ),
    ];

    for (rule_id, needle, severity, desc) in INJECTION_SIGNATURES {
        if let Some(pos) = lower.find(needle) {
            let start = pos.saturating_sub(16);
            let end = (pos + needle.len() + 24).min(text.len());
            let excerpt = slice_char_safe(text, start, end);
            findings.push(BrowserInjectionFindingDto {
                rule_id: (*rule_id).into(),
                severity: *severity,
                description: (*desc).into(),
                matched_excerpt: excerpt,
            });
        } else if let Some(norm_pos) = normalized_lower.find(needle) {
            let start = norm_pos.saturating_sub(16);
            let end = (norm_pos + needle.len() + 24).min(normalized_lower.len());
            let excerpt = slice_char_safe(&normalized_lower, start, end);
            findings.push(BrowserInjectionFindingDto {
                rule_id: (*rule_id).into(),
                severity: *severity,
                description: (*desc).into(),
                matched_excerpt: excerpt,
            });
        }
    }

    let bidi_or_zero_width = text.chars().filter(|&c| is_invisible_or_bidi_char(c)).count();
    if bidi_or_zero_width >= 3 {
        findings.push(BrowserInjectionFindingDto {
            rule_id: "hidden_unicode_steganography".into(),
            severity: BrowserInjectionSeverity::Medium,
            description: format!(
                "Detected {bidi_or_zero_width} hidden zero-width or bidi control characters"
            ),
            matched_excerpt: "<unicode-control-sequence>".into(),
        });
    }

    let (sanitized_text, secrets_detected) = redact_secrets(text);
    if secrets_detected > 0 {
        findings.push(BrowserInjectionFindingDto {
            rule_id: "secret_exposure".into(),
            severity: BrowserInjectionSeverity::Medium,
            description: format!(
                "Redacted {secrets_detected} API key / credential / .env secret pattern(s)"
            ),
            matched_excerpt: "[REDACTED]".into(),
        });
    }

    let max_sev = findings
        .iter()
        .map(|f| f.severity)
        .max()
        .unwrap_or(BrowserInjectionSeverity::None);

    FullInjectionScanOutput {
        flagged: !findings.is_empty(),
        severity: max_sev,
        findings,
        secrets_detected,
        sanitized_text,
    }
}

pub fn redact_secrets(input: &str) -> (String, usize) {
    let mut count = 0usize;
    let mut out_lines = Vec::new();

    for line in input.lines() {
        let mut current = line.to_string();

        if let Some((lhs, rhs)) = current.split_once('=') {
            let key_clean = lhs.trim().trim_start_matches("export ").trim();
            let key_upper = key_clean.to_ascii_uppercase();
            let is_sensitive_env_key = !key_upper.is_empty()
                && key_upper
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && (key_upper.ends_with("_KEY")
                    || key_upper.ends_with("_SECRET")
                    || key_upper.ends_with("_TOKEN")
                    || key_upper.ends_with("_PASSWORD")
                    || key_upper.contains("API_KEY")
                    || key_upper.contains("PRIVATE_KEY")
                    || key_upper.contains("ACCESS_KEY")
                    || key_upper == "PASSWORD"
                    || key_upper == "SECRET");

            let rhs_trimmed = rhs.trim().trim_matches(|c| c == '"' || c == '\'');
            if is_sensitive_env_key && rhs_trimmed.len() >= 6 && !rhs_trimmed.contains("[REDACTED")
            {
                current = format!("{lhs}=[REDACTED]");
                count += 1;
            }
        }

        for prefix in [
            "sk-ant-",
            "sk-proj-",
            "sk-",
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "github_pat_",
            "xoxb-",
            "xoxp-",
            "xoxa-",
            "AKIA",
            "AIza",
            "tvly-",
            "pplx-",
            "BSA",
        ] {
            let (next, hits) = redact_prefix_tokens(&current, prefix);
            current = next;
            count += hits;
        }

        let (next_bearer, bearer_hits) = redact_bearer_tokens(&current);
        current = next_bearer;
        count += bearer_hits;

        out_lines.push(current);
    }

    let mut joined = out_lines.join("\n");
    if input.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }

    if joined.contains("-----BEGIN ") && joined.contains("PRIVATE KEY-----") {
        count += 1;
        joined = redact_pem_blocks(&joined);
    }

    (joined, count)
}

fn slice_char_safe(text: &str, start: usize, end: usize) -> String {
    let mut s = start.min(text.len());
    let mut e = end.min(text.len());
    while s > 0 && !text.is_char_boundary(s) {
        s -= 1;
    }
    while e < text.len() && !text.is_char_boundary(e) {
        e += 1;
    }
    if s >= e {
        return String::new();
    }
    text[s..e].to_string()
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

fn redact_prefix_tokens(line: &str, prefix: &str) -> (String, usize) {
    let mut result = String::with_capacity(line.len());
    let mut hits = 0usize;
    let mut idx = 0usize;
    let bytes = line.as_bytes();

    while idx < line.len() {
        if let Some(rel) = line[idx..].find(prefix) {
            let start = idx + rel;
            let boundary_ok =
                start == 0 || !bytes[start - 1].is_ascii_alphanumeric() && bytes[start - 1] != b'_';
            let after_prefix = start + prefix.len();
            let mut end = after_prefix;
            while end < line.len() {
                let ch = line[end..].chars().next().unwrap_or('\0');
                if is_token_char(ch) {
                    end += ch.len_utf8();
                } else {
                    break;
                }
            }
            let min_len = if prefix == "AKIA" { 16 } else { 12 };
            if boundary_ok && (end - start) >= min_len {
                result.push_str(&line[idx..start]);
                result.push_str("[REDACTED_SECRET]");
                hits += 1;
                idx = end;
            } else {
                result.push_str(&line[idx..after_prefix]);
                idx = after_prefix;
            }
        } else {
            result.push_str(&line[idx..]);
            break;
        }
    }
    (result, hits)
}

fn redact_bearer_tokens(line: &str) -> (String, usize) {
    let lower = line.to_ascii_lowercase();
    let mut result = String::with_capacity(line.len());
    let mut hits = 0usize;
    let mut idx = 0usize;
    while idx < line.len() {
        if let Some(rel) = lower[idx..].find("bearer ") {
            let start = idx + rel;
            let tok_start = start + "bearer ".len();
            let mut end = tok_start;
            while end < line.len() {
                let ch = line[end..].chars().next().unwrap_or('\0');
                if is_token_char(ch) || ch == '+' || ch == '/' || ch == '=' {
                    end += ch.len_utf8();
                } else {
                    break;
                }
            }
            if end.saturating_sub(tok_start) >= 10 && !line[tok_start..end].contains("[REDACTED") {
                result.push_str(&line[idx..tok_start]);
                result.push_str("[REDACTED_TOKEN]");
                hits += 1;
                idx = end;
            } else {
                result.push_str(&line[idx..tok_start]);
                idx = tok_start;
            }
        } else {
            result.push_str(&line[idx..]);
            break;
        }
    }
    (result, hits)
}

fn redact_pem_blocks(text: &str) -> String {
    let mut out = String::new();
    let mut in_pem = false;
    for line in text.lines() {
        if line.contains("-----BEGIN ") && line.contains("PRIVATE KEY-----") {
            in_pem = true;
            out.push_str("[REDACTED_PRIVATE_KEY]\n");
            continue;
        }
        if in_pem {
            if line.contains("-----END ") && line.contains("PRIVATE KEY-----") {
                in_pem = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn strip_html_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut idx = 0;
    while idx < html.len() {
        if let Some(rel) = html[idx..].find("<!--") {
            let start = idx + rel;
            out.push_str(&html[idx..start]);
            let rest = &html[start..];
            if rest.starts_with("<!-->") {
                idx = start + 5;
            } else if rest.starts_with("<!--->") {
                idx = start + 6;
            } else if let Some(end_rel) = html[start + 4..].find("-->") {
                idx = start + 4 + end_rel + 3;
            } else {
                out.push_str("<!--");
                idx = start + 4;
            }
        } else {
            out.push_str(&html[idx..]);
            break;
        }
    }
    out
}

/// Quote-aware search for a closing `'>'` starting at byte index `from`.
fn find_tag_gt(s: &str, from: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut in_quote: Option<u8> = None;
    let mut p = from;
    while p < bytes.len() {
        let b = bytes[p];
        if let Some(q) = in_quote {
            if b == q {
                in_quote = None;
            }
        } else if b == b'"' || b == b'\'' {
            in_quote = Some(b);
        } else if b == b'>' {
            return Some(p);
        }
        p += 1;
    }
    None
}

/// Checks whether `s` (starting with `'<'`) begins with a syntactically valid HTML tag,
/// declaration, or processing instruction that has a matching closing `'>'`.
/// Returns the byte offset of that closing `'>'` relative to `s`.
fn try_parse_html_tag_end(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'<' {
        return None;
    }
    let second = bytes[1];
    if second.is_ascii_alphabetic() {
        let mut k = 2;
        while k < bytes.len()
            && (bytes[k].is_ascii_alphanumeric() || matches!(bytes[k], b'-' | b':' | b'_'))
        {
            k += 1;
        }
        if k >= bytes.len() || !(bytes[k] == b'>' || bytes[k] == b'/' || bytes[k].is_ascii_whitespace()) {
            return None;
        }
        let mut in_quote: Option<u8> = None;
        let mut p = k;
        while p < bytes.len() {
            let b = bytes[p];
            if let Some(q) = in_quote {
                if b == q {
                    in_quote = None;
                }
            } else if b == b'"' || b == b'\'' {
                in_quote = Some(b);
            } else if b == b'<' {
                return None;
            } else if b == b'>' {
                return Some(p);
            }
            p += 1;
        }
        None
    } else if second == b'/' {
        if bytes.len() < 4 || !bytes[2].is_ascii_alphabetic() {
            return None;
        }
        let mut k = 3;
        while k < bytes.len()
            && (bytes[k].is_ascii_alphanumeric() || matches!(bytes[k], b'-' | b':' | b'_'))
        {
            k += 1;
        }
        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        if k < bytes.len() && bytes[k] == b'>' {
            Some(k)
        } else {
            None
        }
    } else if second == b'!' || second == b'?' {
        find_tag_gt(s, 2)
    } else {
        None
    }
}

fn find_open_tag_boundary(
    lower: &str,
    from: usize,
    tag: &str,
) -> Option<(usize, Option<usize>, bool)> {
    let open = format!("<{tag}");
    let bytes = lower.as_bytes();
    let mut search_idx = from;
    while search_idx < lower.len() {
        let rel = lower[search_idx..].find(&open)?;
        let start = search_idx + rel;
        let after_name = start + open.len();
        if after_name == bytes.len() {
            return Some((start, None, false));
        }
        let next_b = bytes[after_name];
        if next_b == b'>' || next_b == b'/' || next_b.is_ascii_whitespace() {
            let gt_opt = find_tag_gt(lower, after_name);
            let is_self_closing = if let Some(gt_pos) = gt_opt {
                bytes[after_name..gt_pos]
                    .iter()
                    .rfind(|b| !b.is_ascii_whitespace())
                    .copied()
                    == Some(b'/')
            } else {
                false
            };
            return Some((start, gt_opt, is_self_closing));
        }
        search_idx = after_name;
    }
    None
}

fn find_close_tag_boundary(lower: &str, from: usize, tag: &str) -> Option<(usize, usize)> {
    let close = format!("</{tag}");
    let bytes = lower.as_bytes();
    let mut search_idx = from;
    while search_idx < lower.len() {
        let rel = lower[search_idx..].find(&close)?;
        let start = search_idx + rel;
        let mut p = start + close.len();
        while p < bytes.len() && bytes[p].is_ascii_whitespace() {
            p += 1;
        }
        if p < bytes.len() && bytes[p] == b'>' {
            return Some((start, p + 1));
        }
        search_idx = start + close.len();
    }
    None
}

fn extract_tag_inner(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let (_start, gt_opt, is_self_closing) = find_open_tag_boundary(&lower, 0, tag)?;
    if is_self_closing {
        return None;
    }
    let after_open = gt_opt? + 1;
    let (end, _close_end) = find_close_tag_boundary(&lower, after_open, tag)?;
    Some(html[after_open..end].to_string())
}

fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut idx = 0;
    while idx < html.len() {
        if let Some((start, gt_opt, is_self_closing)) = find_open_tag_boundary(&lower, idx, tag) {
            out.push_str(&html[idx..start]);
            if is_self_closing {
                idx = gt_opt.expect("self-closing tag has >") + 1;
            } else if let Some(gt_pos) = gt_opt {
                if let Some((_close_start, close_end)) =
                    find_close_tag_boundary(&lower, gt_pos + 1, tag)
                {
                    idx = close_end;
                } else if matches!(tag, "script" | "style") {
                    break;
                } else {
                    // For unclosed `<head>` / `<svg>` / `<noscript>`, strip only the opening tag
                    // rather than wiping `<body>`.
                    idx = gt_pos + 1;
                }
            } else if matches!(tag, "script" | "style") {
                break;
            } else {
                out.push('<');
                idx = start + 1;
            }
        } else {
            out.push_str(&html[idx..]);
            break;
        }
    }
    out
}

fn extract_attr(tag_raw: &str, attr: &str) -> Option<String> {
    let bytes = tag_raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let q = bytes[i];
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && !matches!(bytes[i], b'=' | b'/' | b'"' | b'\'' | b'>')
        {
            i += 1;
        }
        let name = &tag_raw[name_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let val_raw = if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let q = bytes[i];
                i += 1;
                let v_start = i;
                while i < bytes.len() && bytes[i] != q {
                    i += 1;
                }
                let slice = &tag_raw[v_start..i];
                if i < bytes.len() {
                    i += 1;
                }
                slice
            } else {
                let v_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                &tag_raw[v_start..i]
            };
            if name.eq_ignore_ascii_case(attr) {
                return Some(decode_html_entities(val_raw));
            }
        } else if name.is_empty() {
            i += 1;
        }
    }
    None
}

fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some(rel) = s[i..].find('&') {
            out.push_str(&s[i..i + rel]);
            let amp = i + rel;
            let rest = &s[amp + 1..];
            if let Some(semi) = rest.find(';') {
                if semi <= 12 {
                    let entity = &rest[..semi];
                    let decoded: Option<char> = match entity {
                        "amp" | "AMP" => Some('&'),
                        "lt" | "LT" => Some('<'),
                        "gt" | "GT" => Some('>'),
                        "quot" | "QUOT" => Some('"'),
                        "apos" | "APOS" | "#39" => Some('\''),
                        "nbsp" | "NBSP" => Some(' '),
                        _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                            u32::from_str_radix(&entity[2..], 16)
                                .ok()
                                .and_then(char::from_u32)
                        }
                        _ if entity.starts_with('#') => entity[1..]
                            .parse::<u32>()
                            .ok()
                            .and_then(char::from_u32),
                        _ => None,
                    };
                    if let Some(ch) = decoded {
                        out.push(ch);
                        i = amp + 1 + semi + 1;
                        continue;
                    }
                }
            }
            out.push('&');
            i = amp + 1;
        } else {
            out.push_str(&s[i..]);
            break;
        }
    }
    out
}

fn collapse_inline_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

fn normalize_markdown_newlines(s: &str) -> String {
    let mut lines = Vec::new();
    let mut blank_run = 0usize;
    for line in s.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
        } else {
            blank_run = 0;
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n").trim().to_string()
}
