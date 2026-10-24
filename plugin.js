// Liquid AI d1-3B on llama.cpp — new-api Task Plugin API v1 driver.
//
// COEXISTENCE BUILD: upload this file only when the legacy TypeSafe plugin
// must stay enabled on the same gateway. It is byte-for-byte the same driver
// as plugin.js except for the client-facing route: native routes that clash
// with an installed plugin are rejected at upload, so this build registers
// POST /liquid-d1/v1/systemone instead of the TypeSafe paths. Clients change
// only the path — the request/response dialect, image handling, validation,
// and usage semantics are identical. When the legacy plugin can be removed,
// prefer plugin.js: it keeps /typesafe/v1/systemone and /v1/systemone, so
// System One SDK clients work without any URL change.
//
// Replaces the TypeSafe Jev driver: the upstream is now a self-hosted
// llama-server exposing the TypeSafe-compatible System One endpoint
// POST /v1/systemone (llama.cpp PR #29818, shipped in v0.6.0). Liquid AI
// d1-3B support landed in PR #30110 (2026-10-07; needs build b11483+ or
// release v0.7.0+). The client-facing dialect is unchanged from the TypeSafe
// plugin, so System One SDK clients only need a new channel; this driver
// translates the TypeSafe image dialect (assets map + multipart file parts)
// into llama.cpp's JSON "images" array of base64 data URLs.
//
// Upstream facts this driver relies on (verified against sources below):
// - Request: JSON {model?, state, questions, images?}. No multipart to the
//   upstream. images is an array of data URLs ("data:image/...;base64,...");
//   state may also be a list of chat messages whose image_url parts carry
//   data URLs. With one model loaded the model member is ignored; in router
//   mode it selects the loaded model by id ("LiquidAI/d1-3B-GGUF:Q8_0").
// - Question types: choice, score, noul. TypeSafe's "box" type is refused
//   here: d1 answers in one forward pass and writes no text, and d1's
//   reference code reads unknown types as choice, which would silently
//   mis-answer a box question.
// - score criteria: 2..10 levels, lowest first (llama.cpp decision-model
//   docs). choice criteria: 2..255 options (d1's reference code requires at
//   least 2; a single-option choice is not a decision). A null state is
//   accepted: the d1 card allows None when images carry the whole state.
// - Response: {model, answers, usage: {input_tokens, output_tokens: 0}}.
//   Each question prefills the state again; usage.input_tokens counts the
//   shared prompt prefix once (d1 reference behavior, mirrored by llama.cpp).
// - d1-3B context is 32,768 tokens (LiquidAI/d1-3B model card); the server
//   refuses longer prompts. Load the GGUF with its vision projector (mmproj)
//   or image requests fail; GET /v1/models reports input/output modalities.
// - The endpoint is marked "subject to change" in llama.cpp's server README;
//   pin the server build in production.
//
// TypeSafe-only artifacts removed: the 256-token billed request prefix (the
// 65,792 / 262,400 budgets), the long-context header, and the
// TypeSafe-Danger-Zone-Images gate — llama.cpp gates nothing behind headers
// and enforces its own context window.
//
// v2.0.1: submit failures now embed the upstream status AND response body in
// the thrown error. The gateway reports every parseSubmitResponse throw as
// HTTP 502 "task request failed", so the bare status code of v2.0.0 turned
// every llama.cpp refusal (old build without /v1/systemone, missing mmproj,
// oversized prompt) into an undiagnosable 502. The body detail is what makes
// the 502 actionable. In this build the legacy TypeSafe plugin stays enabled,
// so the client-facing routes are renamed (see COEXISTENCE BUILD above).
//
// v2.1.0 hardening (same as plugin.js): normalizeBaseUrl strips every known
// route suffix (including /liquid-d1) down to the llama-server root and
// defaults schemeless hosts to http://; decode tolerates missing multipart
// maps; render tolerates missing task data; upstream error previews cover
// arrays and primitives.
//
// Sources: llama.cpp tools/server/README.md and PR #29818/#30110; the ggml-org
// "Decision Models in llama.cpp" post (request/response examples); the
// LiquidAI/d1-3B and LiquidAI/d1-3B-GGUF model cards; docs.liquid.ai decision
// model docs; new-api docs/plugin-api/v1.md + v1.d.ts (Task Plugin API v1).

const CONTEXT_LENGTH = 32768; // d1-3B context window (LiquidAI/d1-3B model card)
// Completion ceiling when a task row carries no persisted question count:
// 64 questions, each prefilled at full context. Token facts saturate at
// 2,147,483,647 at the host, so this stays well inside host bounds.
const MAX_QUESTIONS_FALLBACK = 64;
// Vendor cap per inlined image; the host independently applies
// MAX_FILE_DOWNLOAD_MB (default 64 MB) to each file and to the total.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Canonical client-facing model plus spellings an operator may bind directly.
const MODELS = ["d1-3b", "d1-3b-gguf", "LiquidAI/d1-3B", "LiquidAI/d1-3B-GGUF"];
// TypeSafe rejects any other top-level request member; llama.cpp receives a
// translated body (assets become the top-level images array), so clients
// never send "images" themselves.
const REQUEST_FIELDS = ["model", "state", "questions", "assets"];
// d1 cannot answer TypeSafe "box" questions (no text generation).
const QUESTION_TYPES = ["choice", "score", "noul"];
// Native-route prefix a chained new_api upstream serves this wire format
// under; the peer gateway runs the standard plugin.js build, which keeps the
// TypeSafe paths, so the chain URL is unchanged.
const NEW_API_ROUTE_PREFIX = "/typesafe";

// Longest upstream body fragment embedded in a thrown submit error.
const MAX_ERROR_DETAIL = 300;

export const meta = {
  apiVersion: 1,
  key: "liquid-d1",
  name: "Liquid d1 (llama.cpp)",
  sortPriority: 90,
  version: "2.1.0-coexist",
  icon: "text:d1",
  author: { name: "QuantumNous", url: "https://github.com/QuantumNous" },
  website: "https://huggingface.co/LiquidAI/d1-3B",
  description: {
    en: "Typed decisions with Liquid AI d1-3B on a self-hosted llama.cpp server, input priced per million tokens and output free",
    zh: "自建 llama.cpp 运行 Liquid AI d1-3B 结构化判断，输入按每百万 token 定价，输出免费",
  },
  // Default Base URL for type-61 Task Plugin channels: the llama-server
  // default address. Loopback and plain http are allowed for self-hosted
  // upstreams; the admin UI flags them before binding.
  baseUrl: "http://127.0.0.1:8080",
  // llama-server only validates Authorization when started with --api-key;
  // without a key configured on the channel the header is simply omitted.
  auth: "api_key",
  models: MODELS,
  upstreams: ["vendor", "new_api"],
  // d1 reads the state object as written (it is rendered into the prompt as
  // text), so member order changes its answers; the host keeps the client's
  // order only for plugins that ask. Note: a body that embeds a file
  // placeholder is still written sorted by the host, so clients that depend
  // on exact state member order should inline base64 data URLs in assets
  // instead of uploading multipart parts.
  requiredCapabilities: ["json-order@1"],
  fetchMode: "per_task",
  routes: [
    // Renamed to dodge the legacy TypeSafe plugin's native routes; clients
    // POST to /liquid-d1/v1/systemone instead of /typesafe/v1/systemone.
    {
      method: "POST",
      path: "/liquid-d1/v1/systemone",
      type: "submit",
      decode: "decodeSystemOne",
      render: "renderSystemOne",
      retainResult: false,
    },
  ],
  usageSchema: {
    input_tokens: {
      type: "number",
      unit: "token",
      description: { en: "Input token unit price", zh: "输入 token 单价" },
    },
  },
  usageExamples: [{ label: "d1-3B", facts: { input_tokens: 1000 } }],
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Instructions, Choice option descriptions and Noul outcomes may be null; the
// Score levels may not (System One protocol, unchanged for clients).
function isEntry(value) {
  return value === null || typeof value === "string" || typeof value === "object";
}

function validateRequest(body) {
  if (!isObject(body)) throw new Error("Request body must be a JSON object");
  for (const field of Object.keys(body)) {
    if (!REQUEST_FIELDS.includes(field)) throw new Error("System One does not accept the request field " + field);
  }
  if (typeof body.model !== "string" || !body.model.trim()) throw new Error("model is required");
  // Unlike TypeSafe, d1 accepts a null state when images carry the whole
  // state; the member itself must still be present.
  if (body.state === undefined || !(body.state === null || isEntry(body.state)))
    throw new Error("state must be text, an object, an array, or null");
  if (!isObject(body.questions) || Object.keys(body.questions).length === 0) throw new Error("questions must be a nonempty object");

  for (const id of Object.keys(body.questions)) {
    const question = body.questions[id];
    if (!isObject(question) || !QUESTION_TYPES.includes(question.type))
      throw new Error("Each question must have type choice, score, or noul; d1 decision models cannot answer box questions");
    if (question.instructions !== undefined && !isEntry(question.instructions))
      throw new Error("Question instructions must be text, an object, an array, or null");

    // Box questions are rejected above, so criteria always apply here.
    const criteria = question.criteria;
    if (question.type === "choice") {
      if (!isObject(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255)
        throw new Error("Choice criteria must contain between 2 and 255 options; d1 scores options against each other");
      if (
        Object.values(criteria).some(function (value) {
          return !isEntry(value);
        })
      )
        throw new Error("Choice option descriptions must be text, objects, arrays, or null");
    } else if (question.type === "score") {
      // llama.cpp requires 2 to 10 levels, lowest first (TypeSafe allowed 1).
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10)
        throw new Error("Score criteria must contain between 2 and 10 levels, lowest first");
      if (
        criteria.some(function (value) {
          return value === null || !isEntry(value);
        })
      )
        throw new Error("Score levels must be text, objects, or arrays");
    } else if (question.type === "noul" && criteria != null) {
      if (
        !isObject(criteria) ||
        [criteria.true, criteria.false].some(function (value) {
          return value !== undefined && !isEntry(value);
        })
      )
        throw new Error("Noul criteria must describe true and false with text, objects, arrays, or null");
    }
  }

  // The plugin itself consumes assets now, so they are validated here instead
  // of at the vendor: values must be image data URLs, base64 data, uploaded
  // part names, or null.
  if (body.assets !== undefined && body.assets !== null && !isObject(body.assets))
    throw new Error("assets must be an object mapping references to images");
  return body;
}

// The client-requested model must be a d1 spelling; the channel's model
// mapping (ctx.upstreamModel) decides what the upstream actually receives.
function resolveModel(ctx) {
  const requested = String(ctx.model || "")
    .trim()
    .toLowerCase();
  if (!MODELS.some(function (name) {
    return name.toLowerCase() === requested;
  }))
    throw new Error("Unsupported model " + ctx.model + "; request d1-3b (LiquidAI/d1-3B on llama.cpp) or map your alias to it on the channel");
  return ctx.upstreamModel || ctx.model;
}

// Validates the decoded System One request and returns it unchanged.
function systemOneRequest(ctx) {
  const body = validateRequest(ctx.requestBody);
  resolveModel(ctx);
  return body;
}

function questionCount(body) {
  return isObject(body) && isObject(body.questions) ? Object.keys(body.questions).length : 1;
}

// base64 signatures of the first bytes, read straight from the encoded string
// so the hook needs no decoder.
function sniffImageMime(base64) {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("Qk")) return "image/bmp";
  return null;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// Tracks how often each multipart field name appears, so repeated fields get
// the host's "request_file:<field>#<n>" placeholder form.
function partOccurrences(files) {
  const seen = new Map();
  return (files || []).map(function (file) {
    const occurrence = (seen.get(file.field) || 0) + 1;
    seen.set(file.field, occurrence);
    return { file: file, occurrence: occurrence };
  });
}

// The host replaces this placeholder with a data URL built from the uploaded
// part (its own Content-Type unless mimeType overrides it).
function filePlaceholder(file, occurrence) {
  const name = occurrence > 1 ? file.field + "#" + occurrence : file.field;
  const placeholder = { __fileRef: "request_file:" + name, encoding: "dataUrl", maxBytes: MAX_IMAGE_BYTES };
  if (/^image\//i.test(file.mimeType || "")) placeholder.mimeType = file.mimeType;
  return placeholder;
}

// Resolves one TypeSafe asset entry into a llama.cpp image: a data URL as
// sent, an uploaded part referenced by name, or bare base64 wrapped in a data
// URL with sniffed mime (llama.cpp re-sniffs the decoded bytes itself).
function resolveAssetValue(key, value, parts) {
  if (value === null || value === undefined) return null; // null entries carry no image
  if (typeof value !== "string")
    throw new Error("Asset " + key + " must be an image data URL, base64 data, an uploaded part name, or null");
  const data = value.trim();
  if (/^data:image\//i.test(data)) return data;
  for (const part of parts) {
    if (part.file.field === data) return filePlaceholder(part.file, part.occurrence);
  }
  const compact = data.replace(/\s+/g, "");
  if (compact.length >= 8 && compact.length % 4 === 0 && BASE64_PATTERN.test(compact)) {
    return "data:" + (sniffImageMime(compact) || "image/png") + ";base64," + compact;
  }
  throw new Error("Asset " + key + " is neither an image data URL, base64 data, nor the name of an uploaded file part");
}

// Builds the upstream images array. When assets are present they are the
// manifest (TypeSafe semantics: images travel keyed by their reference), and
// unreferenced parts are ignored; without assets, every uploaded image part
// becomes an image in upload order.
function vendorImages(body, parts) {
  const images = [];
  if (body.assets !== undefined && body.assets !== null) {
    for (const key of Object.keys(body.assets)) {
      const image = resolveAssetValue(key, body.assets[key], parts);
      if (image !== null) images.push(image);
    }
    return images;
  }
  for (const part of parts) {
    if (/^image\//i.test(part.file.mimeType || "")) images.push(filePlaceholder(part.file, part.occurrence));
  }
  return images;
}

// The body llama.cpp receives: JSON only, assets translated to images.
function vendorBody(ctx) {
  const body = systemOneRequest(ctx);
  const request = { model: resolveModel(ctx), state: body.state, questions: body.questions };
  const images = vendorImages(body, partOccurrences(ctx.files));
  if (images.length > 0) request.images = images;
  return request;
}

function submitHeaders(ctx) {
  const headers = { Accept: "application/json" };
  if (ctx.authHeader) headers.Authorization = ctx.authHeader;
  else if (ctx.apiKey) headers.Authorization = "Bearer " + ctx.apiKey;
  return headers;
}

// Accepts channel base URLs pasted with an optional /v1, the full endpoint
// path, or a client-style base that already contains a route prefix —
// operators routinely paste the exact URL they configured in the client (for
// example ".../liquid-d1/v1/systemone"), which previously produced requests to
// llama.cpp paths that do not exist. Known route suffixes are stripped one
// trailing segment at a time down to the llama-server root, so reverse-proxy
// prefixes the operator actually needs (e.g. https://ops.example.com/llama)
// survive untouched. Schemeless hosts default to plain http (self-hosted
// llama-server's own default), and everything else fails with the exact fix.
function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl == null ? "" : baseUrl).trim();
  if (!base) throw new Error("Channel base URL is required; use the llama-server root, e.g. http://127.0.0.1:8080");
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(base)) base = "http://" + base;
  base = base.replace(/\/+$/, "");
  const routeSegments = ["/systemone", "/v1", "/liquid-d1", "/typesafe"];
  for (let changed = true; changed; ) {
    changed = false;
    const lower = base.toLowerCase();
    for (const segment of routeSegments) {
      if (lower.endsWith(segment)) {
        base = base.slice(0, base.length - segment.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  if (!base || !/^https?:\/\//i.test(base))
    throw new Error("Channel base URL must be the llama-server root, e.g. http://127.0.0.1:8080 — not a route path like /liquid-d1/v1/systemone");
  return base;
}

export function buildSubmitRequest(ctx) {
  const base = normalizeBaseUrl(ctx.baseUrl);

  // Chained through another New API gateway that runs this same plugin: keep
  // the client dialect (assets + multipart parts) so the downstream driver
  // performs its own image translation against its own llama.cpp upstream.
  if (ctx.upstream && ctx.upstream.kind === "new_api") {
    const body = systemOneRequest(ctx);
    const headers = submitHeaders(ctx);
    const request = { url: base + NEW_API_ROUTE_PREFIX + "/v1/systemone", method: "POST", headers: headers };
    const files = ctx.files || [];
    if (files.length === 0) {
      headers["Content-Type"] = "application/json";
      request.body = body;
      return request;
    }
    request.bodyType = "multipart";
    request.parts = [{ name: "request", value: JSON.stringify(body) }].concat(
      files.map(function (file) {
        return { name: file.field, fileRef: file.ref, filename: file.filename };
      }),
    );
    return request;
  }

  // Direct llama.cpp upstream.
  const headers = submitHeaders(ctx);
  headers["Content-Type"] = "application/json";
  return { url: base + "/v1/systemone", method: "POST", headers: headers, body: vendorBody(ctx) };
}

// The host hands the upstream body to this hook as a decoded JSON value when
// it parses and as raw text otherwise. Reduce either shape to a short
// diagnostic: llama.cpp answers failures with its OpenAI-style error object,
// plain text, or a {detail: ...} body; reverse proxies answer with HTML; and
// exotic upstreams answer with arrays or bare scalars.
function upstreamDetail(body) {
  let text = "";
  if (typeof body === "string") text = body;
  else if (body !== null && typeof body === "object") {
    if (typeof body.error === "string") text = body.error;
    else if (isObject(body.error) && typeof body.error.message === "string") text = body.error.message;
    else if (typeof body.detail === "string") text = body.detail;
    else {
      try {
        text = JSON.stringify(body);
      } catch (stringifyError) {
        text = "";
      }
    }
  } else if (body !== undefined && body !== null) {
    text = String(body);
  }
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (text.length > MAX_ERROR_DETAIL) text = text.slice(0, MAX_ERROR_DETAIL) + "...";
  return text;
}

export function parseSubmitResponse(ctx, response) {
  // The gateway reports this throw as HTTP 502 "task request failed"; the
  // status plus body detail is what makes that 502 diagnosable. 404 means the
  // server build predates /v1/systemone (llama.cpp v0.6.0) — and d1-3B itself
  // needs build b11483+ (PR #30110), so v0.6.0 alone is not enough. 400 with
  // a vision error usually means the GGUF was loaded without its mmproj.
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = upstreamDetail(response.body);
    throw new Error("llama.cpp returned HTTP " + response.statusCode + (detail ? ": " + detail : ""));
  }
  const body = response.body;
  if (!isObject(body) || typeof body.model !== "string" || !body.model || !isObject(body.answers))
    throw new Error("llama.cpp System One response is missing model or answers" + (response.body === undefined ? "" : "; got: " + upstreamDetail(body)));
  const questions = isObject(ctx.requestBody) && isObject(ctx.requestBody.questions) ? ctx.requestBody.questions : {};
  for (const id of Object.keys(questions)) {
    const answer = Object.prototype.hasOwnProperty.call(body.answers, id) ? body.answers[id] : null;
    if (!isObject(answer) || answer.type !== questions[id].type)
      throw new Error("llama.cpp response is missing a matching answer for question " + id);
  }
  if (!ctx.publicTaskId) throw new Error("Missing gateway request ID");
  return {
    taskId: ctx.publicTaskId,
    taskData: body,
    immediate: { status: "SUCCESS", progress: "100%" },
    // Persisted for extractUsageOnComplete, which cannot see the request.
    state: { questions: Object.keys(questions).length },
  };
}

export function extractUsage(ctx) {
  const body = systemOneRequest(ctx);
  if (ctx.usagePurpose === "billing_ratios") return null;
  // Worst-case reservation: every question prefills the state again and each
  // per-question prompt must fit the 32,768-token d1-3B context. Completion
  // replaces this with the usage.input_tokens the server reports (the shared
  // prompt prefix is counted once there, so the settled amount is far lower).
  return { input_tokens: Math.max(1, questionCount(body)) * CONTEXT_LENGTH };
}

export function extractUsageOnComplete(ctx, result, body) {
  const tokens = body && body.usage && body.usage.input_tokens;
  // Throwing preserves the reservation and makes the host log invalid usage.
  // Never coerce a missing/invalid value to zero or bill free output tokens.
  // Completion cannot see the request body or headers, so the question count
  // persisted at submit bounds the report to one full context per question;
  // without persisted state, fall back to a generous fixed ceiling.
  const questions = isObject(ctx.state) && Number.isInteger(ctx.state.questions) ? ctx.state.questions : 0;
  const ceiling = (questions > 0 ? questions : MAX_QUESTIONS_FALLBACK) * CONTEXT_LENGTH;
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > ceiling)
    throw new Error("llama.cpp input token usage is missing or outside the d1-3B context budget");
  return { input_tokens: tokens };
}

// API v1 requires polling hooks, but System One always completes synchronously.
export function buildQueryRequest() {
  throw new Error("Liquid d1 on llama.cpp has no task retrieval endpoint");
}

export function parseTaskResult() {
  return { status: "UNKNOWN", reason: "Liquid d1 on llama.cpp has no asynchronous tasks" };
}

export const native = {
  decodeSystemOne: function (ctx) {
    let value;
    const raw = ctx && ctx.body;
    if (raw && raw.kind === "json") {
      value = raw.value;
    } else if (raw && raw.kind === "multipart") {
      // SDK clients send requests with images as multipart: the JSON in a
      // field named request, each image in a file part that assets name.
      const fields = (raw.fields || {}).request;
      if (!fields || fields.length !== 1) throw new Error("A multipart request needs one request field with the JSON request");
      if (typeof fields[0] !== "string") throw new Error("The request field must hold the JSON request");
      try {
        value = JSON.parse(fields[0]);
      } catch (error) {
        throw new Error("The request field must hold the JSON request");
      }
    } else if (raw && raw.kind === "form") {
      // System One requests are nested JSON; form encoding cannot carry them.
      throw new Error("System One requests must be sent as JSON (or multipart with a request field), not form encoding");
    } else {
      throw new Error("JSON or multipart body required");
    }
    const body = validateRequest(value);
    return {
      kind: "submit",
      model: body.model,
      action: "systemone",
      requestBody: body,
    };
  },
  renderSystemOne: function (ctx, task) {
    // retainResult routes never persist task.data, and a truncated task row
    // may lack it; render must degrade to null, never throw.
    return task && task.data !== undefined ? task.data : null;
  },
  error: function (ctx, error) {
    // Surfaces llama.cpp failures in the System One shape clients read.
    // llama.cpp answers with its own body ({"error": {...}}) or plain text;
    // a {"detail": ...} body passes through untouched.
    try {
      const parsed = JSON.parse(error.message);
      if (isObject(parsed)) {
        if (parsed.detail !== undefined) return parsed;
        if (isObject(parsed.error) && typeof parsed.error.message === "string") return { detail: parsed.error.message };
        if (typeof parsed.error === "string") return { detail: parsed.error };
      }
    } catch (parseError) {
      // Gateway errors are sentences, not JSON.
    }
    return { detail: error.message };
  },
};
