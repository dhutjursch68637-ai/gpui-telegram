use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use gpui_telegram_media::{
    compute_pcm_rms_level, decode_wav_pcm, encode_wav_i16, waveform_from_pcm_i16,
    ThumbnailGenerator,
};
use gpui_telegram_proto::browser_contracts::{
    sanitize_download_filename, validate_browser_tool_arguments, BrowserCommandRequest,
};

use super::browser_bridge::{
    canonicalize_browser_tool_name, to_browser_injection_dto, validate_navigable_browser_url,
};
use super::browser_cdp::{global_cdp_manager, parse_image_dimensions_from_b64};
use super::security::scan_content_for_injection;
use super::toolsets::{HermesToolArtifact, HermesToolContext, HermesToolResult};

pub async fn execute_web_media_tool(
    name: &str,
    args: Value,
    ctx: &HermesToolContext,
) -> HermesToolResult {
    if canonicalize_browser_tool_name(name).is_some() {
        return execute_browser_tool(name, args, ctx).await;
    }
    match name {
        "web_search" => tool_web_search(args, ctx).await,
        "web_extract" => tool_web_extract(args, ctx).await,
        "text_to_speech" => tool_text_to_speech(args, ctx).await,
        "speech_to_text" => tool_speech_to_text(args, ctx).await,
        "vision_analyze" => tool_vision_analyze(args, ctx).await,
        "image_generate" => tool_image_generate(args, ctx).await,
        "video_generate" => tool_video_generate(args, ctx).await,
        _ => HermesToolResult::err(name, format!("Unknown web/media tool '{name}'")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

async fn tool_web_search(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(query) = args.get("query").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) else {
        return HermesToolResult::err("web_search", "Missing required 'query' parameter");
    };
    let provider = args
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("duckduckgo")
        .trim()
        .to_ascii_lowercase();
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    let endpoint_override = args.get("endpoint_url").and_then(|v| v.as_str());

    let res = match provider.as_str() {
        "tavily" => search_tavily(query, limit, endpoint_override, ctx).await,
        "brave" => search_brave(query, limit, endpoint_override, ctx).await,
        "perplexity" => search_perplexity(query, endpoint_override, ctx).await,
        "searxng" => search_searxng(query, limit, endpoint_override, ctx).await,
        "duckduckgo" | "ddg" => search_duckduckgo(query, limit, endpoint_override, ctx).await,
        other => Err(format!("Unsupported web_search provider '{other}'")),
    };

    match res {
        Ok(items) => {
            let formatted = if items.is_empty() {
                format!("No search results found for '{query}' via {provider}.")
            } else {
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        format!(
                            "{}. [{}]({})\n   {}",
                            i + 1,
                            item.title,
                            item.url,
                            item.snippet
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            HermesToolResult::ok(
                "web_search",
                formatted,
                Some(json!({ "provider": provider, "query": query, "results": items })),
            )
        }
        Err(e) => HermesToolResult::err("web_search", e),
    }
}

async fn search_tavily(
    query: &str,
    limit: usize,
    endpoint_override: Option<&str>,
    ctx: &HermesToolContext,
) -> Result<Vec<WebSearchResult>, String> {
    let api_key = std::env::var("TAVILY_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "TAVILY_API_KEY is not configured".to_string())?;
    let url = endpoint_override.unwrap_or("https://api.tavily.com/search");
    let resp = ctx
        .http_client
        .post(url)
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "max_results": limit,
            "search_depth": "basic"
        }))
        .send()
        .await
        .map_err(|e| format!("Tavily request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Tavily returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Tavily JSON parse failed: {e}"))?;
    let mut results = Vec::new();
    if let Some(arr) = body.get("results").and_then(|v| v.as_array()) {
        for item in arr.iter().take(limit) {
            results.push(WebSearchResult {
                title: item.get("title").and_then(|v| v.as_str()).unwrap_or("").into(),
                url: item.get("url").and_then(|v| v.as_str()).unwrap_or("").into(),
                snippet: item.get("content").and_then(|v| v.as_str()).unwrap_or("").into(),
                source: "tavily".into(),
            });
        }
    }
    Ok(results)
}

async fn search_brave(
    query: &str,
    limit: usize,
    endpoint_override: Option<&str>,
    ctx: &HermesToolContext,
) -> Result<Vec<WebSearchResult>, String> {
    let api_key = std::env::var("BRAVE_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "BRAVE_API_KEY is not configured".to_string())?;
    let base = endpoint_override.unwrap_or("https://api.search.brave.com/res/v1/web/search");
    let url = format!("{base}?q={}&count={limit}", percent_encode(query));
    let resp = ctx
        .http_client
        .get(&url)
        .header("X-Subscription-Token", api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Brave Search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Brave Search returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Brave JSON parse failed: {e}"))?;
    let mut results = Vec::new();
    if let Some(arr) = body
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|v| v.as_array())
    {
        for item in arr.iter().take(limit) {
            results.push(WebSearchResult {
                title: item.get("title").and_then(|v| v.as_str()).unwrap_or("").into(),
                url: item.get("url").and_then(|v| v.as_str()).unwrap_or("").into(),
                snippet: item.get("description").and_then(|v| v.as_str()).unwrap_or("").into(),
                source: "brave".into(),
            });
        }
    }
    Ok(results)
}

async fn search_perplexity(
    query: &str,
    endpoint_override: Option<&str>,
    ctx: &HermesToolContext,
) -> Result<Vec<WebSearchResult>, String> {
    let api_key = std::env::var("PERPLEXITY_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "PERPLEXITY_API_KEY is not configured".to_string())?;
    let url = endpoint_override.unwrap_or("https://api.perplexity.ai/chat/completions");
    let resp = ctx
        .http_client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": "sonar",
            "messages": [{ "role": "user", "content": query }]
        }))
        .send()
        .await
        .map_err(|e| format!("Perplexity request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Perplexity returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Perplexity JSON parse failed: {e}"))?;
    let answer = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut results = vec![WebSearchResult {
        title: format!("Perplexity Answer: {query}"),
        url: "https://www.perplexity.ai".into(),
        snippet: answer.into(),
        source: "perplexity".into(),
    }];
    if let Some(citations) = body.get("citations").and_then(|c| c.as_array()) {
        for c in citations {
            if let Some(u) = c.as_str() {
                results.push(WebSearchResult {
                    title: u.to_string(),
                    url: u.to_string(),
                    snippet: String::new(),
                    source: "perplexity_citation".into(),
                });
            }
        }
    }
    Ok(results)
}

async fn search_searxng(
    query: &str,
    limit: usize,
    endpoint_override: Option<&str>,
    ctx: &HermesToolContext,
) -> Result<Vec<WebSearchResult>, String> {
    let base = endpoint_override
        .map(ToString::to_string)
        .or_else(|| std::env::var("SEARXNG_URL").ok())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "SearXNG endpoint_url or SEARXNG_URL is not configured".to_string())?;
    let url = format!(
        "{}/search?format=json&q={}",
        base.trim_end_matches('/'),
        percent_encode(query)
    );
    let resp = ctx
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SearXNG request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("SearXNG returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("SearXNG JSON parse failed: {e}"))?;
    let mut results = Vec::new();
    if let Some(arr) = body.get("results").and_then(|v| v.as_array()) {
        for item in arr.iter().take(limit) {
            results.push(WebSearchResult {
                title: item.get("title").and_then(|v| v.as_str()).unwrap_or("").into(),
                url: item.get("url").and_then(|v| v.as_str()).unwrap_or("").into(),
                snippet: item.get("content").and_then(|v| v.as_str()).unwrap_or("").into(),
                source: "searxng".into(),
            });
        }
    }
    Ok(results)
}

async fn search_duckduckgo(
    query: &str,
    limit: usize,
    endpoint_override: Option<&str>,
    ctx: &HermesToolContext,
) -> Result<Vec<WebSearchResult>, String> {
    let base = endpoint_override.unwrap_or("https://api.duckduckgo.com/");
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}q={}&format=json&no_html=1&skip_disambig=1", percent_encode(query));
    let resp = ctx
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("DuckDuckGo returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("DuckDuckGo JSON parse failed: {e}"))?;
    let mut results = Vec::new();
    let abstract_text = body.get("AbstractText").and_then(|v| v.as_str()).unwrap_or("");
    let abstract_url = body.get("AbstractURL").and_then(|v| v.as_str()).unwrap_or("");
    let heading = body.get("Heading").and_then(|v| v.as_str()).unwrap_or(query);
    if !abstract_text.is_empty() {
        results.push(WebSearchResult {
            title: heading.into(),
            url: abstract_url.into(),
            snippet: abstract_text.into(),
            source: "duckduckgo".into(),
        });
    }
    if let Some(topics) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
        for topic in topics {
            if results.len() >= limit {
                break;
            }
            if let (Some(text), Some(first_url)) = (
                topic.get("Text").and_then(|v| v.as_str()),
                topic.get("FirstURL").and_then(|v| v.as_str()),
            ) {
                results.push(WebSearchResult {
                    title: text.split(" - ").next().unwrap_or(text).into(),
                    url: first_url.into(),
                    snippet: text.into(),
                    source: "duckduckgo".into(),
                });
            }
        }
    }
    Ok(results)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedWebPage {
    pub title: String,
    pub markdown: String,
    pub links: Vec<(String, String)>,
}

async fn tool_web_extract(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(url) = args.get("url").and_then(|v| v.as_str()).map(str::trim) else {
        return HermesToolResult::err("web_extract", "Missing required 'url' parameter");
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return HermesToolResult::err("web_extract", "web_extract only supports http:// and https:// URLs");
    }
    if url.contains("169.254.169.254") || url.contains("metadata.google.internal") {
        return HermesToolResult::err("web_extract", "Blocked cloud metadata endpoint URL");
    }

    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .unwrap_or(20_000) as usize;
    let include_links = args
        .get("include_links")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let resp = match ctx.http_client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return HermesToolResult::err("web_extract", format!("HTTP fetch failed: {e}")),
    };
    let status = resp.status();
    if !status.is_success() {
        return HermesToolResult::err("web_extract", format!("Target URL returned HTTP {status}"));
    }
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => return HermesToolResult::err("web_extract", format!("Failed reading body: {e}")),
    };

    let extracted = html_to_markdown(&body, include_links);
    let mut md = extracted.markdown;
    if md.chars().count() > max_chars {
        md = md.chars().take(max_chars).collect::<String>();
        md.push_str("\n...[truncated]...");
    }

    let scan = scan_content_for_injection(&md);
    let output = if scan.flagged {
        format!(
            "# {}\n\n[SECURITY WARNING: Potential indirect prompt-injection/secrets flagged]\n\n{}",
            extracted.title, scan.sanitized_text
        )
    } else if extracted.title.is_empty() {
        md.clone()
    } else {
        format!("# {}\n\n{}", extracted.title, md)
    };

    HermesToolResult::ok(
        "web_extract",
        output,
        Some(json!({
            "url": url,
            "title": extracted.title,
            "link_count": extracted.links.len(),
            "injection_flagged": scan.flagged,
        })),
    )
}

/// Pure-Rust HTML-to-Markdown converter stripping script/style/head and preserving headings, lists, code, links.
pub fn html_to_markdown(html: &str, include_links: bool) -> ExtractedWebPage {
    let title = extract_tag_inner(html, "title")
        .map(|s| decode_html_entities(s.trim()))
        .unwrap_or_default();

    let mut cleaned = strip_tag_blocks(html, "script");
    cleaned = strip_tag_blocks(&cleaned, "style");
    cleaned = strip_tag_blocks(&cleaned, "noscript");
    cleaned = strip_tag_blocks(&cleaned, "svg");
    cleaned = strip_tag_blocks(&cleaned, "head");

    let mut out = String::with_capacity(cleaned.len() / 2);
    let mut links = Vec::new();
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    let mut link_href: Option<String> = None;
    let mut link_text = String::new();
    let mut in_pre = false;

    while i < cleaned.len() {
        if bytes[i] == b'<' {
            if let Some(rel_end) = cleaned[i..].find('>') {
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
                    ("h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "section" | "article" | "blockquote", true) => {
                        out.push('\n');
                    }
                    ("p" | "div" | "br" | "tr", false) => out.push('\n'),
                    ("li", false) => out.push_str("\n- "),
                    ("pre", false) => {
                        in_pre = true;
                        out.push_str("\n```\n");
                    }
                    ("pre", true) => {
                        in_pre = false;
                        out.push_str("\n```\n");
                    }
                    ("code", false) if !in_pre => out.push('`'),
                    ("code", true) if !in_pre => out.push('`'),
                    ("strong" | "b", _) => out.push_str("**"),
                    ("em" | "i", _) => out.push('*'),
                    ("a", false) if include_links => {
                        link_href = extract_attr(tag_raw, "href");
                        link_text.clear();
                    }
                    ("a", true) if include_links => {
                        if let Some(href) = link_href.take() {
                            let label = link_text.trim().to_string();
                            if !label.is_empty() && !href.is_empty() {
                                links.push((label.clone(), href.clone()));
                                out.push_str(&format!("[{label}]({href})"));
                            } else {
                                out.push_str(&label);
                            }
                            link_text.clear();
                        }
                    }
                    _ => {}
                }
                i += rel_end + 1;
                continue;
            }
        }

        let next_tag = cleaned[i..].find('<').map(|p| i + p).unwrap_or(cleaned.len());
        let chunk = decode_html_entities(&cleaned[i..next_tag]);
        if link_href.is_some() {
            link_text.push_str(&chunk);
        } else if in_pre {
            out.push_str(&chunk);
        } else {
            let collapsed = collapse_inline_whitespace(&chunk);
            if !collapsed.is_empty() {
                if !out.ends_with(['\n', ' ', '`', '*']) && !collapsed.starts_with([' ', '.', ',', ':', ';', '!', '?']) {
                    out.push(' ');
                }
                out.push_str(&collapsed);
            }
        }
        i = next_tag;
    }

    let normalized = normalize_markdown_newlines(&out);
    ExtractedWebPage {
        title,
        markdown: normalized,
        links,
    }
}

fn extract_tag_inner(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = lower.find(&open)?;
    let after_open = html[start..].find('>')? + start + 1;
    let end = lower[after_open..].find(&close)? + after_open;
    Some(html[after_open..end].to_string())
}

fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(html.len());
    let mut idx = 0;
    while idx < html.len() {
        if let Some(rel) = lower[idx..].find(&open) {
            let start = idx + rel;
            out.push_str(&html[idx..start]);
            if let Some(close_rel) = lower[start..].find(&close) {
                idx = start + close_rel + close.len();
            } else {
                break;
            }
        } else {
            out.push_str(&html[idx..]);
            break;
        }
    }
    out
}

fn extract_attr(tag_raw: &str, attr: &str) -> Option<String> {
    let lower = tag_raw.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let pos = lower.find(&needle)?;
    let rest = tag_raw[pos + needle.len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next().map(ToString::to_string)
    } else if let Some(stripped) = rest.strip_prefix('\'') {
        stripped.split('\'').next().map(ToString::to_string)
    } else {
        rest.split_whitespace().next().map(ToString::to_string)
    }
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
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

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else if *b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// ----------------------------------------------------------------------------
// Dual-Mode Browser Control Toolset (Bridge Relay Primary + CDP Fallback)
// ----------------------------------------------------------------------------

async fn execute_browser_tool(
    raw_name: &str,
    mut args: Value,
    ctx: &HermesToolContext,
) -> HermesToolResult {
    let Some(canonical) = canonicalize_browser_tool_name(raw_name) else {
        return HermesToolResult::err(raw_name, format!("Unknown browser tool '{raw_name}'"));
    };

    if args.is_null() {
        args = json!({});
    }
    if let Err(err) = validate_browser_tool_arguments(&args) {
        return HermesToolResult::err(raw_name, err);
    }

    match canonical {
        "browser_open_tab" => {
            let raw_url = args
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("about:blank");
            if let Err((code, msg)) = validate_navigable_browser_url(raw_url, true) {
                return HermesToolResult::err(
                    raw_name,
                    format!("{} ({}): {}", code.as_str(), code.code(), msg),
                );
            }
        }
        "browser_navigate" => {
            let Some(raw_url) = args
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return HermesToolResult::err(raw_name, "Missing required 'url' parameter");
            };
            if let Err((code, msg)) = validate_navigable_browser_url(raw_url, true) {
                return HermesToolResult::err(
                    raw_name,
                    format!("{} ({}): {}", code.as_str(), code.code(), msg),
                );
            }
        }
        "browser_download_url" => {
            let Some(raw_url) = args
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                return HermesToolResult::err(raw_name, "Missing required 'url' parameter");
            };
            if let Err((code, msg)) = validate_navigable_browser_url(raw_url, false) {
                return HermesToolResult::err(
                    raw_name,
                    format!("{} ({}): {}", code.as_str(), code.code(), msg),
                );
            }
            if let Some(obj) = args.as_object_mut() {
                if let Some(raw_fn) = obj
                    .get("filename")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                {
                    match sanitize_download_filename(&raw_fn) {
                        Some(clean) => {
                            obj.insert("filename".to_string(), Value::String(clean));
                        }
                        None => {
                            obj.remove("filename");
                        }
                    }
                }
            }
        }
        "browser_manage_cookies" => {
            if let Some(raw_url) = args
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if let Err((code, msg)) = validate_navigable_browser_url(raw_url, false) {
                    return HermesToolResult::err(
                        raw_name,
                        format!("{} ({}): {}", code.as_str(), code.code(), msg),
                    );
                }
            }
        }
        _ => {}
    }

    let explicit_cdp = args
        .get("cdp_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    let bot_u64 = ctx.bot_id.and_then(|id| u64::try_from(id).ok());

    let cmd_res = if !explicit_cdp {
        if let Some(ref provider) = ctx.browser_provider {
            if provider.should_route_via_bridge(ctx.user_id, bot_u64) {
                let req = BrowserCommandRequest {
                    command_id: None,
                    tool: canonical.to_string(),
                    arguments: args.clone(),
                    bot_id: bot_u64,
                    bot_name: ctx.bound_agent_id.clone(),
                    chat_id: ctx.chat_id,
                    timeout_ms: args.get("timeout_ms").and_then(Value::as_u64),
                };
                match provider.execute(ctx.user_id, req).await {
                    Ok(res) => res,
                    Err(err) => return HermesToolResult::err(raw_name, err),
                }
            } else {
                match global_cdp_manager()
                    .execute_tool(canonical, &args, ctx.browser_cdp_url.as_deref())
                    .await
                {
                    Ok(res) => res,
                    Err((code, msg)) => {
                        return HermesToolResult::err(
                            raw_name,
                            format!("{} ({}): {}", code.as_str(), code.code(), msg),
                        );
                    }
                }
            }
        } else {
            match global_cdp_manager()
                .execute_tool(canonical, &args, ctx.browser_cdp_url.as_deref())
                .await
            {
                Ok(res) => res,
                Err((code, msg)) => {
                    return HermesToolResult::err(
                        raw_name,
                        format!("{} ({}): {}", code.as_str(), code.code(), msg),
                    );
                }
            }
        }
    } else {
        match global_cdp_manager()
            .execute_tool(canonical, &args, ctx.browser_cdp_url.as_deref())
            .await
        {
            Ok(res) => res,
            Err((code, msg)) => {
                return HermesToolResult::err(
                    raw_name,
                    format!("{} ({}): {}", code.as_str(), code.code(), msg),
                );
            }
        }
    };

    if !cmd_res.ok {
        let code_str = cmd_res.error_code.as_deref().unwrap_or("BROWSER_ERROR");
        let rpc_code = cmd_res.rpc_code.unwrap_or(-32603);
        let msg = cmd_res
            .error_message
            .unwrap_or_else(|| "Browser command failed".to_string());
        return HermesToolResult::err(raw_name, format!("{code_str} ({rpc_code}): {msg}"));
    }

    let mut payload = if cmd_res.data.is_object() {
        cmd_res.data.clone()
    } else if cmd_res.data.is_null() {
        json!({ "ok": true })
    } else {
        json!({ "ok": true, "result": cmd_res.data })
    };

    if let Some(obj) = payload.as_object_mut() {
        obj.entry("ok".to_string()).or_insert(Value::Bool(true));
        if let Some(tid) = cmd_res.tab_id {
            obj.entry("tab_id".to_string()).or_insert_with(|| json!(tid));
        }
        if let Some(ref url) = cmd_res.url {
            obj.entry("url".to_string()).or_insert_with(|| json!(url));
        }
        if let Some(ref title) = cmd_res.title {
            obj.entry("title".to_string()).or_insert_with(|| json!(title));
        }
        if !cmd_res.executed_via.is_empty() {
            obj.entry("executed_via".to_string())
                .or_insert_with(|| json!(cmd_res.executed_via));
        }
    }

    // Untrusted DOM/Markdown prompt-injection & secret scrubbing
    if canonical == "browser_snapshot" {
        scrub_browser_text_field(&mut payload, "markdown_excerpt");
    } else if canonical == "browser_extract_markdown" {
        scrub_browser_text_field(&mut payload, "markdown");
    } else if canonical == "browser_manage_cookies" {
        redact_http_only_cookies(&mut payload);
    }

    if canonical == "browser_screenshot" {
        let raw_b64 = cmd_res
            .artifact
            .as_ref()
            .map(|a| a.data_base64.as_str())
            .or_else(|| payload.get("data_base64").and_then(Value::as_str))
            .unwrap_or("");
        let clean_b64 = strip_data_url_prefix(raw_b64).to_string();
        let mime_type = cmd_res
            .artifact
            .as_ref()
            .map(|a| a.mime_type.as_str())
            .or_else(|| payload.get("mime_type").and_then(Value::as_str))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("image/png")
            .to_string();
        let (probed_w, probed_h) = parse_image_dimensions_from_b64(&clean_b64).unwrap_or((0, 0));
        let width = cmd_res
            .artifact
            .as_ref()
            .and_then(|a| a.width)
            .or_else(|| payload.get("width").and_then(Value::as_u64).map(|v| v as u32))
            .filter(|&v| v > 0)
            .or((probed_w > 0).then_some(probed_w));
        let height = cmd_res
            .artifact
            .as_ref()
            .and_then(|a| a.height)
            .or_else(|| payload.get("height").and_then(Value::as_u64).map(|v| v as u32))
            .filter(|&v| v > 0)
            .or((probed_h > 0).then_some(probed_h));

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("mime_type".to_string(), Value::String(mime_type.clone()));
            obj.insert("data_base64".to_string(), Value::String(clean_b64.clone()));
            if let Some(w) = width {
                obj.insert("width".to_string(), json!(w));
            }
            if let Some(h) = height {
                obj.insert("height".to_string(), json!(h));
            }
        }

        let ext = if mime_type.contains("jpeg") || mime_type.contains("jpg") {
            "jpg"
        } else {
            "png"
        };
        let summary_for_llm = json!({
            "ok": true,
            "tab_id": payload.get("tab_id").cloned().unwrap_or(Value::Null),
            "url": payload.get("url").cloned().unwrap_or(Value::Null),
            "title": payload.get("title").cloned().unwrap_or(Value::Null),
            "mime_type": mime_type,
            "width": width,
            "height": height,
            "base64_chars": clean_b64.len(),
            "artifact_attached": !clean_b64.is_empty(),
        });

        let mut res = HermesToolResult::ok(
            raw_name,
            serde_json::to_string(&summary_for_llm).unwrap_or_default(),
            Some(payload),
        );
        if !clean_b64.is_empty() {
            res = res.with_artifact(HermesToolArtifact {
                kind: "image".into(),
                name: format!("browser_screenshot.{ext}"),
                mime_type,
                path: None,
                data_base64: Some(clean_b64),
                metadata: json!({
                    "width": width,
                    "height": height,
                    "tab_id": cmd_res.tab_id,
                    "url": cmd_res.url,
                    "executed_via": cmd_res.executed_via,
                }),
            });
        }
        return res;
    }

    let output = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    HermesToolResult::ok(raw_name, output, Some(payload))
}

fn scrub_browser_text_field(payload: &mut Value, field: &str) {
    let Some(raw_text) = payload
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
    else {
        return;
    };
    let scan = scan_content_for_injection(&raw_text);
    let scan_dto = to_browser_injection_dto(&scan);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(field.to_string(), Value::String(scan.sanitized_text));
        let should_replace_scan = match obj.get("injection_scan") {
            None => true,
            Some(existing) => {
                let existing_flagged = existing
                    .get("flagged")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                scan_dto.flagged || !existing_flagged
            }
        };
        if should_replace_scan {
            if let Ok(scan_val) = serde_json::to_value(&scan_dto) {
                obj.insert("injection_scan".to_string(), scan_val);
            }
        }
    }
}

fn redact_http_only_cookies(payload: &mut Value) {
    let Some(cookies) = payload
        .get_mut("cookies")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for item in cookies.iter_mut() {
        if let Some(obj) = item.as_object_mut() {
            let is_http_only = obj
                .get("http_only")
                .or_else(|| obj.get("httpOnly"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_http_only {
                obj.insert(
                    "value".to_string(),
                    Value::String("[REDACTED_HTTPONLY]".to_string()),
                );
                obj.insert("redacted".to_string(), Value::Bool(true));
            }
        }
    }
}

fn strip_data_url_prefix(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(idx) = trimmed.find(";base64,") {
        if trimmed[..idx].starts_with("data:") {
            return &trimmed[idx + 8..];
        }
    }
    trimmed
}


// ----------------------------------------------------------------------------
// Audio TTS / STT, Vision, ImageGen, VideoGen
// ----------------------------------------------------------------------------

/// Synthesizes deterministic PCM/RIFF WAVE speech cadence audio in pure Rust.
pub fn synthesize_speech_wav(text: &str, sample_rate: u32) -> Result<(Vec<u8>, u64, Vec<u8>), String> {
    let sr = sample_rate.clamp(8000, 48000);
    let chars: Vec<char> = text.chars().collect();
    let syllable_ms = 75usize;
    let samples_per_syl = (sr as usize * syllable_ms) / 1000;
    let min_syls = 4usize;
    let syl_count = chars.len().clamp(min_syls, 240);
    let mut pcm = Vec::with_capacity(syl_count * samples_per_syl);

    for idx in 0..syl_count {
        let ch = chars.get(idx).copied().unwrap_or(' ');
        let is_pause = ch.is_whitespace() || matches!(ch, ',' | '.' | '!' | '?' | ';' | '，' | '。');
        let code = ch as u32;
        let base_freq = 160.0 + ((code % 19) as f64) * 14.0;
        let formant2 = base_freq * 2.25;
        for s in 0..samples_per_syl {
            if is_pause {
                pcm.push(0);
                continue;
            }
            let t = s as f64 / sr as f64;
            let phase = s as f64 / samples_per_syl as f64;
            // Smooth Hann-like syllable amplitude envelope
            let env = (std::f64::consts::PI * phase).sin().powf(0.8);
            let wave = 0.65 * (2.0 * std::f64::consts::PI * base_freq * t).sin()
                + 0.35 * (2.0 * std::f64::consts::PI * formant2 * t).sin();
            let amp = (wave * env * 12000.0).clamp(-32767.0, 32767.0) as i16;
            pcm.push(amp);
        }
    }

    let wav_bytes = encode_wav_i16(&pcm, sr, 1).map_err(|e| e.to_string())?;
    let duration_ms = ((pcm.len() as u64) * 1000) / (sr as u64);
    let (_, packed_waveform) = waveform_from_pcm_i16(&pcm);
    Ok((wav_bytes, duration_ms, packed_waveform))
}

async fn tool_text_to_speech(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(text) = args.get("text").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) else {
        return HermesToolResult::err("text_to_speech", "Missing required 'text' parameter");
    };
    let provider = args
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("local")
        .trim()
        .to_ascii_lowercase();
    let voice = args
        .get("voice")
        .and_then(|v| v.as_str())
        .unwrap_or("alloy");
    let sample_rate = args
        .get("sample_rate")
        .and_then(|v| v.as_u64())
        .unwrap_or(16_000) as u32;

    let mut used_provider = "local_pcm_riff".to_string();
    let mut mime = "audio/wav".to_string();
    let mut ext = "wav";
    let mut audio_bytes: Option<Vec<u8>> = None;
    let mut duration_ms = 0u64;
    let mut waveform_b64 = None;

    if matches!(provider.as_str(), "openai" | "auto") {
        if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
            if !api_key.trim().is_empty() {
                if let Ok(resp) = ctx
                    .http_client
                    .post("https://api.openai.com/v1/audio/speech")
                    .bearer_auth(api_key)
                    .json(&json!({
                        "model": "gpt-4o-mini-tts",
                        "voice": voice,
                        "input": text,
                        "response_format": "wav"
                    }))
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes().await {
                            audio_bytes = Some(bytes.to_vec());
                            used_provider = "openai".into();
                        }
                    }
                }
            }
        }
    } else if provider == "elevenlabs" {
        if let Ok(api_key) = std::env::var("ELEVENLABS_API_KEY") {
            if !api_key.trim().is_empty() {
                let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}");
                if let Ok(resp) = ctx
                    .http_client
                    .post(&url)
                    .header("xi-api-key", api_key)
                    .json(&json!({ "text": text }))
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes().await {
                            audio_bytes = Some(bytes.to_vec());
                            used_provider = "elevenlabs".into();
                            mime = "audio/mpeg".into();
                            ext = "mp3";
                        }
                    }
                }
            }
        }
    }

    if audio_bytes.is_none() {
        match synthesize_speech_wav(text, sample_rate) {
            Ok((wav, dur, wf)) => {
                audio_bytes = Some(wav);
                duration_ms = dur;
                waveform_b64 = Some(base64_encode(&wf));
                if provider != "local" && provider != "auto" {
                    used_provider = format!("{provider}_fallback_local_wav");
                }
            }
            Err(e) => return HermesToolResult::err("text_to_speech", e),
        }
    }

    let bytes = audio_bytes.unwrap_or_default();
    let mut saved_path = None;
    if let Some(raw_path) = args.get("output_path").and_then(|v| v.as_str()) {
        let resolved = match ctx.security.read() {
            Ok(sec) => match sec.validate_path(Path::new(raw_path)) {
                Ok(p) => p,
                Err(e) => return HermesToolResult::err("text_to_speech", e),
            },
            Err(_) => return HermesToolResult::err("text_to_speech", "SecurityEngine lock poisoned"),
        };
        if let Some(parent) = resolved.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::write(&resolved, &bytes) {
            return HermesToolResult::err("text_to_speech", format!("Failed writing TTS audio: {e}"));
        }
        saved_path = Some(resolved.display().to_string());
    }

    let is_riff_wave = bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE";
    let b64 = base64_encode(&bytes);

    HermesToolResult::ok(
        "text_to_speech",
        format!(
            "Synthesized {} bytes ({}) via {} [duration_ms={}]",
            bytes.len(),
            if is_riff_wave { "RIFF/WAVE" } else { mime.as_str() },
            used_provider,
            duration_ms
        ),
        Some(json!({
            "provider": used_provider,
            "voice": voice,
            "mime_type": mime,
            "byte_len": bytes.len(),
            "sample_rate": sample_rate,
            "duration_ms": duration_ms,
            "is_riff_wave": is_riff_wave,
            "output_path": saved_path,
            "waveform_base64": waveform_b64,
        })),
    )
    .with_artifact(HermesToolArtifact {
        kind: "audio".into(),
        name: format!("tts_output.{ext}"),
        mime_type: mime,
        path: saved_path,
        data_base64: Some(b64),
        metadata: json!({ "sample_rate": sample_rate, "duration_ms": duration_ms }),
    })
}

async fn tool_speech_to_text(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let provider = args
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("local")
        .to_ascii_lowercase();
    let language = args
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("en");

    let audio_bytes = if let Some(b64) = args.get("audio_base64").and_then(|v| v.as_str()) {
        match base64_decode(b64) {
            Ok(b) => b,
            Err(e) => return HermesToolResult::err("speech_to_text", format!("Invalid audio_base64: {e}")),
        }
    } else if let Some(raw_path) = args.get("audio_path").and_then(|v| v.as_str()) {
        let resolved = match ctx.security.read() {
            Ok(sec) => match sec.validate_path(Path::new(raw_path)) {
                Ok(p) => p,
                Err(e) => return HermesToolResult::err("speech_to_text", e),
            },
            Err(_) => return HermesToolResult::err("speech_to_text", "SecurityEngine lock poisoned"),
        };
        match fs::read(&resolved) {
            Ok(b) => b,
            Err(e) => return HermesToolResult::err("speech_to_text", format!("Failed reading audio: {e}")),
        }
    } else {
        return HermesToolResult::err("speech_to_text", "Provide 'audio_path' or 'audio_base64'");
    };

    if matches!(provider.as_str(), "openai" | "whisper") {
        if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
            if !api_key.trim().is_empty() {
                let part = reqwest::multipart::Part::bytes(audio_bytes.clone())
                    .file_name("audio.wav")
                    .mime_str("audio/wav");
                if let Ok(file_part) = part {
                    let form = reqwest::multipart::Form::new()
                        .text("model", "whisper-1")
                        .text("language", language.to_string())
                        .part("file", file_part);
                    if let Ok(resp) = ctx
                        .http_client
                        .post("https://api.openai.com/v1/audio/transcriptions")
                        .bearer_auth(api_key)
                        .multipart(form)
                        .send()
                        .await
                    {
                        if resp.status().is_success() {
                            if let Ok(body) = resp.json::<Value>().await {
                                let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                return HermesToolResult::ok(
                                    "speech_to_text",
                                    text.clone(),
                                    Some(json!({
                                        "provider": "openai_whisper",
                                        "transcript": text,
                                        "confidence": 0.95,
                                        "language": language,
                                    })),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // Local WAV PCM inspection & deterministic STT adapter
    if let Ok(decoded) = decode_wav_pcm(&audio_bytes) {
        let rms = compute_pcm_rms_level(&decoded.samples);
        let confidence = if rms > 100 { 0.88 } else { 0.42 };
        let transcript = if rms <= 20 {
            "[silence detected in audio buffer]".to_string()
        } else {
            format!(
                "[local audio segment: {}ms @ {}Hz, {}ch, rms={}]",
                decoded.duration_ms, decoded.sample_rate, decoded.channels, rms
            )
        };
        return HermesToolResult::ok(
            "speech_to_text",
            transcript.clone(),
            Some(json!({
                "provider": "local_wav_stt",
                "transcript": transcript,
                "confidence": confidence,
                "duration_ms": decoded.duration_ms,
                "sample_rate": decoded.sample_rate,
                "channels": decoded.channels,
                "rms_level": rms,
                "language": language,
            })),
        );
    }

    HermesToolResult::ok(
        "speech_to_text",
        format!("[local audio payload ({} bytes); configure OPENAI_API_KEY or pass WAV PCM for full transcription]", audio_bytes.len()),
        Some(json!({
            "provider": "local_stt_fallback",
            "transcript": "",
            "confidence": 0.5,
            "duration_ms": 0,
            "byte_len": audio_bytes.len(),
            "language": language,
        })),
    )
}

async fn tool_vision_analyze(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(prompt) = args.get("prompt").and_then(|v| v.as_str()) else {
        return HermesToolResult::err("vision_analyze", "Missing required 'prompt'");
    };
    let detail = args.get("detail").and_then(|v| v.as_str()).unwrap_or("auto");

    if let Some(image_url) = args.get("image_url").and_then(|v| v.as_str()) {
        let payload = json!({
            "type": "image_url",
            "image_url": { "url": image_url, "detail": detail }
        });
        return HermesToolResult::ok(
            "vision_analyze",
            format!("Prepared multimodal vision inspection payload for URL '{image_url}' with prompt: {prompt}"),
            Some(json!({
                "prompt": prompt,
                "source": "url",
                "openai_block": payload,
            })),
        );
    }

    let bytes = if let Some(b64) = args.get("image_base64").and_then(|v| v.as_str()) {
        match base64_decode(b64) {
            Ok(b) => b,
            Err(e) => return HermesToolResult::err("vision_analyze", format!("Invalid image_base64: {e}")),
        }
    } else if let Some(raw_path) = args.get("image_path").and_then(|v| v.as_str()) {
        let resolved = match ctx.security.read() {
            Ok(sec) => match sec.validate_path(Path::new(raw_path)) {
                Ok(p) => p,
                Err(e) => return HermesToolResult::err("vision_analyze", e),
            },
            Err(_) => return HermesToolResult::err("vision_analyze", "SecurityEngine lock poisoned"),
        };
        match fs::read(&resolved) {
            Ok(b) => b,
            Err(e) => return HermesToolResult::err("vision_analyze", format!("Failed reading image: {e}")),
        }
    } else {
        return HermesToolResult::err(
            "vision_analyze",
            "Provide 'image_path', 'image_base64', or 'image_url'",
        );
    };

    let (width, height, format, has_alpha) = match ThumbnailGenerator::probe_metadata(&bytes) {
        Ok(meta) => (meta.width, meta.height, meta.format, meta.has_alpha),
        Err(_) => probe_basic_image_header(&bytes),
    };

    let mime = match format.as_str() {
        "png" => "image/png",
        "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    let b64 = base64_encode(&bytes);

    let openai_block = json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{mime};base64,{b64}"), "detail": detail }
    });
    let anthropic_block = json!({
        "type": "image",
        "source": { "type": "base64", "media_type": mime, "data": b64 }
    });

    HermesToolResult::ok(
        "vision_analyze",
        format!(
            "Inspected {format} image ({width}x{height}, has_alpha={has_alpha}, {} bytes) for prompt: {prompt}",
            bytes.len()
        ),
        Some(json!({
            "width": width,
            "height": height,
            "format": format,
            "has_alpha": has_alpha,
            "byte_len": bytes.len(),
            "mime_type": mime,
            "openai_block": openai_block,
            "anthropic_block": anthropic_block,
        })),
    )
}

fn probe_basic_image_header(bytes: &[u8]) -> (u32, u32, String, bool) {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return (w, h, "png".into(), true);
    }
    if bytes.starts_with(b"GIF8") && bytes.len() >= 10 {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return (w, h, "gif".into(), true);
    }
    let text_prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    if text_prefix.contains("<svg") {
        return (512, 512, "svg".into(), true);
    }
    (0, 0, "unknown".into(), false)
}

async fn tool_image_generate(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(prompt) = args.get("prompt").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) else {
        return HermesToolResult::err("image_generate", "Missing required 'prompt'");
    };
    let size = args.get("size").and_then(|v| v.as_str()).unwrap_or("512x512");
    let provider = args
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("local")
        .to_ascii_lowercase();
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("svg")
        .to_ascii_lowercase();

    let (w, h) = parse_size_dims(size);

    if matches!(provider.as_str(), "openai" | "auto") {
        if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
            if !api_key.trim().is_empty() {
                if let Ok(resp) = ctx
                    .http_client
                    .post("https://api.openai.com/v1/images/generations")
                    .bearer_auth(api_key)
                    .json(&json!({
                        "model": "gpt-image-1",
                        "prompt": prompt,
                        "size": size,
                        "response_format": "b64_json"
                    }))
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.json::<Value>().await {
                            if let Some(b64) = body
                                .get("data")
                                .and_then(|d| d.get(0))
                                .and_then(|i| i.get("b64_json"))
                                .and_then(|v| v.as_str())
                            {
                                let bytes = base64_decode(b64).unwrap_or_default();
                                let saved = maybe_write_asset(args.get("output_path").and_then(|v| v.as_str()), &bytes, ctx);
                                return HermesToolResult::ok(
                                    "image_generate",
                                    format!("Generated OpenAI image ({} bytes)", bytes.len()),
                                    Some(json!({ "provider": "openai", "format": "png", "output_path": saved })),
                                )
                                .with_artifact(HermesToolArtifact {
                                    kind: "image".into(),
                                    name: "generated.png".into(),
                                    mime_type: "image/png".into(),
                                    path: saved,
                                    data_base64: Some(b64.to_string()),
                                    metadata: json!({ "prompt": prompt, "size": size }),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    let (bytes, mime, filename) = if format == "png" {
        (generate_deterministic_png(prompt, w.min(256), h.min(256)), "image/png", "generated.png")
    } else {
        let svg = generate_deterministic_svg(prompt, w, h);
        (svg.into_bytes(), "image/svg+xml", "generated.svg")
    };

    let saved = maybe_write_asset(args.get("output_path").and_then(|v| v.as_str()), &bytes, ctx);
    let b64 = base64_encode(&bytes);

    HermesToolResult::ok(
        "image_generate",
        format!("Generated local {format} placeholder image ({w}x{h}, {} bytes) for '{prompt}'", bytes.len()),
        Some(json!({
            "provider": "local_deterministic",
            "format": format,
            "width": w,
            "height": h,
            "byte_len": bytes.len(),
            "output_path": saved,
        })),
    )
    .with_artifact(HermesToolArtifact {
        kind: "image".into(),
        name: filename.into(),
        mime_type: mime.into(),
        path: saved,
        data_base64: Some(b64),
        metadata: json!({ "prompt": prompt, "width": w, "height": h }),
    })
}

async fn tool_video_generate(args: Value, ctx: &HermesToolContext) -> HermesToolResult {
    let Some(prompt) = args.get("prompt").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) else {
        return HermesToolResult::err("video_generate", "Missing required 'prompt'");
    };
    let duration_secs = args
        .get("duration_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(4);
    let resolution = args
        .get("resolution")
        .and_then(|v| v.as_str())
        .unwrap_or("1280x720");

    let storyboard_svg = generate_deterministic_svg(
        &format!("VIDEO ({duration_secs}s @ {resolution}): {prompt}"),
        640,
        360,
    );
    let manifest = json!({
        "provider": "local_storyboard",
        "prompt": prompt,
        "duration_secs": duration_secs,
        "resolution": resolution,
        "frames": [
            { "t": 0.0, "description": format!("Opening scene: {prompt}") },
            { "t": (duration_secs as f64) * 0.5, "description": format!("Midpoint progression: {prompt}") },
            { "t": duration_secs as f64, "description": format!("Closing frame: {prompt}") },
        ],
        "preview_svg_base64": base64_encode(storyboard_svg.as_bytes()),
    });

    let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap_or_default();
    let saved = maybe_write_asset(args.get("output_path").and_then(|v| v.as_str()), &manifest_bytes, ctx);

    HermesToolResult::ok(
        "video_generate",
        format!(
            "Generated offline video storyboard manifest ({duration_secs}s @ {resolution}) for '{prompt}'"
        ),
        Some(manifest),
    )
    .with_artifact(HermesToolArtifact {
        kind: "video_storyboard".into(),
        name: "storyboard.svg".into(),
        mime_type: "image/svg+xml".into(),
        path: saved,
        data_base64: Some(base64_encode(storyboard_svg.as_bytes())),
        metadata: json!({ "duration_secs": duration_secs, "resolution": resolution }),
    })
}

fn maybe_write_asset(
    raw_path: Option<&str>,
    bytes: &[u8],
    ctx: &HermesToolContext,
) -> Option<String> {
    let raw = raw_path?;
    let sec = ctx.security.read().ok()?;
    let resolved = sec.validate_path(Path::new(raw)).ok()?;
    if let Some(parent) = resolved.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&resolved, bytes).ok()?;
    Some(resolved.display().to_string())
}

fn parse_size_dims(size: &str) -> (u32, u32) {
    if let Some((a, b)) = size.split_once('x') {
        if let (Ok(w), Ok(h)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
            return (w.clamp(16, 2048), h.clamp(16, 2048));
        }
    }
    (512, 512)
}

fn generate_deterministic_svg(prompt: &str, w: u32, h: u32) -> String {
    let hash = prompt.bytes().fold(5381u32, |acc, b| acc.wrapping_mul(33).wrapping_add(b as u32));
    let hue = hash % 360;
    let escaped = prompt
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">\
<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">\
<stop offset=\"0%\" stop-color=\"hsl({hue},65%,28%)\"/>\
<stop offset=\"100%\" stop-color=\"hsl({},70%,48%)\"/>\
</linearGradient></defs>\
<rect width=\"{w}\" height=\"{h}\" fill=\"url(#g)\"/>\
<text x=\"50%\" y=\"50%\" dominant-baseline=\"middle\" text-anchor=\"middle\" fill=\"#ffffff\" font-family=\"sans-serif\" font-size=\"18\">{escaped}</text>\
</svg>",
        (hue + 55) % 360
    )
}

/// Encodes a valid uncompressed RGBA PNG in pure Rust (`\x89PNG...`).
fn generate_deterministic_png(prompt: &str, w: u32, h: u32) -> Vec<u8> {
    let hash = prompt.bytes().fold(5381u32, |acc, b| acc.wrapping_mul(33).wrapping_add(b as u32));
    let r_base = (hash & 0xFF) as u8;
    let g_base = ((hash >> 8) & 0xFF) as u8;
    let b_base = ((hash >> 16) & 0xFF) as u8;

    let mut raw_scanlines = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
    for y in 0..h {
        raw_scanlines.push(0); // Filter type 0 (None)
        for x in 0..w {
            raw_scanlines.push(r_base.wrapping_add(((x * 255) / w.max(1)) as u8 / 2));
            raw_scanlines.push(g_base.wrapping_add(((y * 255) / h.max(1)) as u8 / 2));
            raw_scanlines.push(b_base);
            raw_scanlines.push(255);
        }
    }

    // Wrap raw scanlines in uncompressed DEFLATE stored blocks inside a zlib stream
    let mut zlib = Vec::new();
    zlib.push(0x78);
    zlib.push(0x01);
    let chunks: Vec<&[u8]> = raw_scanlines.chunks(65535).collect();
    for (idx, chunk) in chunks.iter().enumerate() {
        let is_last = idx + 1 == chunks.len();
        zlib.push(if is_last { 0x01 } else { 0x00 });
        let len = chunk.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(chunk);
    }
    let adler = adler32(&raw_scanlines);
    zlib.extend_from_slice(&adler.to_be_bytes());

    let mut png = Vec::new();
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
    push_png_chunk(&mut png, b"IHDR", &ihdr);
    push_png_chunk(&mut png, b"IDAT", &zlib);
    push_png_chunk(&mut png, b"IEND", &[]);
    png
}

fn push_png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(tag);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut s1, mut s2) = (1u32, 0u32);
    for &b in data {
        s1 = (s1 + b as u32) % 65521;
        s2 = (s2 + s1) % 65521;
    }
    (s2 << 16) | s1
}

// ----------------------------------------------------------------------------
// Pure-Rust Base64 Codec (zero external dependencies)
// ----------------------------------------------------------------------------

pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.len() % 4 != 0 {
        return Err("Invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (idx, &ch) in chunk.iter().enumerate() {
            if ch == b'=' {
                pad += 1;
                vals[idx] = 0;
            } else {
                vals[idx] = match ch {
                    b'A'..=b'Z' => ch - b'A',
                    b'a'..=b'z' => ch - b'a' + 26,
                    b'0'..=b'9' => ch - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => return Err(format!("Invalid base64 byte '{}'", ch as char)),
                };
            }
        }
        let n = ((vals[0] as u32) << 18)
            | ((vals[1] as u32) << 12)
            | ((vals[2] as u32) << 6)
            | (vals[3] as u32);
        out.push(((n >> 16) & 0xFF) as u8);
        if pad < 2 {
            out.push(((n >> 8) & 0xFF) as u8);
        }
        if pad < 1 {
            out.push((n & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::toolsets::HermesToolExecutor;

    #[test]
    fn test_html_to_markdown_and_base64() {
        let html = "<html><head><title>Doc Title</title><script>evil()</script></head><body><h1>Hello</h1><p>Visit <a href=\"https://example.com\">Docs</a> &amp; test.</p><ul><li>Item 1</li></ul></body></html>";
        let ex = html_to_markdown(html, true);
        assert_eq!(ex.title, "Doc Title");
        assert!(ex.markdown.contains("# Hello"));
        assert!(ex.markdown.contains("[Docs](https://example.com)"));
        assert!(ex.markdown.contains("- Item 1"));
        assert!(!ex.markdown.contains("evil()"));

        let b = b"RIFF1234WAVE";
        assert_eq!(base64_decode(&base64_encode(b)).unwrap(), b);
    }

    #[tokio::test]
    async fn test_tts_riff_wave_and_stt_and_vision_and_image_gen() {
        let tmp = std::env::temp_dir().join(format!("hermes_media_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&tmp).unwrap();
        let ctx = HermesToolContext::new(&tmp);

        let tts = HermesToolExecutor::execute(
            "text_to_speech",
            json!({ "text": "Hello Hermes", "provider": "local", "output_path": "speech.wav" }),
            &ctx,
        )
        .await;
        assert!(tts.success, "{}", tts.output);
        let wav_bytes = fs::read(tmp.join("speech.wav")).unwrap();
        assert_eq!(&wav_bytes[0..4], b"RIFF");
        assert_eq!(&wav_bytes[8..12], b"WAVE");

        let stt = HermesToolExecutor::execute(
            "speech_to_text",
            json!({ "audio_path": "speech.wav", "provider": "local" }),
            &ctx,
        )
        .await;
        assert!(stt.success, "{}", stt.output);
        assert!(stt.structured.unwrap()["duration_ms"].as_i64().unwrap() > 0);

        let img = HermesToolExecutor::execute(
            "image_generate",
            json!({ "prompt": "Sunset mountain", "format": "png", "size": "64x64", "output_path": "out.png" }),
            &ctx,
        )
        .await;
        assert!(img.success, "{}", img.output);

        let vis = HermesToolExecutor::execute(
            "vision_analyze",
            json!({ "prompt": "Describe colors", "image_path": "out.png" }),
            &ctx,
        )
        .await;
        assert!(vis.success, "{}", vis.output);
        assert_eq!(vis.structured.unwrap()["width"], 64);

        let _ = fs::remove_dir_all(&tmp);
    }
}
