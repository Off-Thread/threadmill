// HTML kernels: sanitize (ammonia), markdown -> HTML (comrak), HTML -> text
// (html2text), CSS-selector extraction (scraper).
//
// Stage helpers (`*Cfg` + `compile_*` + `apply_*`) are pub(crate) so the
// pipeline can reuse them: configs are validated/compiled ONCE and shared
// read-only across rayon threads (every `*Cfg` here is Send + Sync — the
// batch kernels prove it at compile time by sharing one across par_iter).
// ammonia's `Builder<'a>` borrows its whitelist strings, so `SanitizeHtmlCfg`
// stores owned config and rebuilds the Builder per item — that is a handful
// of small HashSet inserts, noise next to parsing the HTML being cleaned.

use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;
use std::collections::HashMap;

// ---------------------------------------------------------------- stage helpers: sanitizeHtml

/// Compiled once; shared read-only across rayon threads. Owned strings only —
/// `apply_sanitize_html` rebuilds the borrowing `ammonia::Builder` per item.
pub(crate) struct SanitizeHtmlCfg {
    allowed_tags: Option<Vec<String>>,
    /// Per-tag attribute whitelist (the `"*"` key is split into `generic_attrs`).
    tag_attrs: Option<Vec<(String, Vec<String>)>>,
    generic_attrs: Option<Vec<String>>,
    url_schemes: Option<Vec<String>>,
    strip_comments: Option<bool>,
    /// The policy explicitly allows a user-supplied `rel` attribute, which
    /// contradicts ammonia's default forced `rel="noopener noreferrer"` on
    /// links (ammonia panics on that combination) — so we turn link_rel off.
    link_rel_off: bool,
}

fn no_empty(list: &[String], what: &str) -> std::result::Result<(), String> {
    if list.iter().any(|s| s.is_empty()) {
        return Err(format!("sanitizeHtml: {what} must not contain empty strings"));
    }
    Ok(())
}

/// Errors: "sanitizeHtml: {cause}" (empty strings anywhere in the policy).
/// `allowed_attrs` semantics: key = tag name, value = allowed attributes for
/// that tag; the special key `"*"` allows attributes on every tag. A present
/// `allowed_attrs` REPLACES ammonia's WHOLE attribute whitelist — both the
/// per-tag map and the generic set (`lang`/`title` by default), so without a
/// `"*"` key no generic attributes survive. Other present lists likewise
/// replace their ammonia default.
pub(crate) fn compile_sanitize_html(
    allowed_tags: Option<Vec<String>>,
    allowed_attrs: Option<HashMap<String, Vec<String>>>,
    url_schemes: Option<Vec<String>>,
    strip_comments: Option<bool>,
) -> std::result::Result<SanitizeHtmlCfg, String> {
    if let Some(tags) = &allowed_tags {
        no_empty(tags, "allowedTags")?;
    }
    if let Some(schemes) = &url_schemes {
        no_empty(schemes, "urlSchemes")?;
    }
    let mut tag_attrs: Option<Vec<(String, Vec<String>)>> = None;
    let mut generic_attrs: Option<Vec<String>> = None;
    let mut link_rel_off = false;
    if let Some(map) = allowed_attrs {
        let mut per_tag = Vec::with_capacity(map.len());
        for (tag, attrs) in map {
            if tag.is_empty() {
                return Err("sanitizeHtml: allowedAttrs keys must not be empty".to_string());
            }
            no_empty(&attrs, "allowedAttrs values")?;
            // A user-controlled rel on links contradicts ammonia's forced
            // link rel (a documented Builder::clean panic) — disable the latter.
            if attrs.iter().any(|a| a == "rel") && (tag == "*" || tag == "a") {
                link_rel_off = true;
            }
            if tag == "*" {
                generic_attrs = Some(attrs);
            } else {
                per_tag.push((tag, attrs));
            }
        }
        if !per_tag.is_empty() {
            tag_attrs = Some(per_tag);
        }
        // allowedAttrs is the whole attribute policy: without a "*" key the
        // generic whitelist (ammonia default: lang/title) is emptied, so
        // nothing survives that the policy didn't name.
        if generic_attrs.is_none() {
            generic_attrs = Some(Vec::new());
        }
    }
    Ok(SanitizeHtmlCfg {
        allowed_tags,
        tag_attrs,
        generic_attrs,
        url_schemes,
        strip_comments,
        link_rel_off,
    })
}

/// Infallible (ammonia never fails); Result-shaped for uniform stage wiring.
pub(crate) fn apply_sanitize_html(
    cfg: &SanitizeHtmlCfg,
    input: &str,
) -> std::result::Result<String, String> {
    let mut b = ammonia::Builder::default();
    if let Some(tags) = &cfg.allowed_tags {
        // Explicitly allowed tags must leave ammonia's strip-with-content
        // blacklist (script/style by default) — overlap is a clean() panic.
        b.rm_clean_content_tags(tags.iter());
        b.tags(tags.iter().map(String::as_str).collect());
    }
    if let Some(per_tag) = &cfg.tag_attrs {
        b.rm_clean_content_tags(per_tag.iter().map(|(t, _)| t));
        b.tag_attributes(
            per_tag
                .iter()
                .map(|(t, attrs)| (t.as_str(), attrs.iter().map(String::as_str).collect()))
                .collect(),
        );
    }
    if let Some(generic) = &cfg.generic_attrs {
        b.generic_attributes(generic.iter().map(String::as_str).collect());
    }
    if cfg.link_rel_off {
        b.link_rel(None);
    }
    if let Some(schemes) = &cfg.url_schemes {
        b.url_schemes(schemes.iter().map(String::as_str).collect());
    }
    if let Some(strip) = cfg.strip_comments {
        b.strip_comments(strip);
    }
    Ok(b.clean(input).to_string())
}

// ---------------------------------------------------------------- stage helpers: markdownToHtml

/// Compiled once; comrak options are plain data (Send + Sync), shared
/// read-only across rayon threads.
pub(crate) struct MarkdownToHtmlCfg {
    options: comrak::Options<'static>,
}

/// Infallible: every field is a bool with a default. `gfm` (default true)
/// enables the GFM extension set (strikethrough, tagfilter, table, autolink,
/// tasklist); `tables` (default = gfm) toggles tables independently;
/// `raw_html` false (the default) escapes raw HTML instead of passing it
/// through — pair with sanitizeHtml when enabling it.
pub(crate) fn compile_markdown_to_html(
    gfm: Option<bool>,
    tables: Option<bool>,
    footnotes: Option<bool>,
    smart_punct: Option<bool>,
    raw_html: Option<bool>,
) -> MarkdownToHtmlCfg {
    let gfm = gfm.unwrap_or(true);
    let raw = raw_html.unwrap_or(false);
    let mut options = comrak::Options::default();
    if gfm {
        options.extension.strikethrough = true;
        options.extension.tagfilter = true;
        options.extension.autolink = true;
        options.extension.tasklist = true;
    }
    options.extension.table = tables.unwrap_or(gfm);
    options.extension.footnotes = footnotes.unwrap_or(false);
    options.parse.smart = smart_punct.unwrap_or(false);
    options.render.r#unsafe = raw;
    // Raw HTML that isn't passed through is escaped (visible, greppable)
    // rather than comrak's default "<!-- raw HTML omitted -->" placeholder.
    options.render.escape = !raw;
    MarkdownToHtmlCfg { options }
}

/// Infallible (comrak never fails); Result-shaped for uniform stage wiring.
pub(crate) fn apply_markdown_to_html(
    cfg: &MarkdownToHtmlCfg,
    input: &str,
) -> std::result::Result<String, String> {
    Ok(comrak::markdown_to_html(input, &cfg.options))
}

// ---------------------------------------------------------------- stage helpers: htmlToText

/// Compiled once; shared read-only across rayon threads.
pub(crate) struct HtmlToTextCfg {
    width: usize,
}

/// Errors: "htmlToText: width must be 1-1000, got {w}".
pub(crate) fn compile_html_to_text(width: Option<i64>) -> std::result::Result<HtmlToTextCfg, String> {
    let width = width.unwrap_or(80);
    if !(1..=1000).contains(&width) {
        return Err(format!("htmlToText: width must be 1-1000, got {width}"));
    }
    Ok(HtmlToTextCfg {
        width: width as usize,
    })
}

/// Errors: "htmlToText: {cause}" (e.g. output width too narrow for the content).
pub(crate) fn apply_html_to_text(
    cfg: &HtmlToTextCfg,
    input: &str,
) -> std::result::Result<String, String> {
    html2text::from_read(input.as_bytes(), cfg.width).map_err(|e| format!("htmlToText: {e}"))
}

// ---------------------------------------------------------------- stage helpers: htmlExtract

pub(crate) enum HtmlExtractMode {
    Text,
    Html,
    Attr(String),
}

/// Errors: "htmlExtract: {cause}" for an unknown keyword or empty attr name.
pub(crate) fn parse_html_extract_mode(
    keyword: Option<&str>,
    attr: Option<String>,
) -> std::result::Result<HtmlExtractMode, String> {
    match (keyword, attr) {
        (None, Some(a)) if !a.is_empty() => Ok(HtmlExtractMode::Attr(a)),
        (None, Some(_)) => Err("htmlExtract: attr must not be empty".to_string()),
        (Some("text"), None) => Ok(HtmlExtractMode::Text),
        (Some("html"), None) => Ok(HtmlExtractMode::Html),
        (Some(other), None) => Err(format!(
            "htmlExtract: extract must be 'text', 'html', or {{attr}}, got '{other}'"
        )),
        _ => Err("htmlExtract: extract must be 'text', 'html', or {attr}".to_string()),
    }
}

/// Compiled once (the selector parse is the expensive part); Send + Sync,
/// shared read-only across rayon threads.
pub(crate) struct HtmlExtractCfg {
    selector: scraper::Selector,
    mode: HtmlExtractMode,
    all: bool,
}

/// Errors: "htmlExtract: invalid selector '{selector}': {cause}".
pub(crate) fn compile_html_extract(
    selector: &str,
    mode: HtmlExtractMode,
    all: bool,
) -> std::result::Result<HtmlExtractCfg, String> {
    let parsed = scraper::Selector::parse(selector)
        .map_err(|e| format!("htmlExtract: invalid selector '{selector}': {e}"))?;
    Ok(HtmlExtractCfg {
        selector: parsed,
        mode,
        all,
    })
}

fn extract_one(mode: &HtmlExtractMode, el: scraper::ElementRef) -> Option<String> {
    match mode {
        HtmlExtractMode::Text => Some(el.text().collect()),
        HtmlExtractMode::Html => Some(el.html()),
        HtmlExtractMode::Attr(name) => el.attr(name).map(str::to_owned),
    }
}

/// all=false: first match ('' when nothing matches, or the first match lacks
/// the attr). all=true: a JSON array string, one entry per match (missing
/// attr -> null). Errors: "htmlExtract: invalid utf-8: {cause}" for byte
/// input that is not UTF-8.
pub(crate) fn apply_html_extract(
    cfg: &HtmlExtractCfg,
    input: &[u8],
) -> std::result::Result<String, String> {
    let src =
        std::str::from_utf8(input).map_err(|e| format!("htmlExtract: invalid utf-8: {e}"))?;
    // Html (non-atomic tendrils, !Send) lives and dies on this rayon thread.
    let doc = scraper::Html::parse_document(src);
    let mut matches = doc.select(&cfg.selector);
    if cfg.all {
        let out: Vec<Option<String>> = matches.map(|el| extract_one(&cfg.mode, el)).collect();
        serde_json::to_string(&out).map_err(|e| format!("htmlExtract: {e}"))
    } else {
        Ok(matches
            .next()
            .and_then(|el| extract_one(&cfg.mode, el))
            .unwrap_or_default())
    }
}

// ---------------------------------------------------------------- batch kernels

/// Sanitization policy for sanitizeHtmlBatch. Every provided field REPLACES
/// the corresponding ammonia default; omitted fields keep ammonia defaults.
/// `allowedAttrs` maps tag name -> allowed attributes and is the WHOLE
/// attribute policy when present ("*" = any tag; without a "*" key even
/// ammonia's default generic attributes lang/title are dropped).
#[napi(object)]
pub struct SanitizeHtmlPolicy {
    pub allowed_tags: Option<Vec<String>>,
    pub allowed_attrs: Option<HashMap<String, Vec<String>>>,
    pub url_schemes: Option<Vec<String>>,
    pub strip_comments: Option<bool>,
}

/// Options for markdownToHtmlBatch. `gfm` defaults true; `unsafe` defaults
/// false (raw HTML in the markdown is escaped — enable it only together with
/// sanitizeHtmlBatch on the output).
#[napi(object)]
pub struct MarkdownHtmlOptions {
    pub gfm: Option<bool>,
    pub tables: Option<bool>,
    pub footnotes: Option<bool>,
    pub smart_punct: Option<bool>,
    #[napi(js_name = "unsafe")]
    pub unsafe_: Option<bool>,
}

/// Options for htmlToTextBatch. `width` = output wrap column, 1-1000, default 80.
#[napi(object)]
pub struct HtmlToTextOptions {
    pub width: Option<i64>,
}

/// The `{attr: string}` form of HtmlExtractConfig.extract.
#[napi(object)]
pub struct HtmlExtractAttr {
    pub attr: String,
}

/// Config for htmlExtractBatch. `selector` is parsed once on the JS thread
/// (invalid selectors throw synchronously with status InvalidArg).
#[napi(object)]
pub struct HtmlExtractConfig {
    pub selector: String,
    #[napi(ts_type = "'text' | 'html' | { attr: string }")]
    pub extract: Either<String, HtmlExtractAttr>,
    pub all: Option<bool>,
}

// Strings arrive as owned copies (napi converts on the JS thread), so they
// are safe to move straight onto rayon threads — no V8 memory involved.
fn run_str_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    f: impl Fn(&str) -> std::result::Result<String, String> + Send + Sync + 'static,
) -> Result<Object<'env>> {
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = items
            .par_iter()
            .enumerate()
            .map(|(i, s)| f(s).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// sanitizeHtmlBatch(items: string[], policy?: SanitizeHtmlPolicy): Promise<string[]>
///
/// ammonia sanitization. No policy = ammonia defaults (scripts/styles and
/// event handlers stripped, conservative tag/attribute/scheme whitelists,
/// comments stripped, links get rel="noopener noreferrer"). Invalid policies
/// throw synchronously with status InvalidArg.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn sanitize_html_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    policy: Option<SanitizeHtmlPolicy>,
) -> Result<Object<'env>> {
    let cfg = match policy {
        None => compile_sanitize_html(None, None, None, None),
        Some(p) => {
            compile_sanitize_html(p.allowed_tags, p.allowed_attrs, p.url_schemes, p.strip_comments)
        }
    }
    .map_err(|e| Error::new(Status::InvalidArg, e))?;
    run_str_batch(env, items, move |s| apply_sanitize_html(&cfg, s))
}

/// markdownToHtmlBatch(items: string[], opts?: MarkdownHtmlOptions): Promise<string[]>
///
/// comrak (CommonMark). gfm=true by default (strikethrough, tagfilter,
/// tables, autolink, tasklist); unsafe=false by default, so raw HTML in the
/// markdown is escaped — pair unsafe:true with sanitizeHtmlBatch.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn markdown_to_html_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    opts: Option<MarkdownHtmlOptions>,
) -> Result<Object<'env>> {
    let cfg = match opts {
        None => compile_markdown_to_html(None, None, None, None, None),
        Some(o) => compile_markdown_to_html(o.gfm, o.tables, o.footnotes, o.smart_punct, o.unsafe_),
    };
    run_str_batch(env, items, move |s| apply_markdown_to_html(&cfg, s))
}

/// htmlToTextBatch(items: string[], opts?: HtmlToTextOptions): Promise<string[]>
///
/// html2text plain-text rendering wrapped at `width` columns (default 80,
/// 1-1000; out-of-range throws synchronously with status InvalidArg).
#[napi(ts_return_type = "Promise<string[]>")]
pub fn html_to_text_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    opts: Option<HtmlToTextOptions>,
) -> Result<Object<'env>> {
    let cfg = compile_html_to_text(opts.and_then(|o| o.width))
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
    run_str_batch(env, items, move |s| apply_html_to_text(&cfg, s))
}

/// htmlExtractBatch(items: Array<Buffer | string>, cfg: HtmlExtractConfig): Promise<string[]>
///
/// CSS-selector extraction (scraper). The selector is parsed ONCE on the JS
/// thread — invalid selectors throw synchronously with status InvalidArg.
/// all=false (default): the first match's text/outer-HTML/attr, '' if there
/// is no match (or the match lacks the attr). all=true: a JSON array string
/// with one entry per match (missing attr -> null). Buffer items must be
/// UTF-8; a non-UTF-8 item rejects the batch as "item {i}: htmlExtract: ...".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn html_extract_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
    cfg: HtmlExtractConfig,
) -> Result<Object<'env>> {
    let mode = match cfg.extract {
        Either::A(keyword) => parse_html_extract_mode(Some(&keyword), None),
        Either::B(spec) => parse_html_extract_mode(None, Some(spec.attr)),
    }
    .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let compiled = compile_html_extract(&cfg.selector, mode, cfg.all.unwrap_or(false))
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
    // Copy on the JS thread: V8-owned Buffer memory must not be touched off-thread.
    let owned: Vec<Vec<u8>> = items
        .into_iter()
        .map(|item| match item {
            Either::A(buf) => buf.to_vec(),
            Either::B(s) => s.into_bytes(),
        })
        .collect();
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = owned
            .par_iter()
            .enumerate()
            .map(|(i, b)| apply_html_extract(&compiled, b).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}
