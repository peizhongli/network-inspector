/*
 * panel-utils.js —— 面板公共状态与工具函数
 * 以普通脚本方式加载，后续文件共享这里的全局绑定。
 */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const IS_DEVTOOLS = Boolean(globalThis.chrome && chrome.devtools && chrome.devtools.network);

const DEFAULT_SETTINGS = {
  maxEntries: 500,
  parseThresholdKB: 1024,
  maxCaptureMB: 5,
  extraWhitelist: [],
  blacklist: [],
};

const state = {
  mode: IS_DEVTOOLS ? 'devtools' : 'inject',
  requests: [],
  selectedId: null,
  // 选中请求的快照：即使请求被环形缓冲挤出，详情仍可用它继续渲染
  selectedSnapshot: null,
  paused: false,
  tabId: null,
  tabs: [],
  inspectedUrl: '',
  detailTab: 'headers',
  // 左右分栏比例（列表宽度占比），持久化到 storage.local
  splitRatio: 0.52,
  settings: {
    maxEntries: 500,
    parseThresholdKB: 1024,
    maxCaptureMB: 5,
    parseThresholdBytes: 1024 * 1024,
    maxCaptureBytes: 5 * 1024 * 1024,
    extraWhitelist: [],
    blacklist: [],
  },
  ui: {
    keyword: '',
    secHeaders: true,
    secUrl: true,
    secPayload: true,
    secResponse: true,
    caseInsensitive: true,
    highlightOnly: false,
    customOnly: false,
    method: '',
    status: '',
    // 响应区局部搜索（与顶部全局关键字完全独立，不影响列表过滤）
    localKeyword: '',
    localMatchIndex: 0,
    // 请求体展示方式：JSON 用 formatted/raw，form-urlencoded 用 table/raw
    reqBodyView: 'formatted',
    formBodyView: 'table',
  },
};

const MAX_HIGHLIGHT_CHARS = 300000;
const MAX_SEARCH_CHARS = 512 * 1024;

// ---------------------------------------------------------------- 基础工具

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规范化搜索关键字：去掉首尾空白与零宽字符 / BOM。
 * 避免从别处复制关键字时带入不可见字符导致“看起来一样却搜不到”。
 */
function cleanKeyword(value) {
  return String(value == null ? '' : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

/** 安全解码 URL 片段：遇到非法转义（孤立 %）时退回原文，不抛异常 */
function safeDecodeUrl(value) {
  const text = String(value == null ? '' : value);
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return text;
  }
}

/** 解码 form-urlencoded 片段：+ 代表空格，非法转义时退回原文 */
function decodeFormComponent(value) {
  const plus = String(value == null ? '' : value).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch (err) {
    return plus;
  }
}

/** 把 `a=1&b=%E4%B8%AD` 拆成解码后的键值对，供表格展示与搜索使用 */
function parseUrlEncoded(text) {
  const source = String(text == null ? '' : text).replace(/^\?/, '').trim();
  if (!source) return [];
  const out = [];
  for (const pair of source.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      out.push({ name: decodeFormComponent(pair), value: '' });
    } else {
      out.push({ name: decodeFormComponent(pair.slice(0, eq)), value: decodeFormComponent(pair.slice(eq + 1)) });
    }
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * 把命中关键字用 <mark> 高亮，返回 HTML 片段。
 * 超长文本只高亮前 MAX_HIGHLIGHT_CHARS 个字符，避免卡顿。
 */
function highlightHtml(text, keyword) {
  const raw = String(text == null ? '' : text);
  const kw = cleanKeyword(keyword);
  if (!kw) return esc(raw);

  const limited = raw.length > MAX_HIGHLIGHT_CHARS ? raw.slice(0, MAX_HIGHLIGHT_CHARS) : raw;
  const flags = state.ui.caseInsensitive ? 'gi' : 'g';
  let regex;
  try {
    regex = new RegExp(escapeRegExp(kw), flags);
  } catch (err) {
    return esc(limited);
  }

  let result = '';
  let lastIndex = 0;
  let match;
  let guard = 0;
  while ((match = regex.exec(limited)) !== null && guard < 5000) {
    guard += 1;
    result += esc(limited.slice(lastIndex, match.index));
    result += '<mark>' + esc(match[0]) + '</mark>';
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  result += esc(limited.slice(lastIndex));
  if (raw.length > MAX_HIGHLIGHT_CHARS) {
    result += `<span class="muted">…（文本过长，仅高亮前 ${Math.round(MAX_HIGHLIGHT_CHARS / 1000)}k 字符）</span>`;
  }
  return result;
}

function countMatches(text, keyword) {
  const haystackRaw = String(text || '');
  const haystack = haystackRaw.length > MAX_SEARCH_CHARS
    ? haystackRaw.slice(0, MAX_SEARCH_CHARS)
    : haystackRaw;
  const kw = cleanKeyword(keyword);
  if (!kw) return 0;
  const needle = state.ui.caseInsensitive ? kw.toLowerCase() : kw;
  const hay = state.ui.caseInsensitive ? haystack.toLowerCase() : haystack;
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = hay.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(1, needle.length);
    if (count >= 999) break;
  }
  return count;
}

function formatBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function statusClass(status) {
  if (!status) return 's0';
  if (status >= 500) return 's5';
  if (status >= 400) return 's4';
  if (status >= 300) return 's3';
  return 's2';
}

function methodClass(method) {
  return String(method || 'GET').toUpperCase();
}

function getHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return '';
}

function contentTypeOf(req) {
  return (
    getHeader(req.respHeaders, 'content-type') ||
    req.contentType ||
    (req.respBody && req.respBody.mimeType) ||
    ''
  );
}

function mimeEssence(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function isTextualMime(mime) {
  const m = mimeEssence(mime);
  if (!m) return false;
  return (
    m.startsWith('text/') ||
    /(json|javascript|ecmascript|xml|x-www-form-urlencoded|csv|graphql|event-stream|html|css|yaml|x-protobuf|protobuf|ndjson)/.test(m)
  );
}

function isStreamMime(mime) {
  const m = mimeEssence(mime);
  return m === 'text/event-stream' || m.includes('ndjson') || m.includes('stream');
}

function isBinaryMime(mime) {
  const m = mimeEssence(mime);
  if (!m) return false;
  if (isTextualMime(m)) return false;
  return (
    m.startsWith('image/') ||
    m.startsWith('audio/') ||
    m.startsWith('video/') ||
    m.startsWith('font/') ||
    /(octet-stream|pdf|zip|gzip|x-tar|excel|spreadsheet|msdownload|protobuf|vnd\.|wasm|compressed|binary|font)/.test(m)
  );
}

function mimeLabel(mime, url) {
  const m = mimeEssence(mime);
  if (!m) {
    try {
      const pathname = new URL(url || '').pathname;
      const ext = pathname.split('.').pop();
      return ext && ext.length <= 5 ? ext : 'other';
    } catch (err) {
      return 'other';
    }
  }
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('css')) return 'css';
  if (m.includes('javascript') || m.includes('ecmascript')) return 'js';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('font/') || m.includes('font')) return 'font';
  if (m.includes('event-stream')) return 'sse';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('zip')) return 'zip';
  if (m.includes('protobuf')) return 'protobuf';
  if (m.startsWith('text/')) return 'text';
  if (m.includes('xml')) return 'xml';
  return m;
}

function trimForDisplay(text, max = MAX_HIGHLIGHT_CHARS) {
  const raw = String(text == null ? '' : text);
  if (raw.length <= max) return raw;
  return raw.slice(0, max) + `\n…（共 ${raw.length} 字符，仅显示前 ${max}）`;
}

function toast(message, type) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = 'toast show' + (type === 'warn' ? ' warn' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    node.className = 'toast';
  }, 2600);
}

function copyText(text, message) {
  const value = String(text == null ? '' : text);
  const done = () => toast(message || '已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done, () => fallbackCopy(value, done));
  } else {
    fallbackCopy(value, done);
  }
}

function fallbackCopy(value, done) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    done();
  } catch (err) {
    toast('复制失败，请手动选择文本复制', 'warn');
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToText(base64) {
  try {
    return new TextDecoder('utf-8').decode(base64ToBytes(base64));
  } catch (err) {
    return '';
  }
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- Header 白名单

// 常见标准请求头（小写）。未在白名单中的 Header 会被标记为“自定义”。
const STANDARD_REQUEST_HEADERS = new Set([
  'accept', 'accept-charset', 'accept-encoding', 'accept-language', 'access-control-request-headers',
  'access-control-request-method', 'authorization', 'cache-control', 'connection', 'content-encoding',
  'content-language', 'content-length', 'content-location', 'content-md5', 'content-range', 'content-type',
  'cookie', 'date', 'expect', 'forwarded', 'from', 'host', 'if-match', 'if-modified-since', 'if-none-match',
  'if-range', 'if-unmodified-since', 'max-forwards', 'origin', 'pragma', 'priority', 'proxy-authorization',
  'range', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via', 'warning',
  'x-requested-with',
  // 浏览器/客户端自动附加的常见头，避免被误判为“自定义”
  'accept-ch', 'dnt', 'device-memory', 'downlink', 'dpr', 'ect', 'priority', 'rtt', 'save-data',
  'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-wow64', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'sec-gpc', 'sec-purpose', 'sec-websocket-extensions', 'sec-websocket-key',
  'sec-websocket-protocol', 'sec-websocket-version', 'speculation-rules', 'upgrade-insecure-requests',
  'viewport-width', 'width',
]);

const STANDARD_RESPONSE_HEADERS = new Set([
  'accept-ranges', 'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-allow-origin', 'access-control-expose-headers',
  'access-control-max-age', 'age', 'allow', 'alt-svc', 'cache-control', 'connection', 'content-disposition',
  'content-encoding', 'content-language', 'content-length', 'content-location', 'content-range', 'content-type',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'date', 'etag',
  'expires', 'last-modified', 'link', 'location', 'permissions-policy', 'pragma', 'proxy-authenticate',
  'referrer-policy', 'retry-after', 'server', 'set-cookie', 'strict-transport-security', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'vary', 'via', 'warning', 'www-authenticate', 'content-security-policy',
  'content-security-policy-report-only', 'report-to', 'nel', 'x-content-type-options', 'x-frame-options',
  'x-xss-protection', 'timing-allow-origin', 'accept-ch', 'critical-ch', 'origin-agent-cluster',
]);

function headerKindSet(kind) {
  return kind === 'request' ? STANDARD_REQUEST_HEADERS : STANDARD_RESPONSE_HEADERS;
}

function isCustomHeader(name, kind) {
  const key = String(name || '').toLowerCase();
  if (!key || key.startsWith(':')) return false;
  if (state.settings.blacklist.includes(key)) return true;
  if (state.settings.extraWhitelist.includes(key)) return false;
  return !headerKindSet(kind).has(key);
}

function requestHasCustomHeader(req) {
  for (const name of Object.keys(req.reqHeaders || {})) {
    if (isCustomHeader(name, 'request')) return true;
  }
  for (const name of Object.keys(req.respHeaders || {})) {
    if (isCustomHeader(name, 'response')) return true;
  }
  return false;
}

function requestHasSensitiveHeaders(req) {
  const names = Object.keys(req.reqHeaders || {}).map((n) => n.toLowerCase());
  return names.some((n) => n === 'authorization' || n === 'cookie' || n === 'proxy-authorization');
}

// ---------------------------------------------------------------- 设置
function normalizeSettings(raw) {
  const cfg = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  const maxEntries = Number(cfg.maxEntries);
  const parseKB = Number(cfg.parseThresholdKB);
  const maxMB = Number(cfg.maxCaptureMB);
  return {
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_SETTINGS.maxEntries,
    parseThresholdKB: Number.isFinite(parseKB) && parseKB > 0 ? parseKB : DEFAULT_SETTINGS.parseThresholdKB,
    maxCaptureMB: Number.isFinite(maxMB) && maxMB > 0 ? maxMB : DEFAULT_SETTINGS.maxCaptureMB,
    extraWhitelist: normalizeHeaderList(cfg.extraWhitelist),
    blacklist: normalizeHeaderList(cfg.blacklist),
  };
}

function normalizeHeaderList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return list.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function applySettings(raw) {
  const cfg = normalizeSettings(raw);
  state.settings.maxEntries = cfg.maxEntries;
  state.settings.parseThresholdKB = cfg.parseThresholdKB;
  state.settings.parseThresholdBytes = cfg.parseThresholdKB * 1024;
  state.settings.maxCaptureMB = cfg.maxCaptureMB;
  state.settings.maxCaptureBytes = cfg.maxCaptureMB * 1024 * 1024;
  state.settings.extraWhitelist = cfg.extraWhitelist;
  state.settings.blacklist = cfg.blacklist;
}

function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS).then((raw) => {
    applySettings(raw);
  }).catch(() => {
    applySettings(DEFAULT_SETTINGS);
  });
}

function updatePageUrl() {
  const node = $('#pageUrl');
  if (!node) return;
  node.textContent = state.inspectedUrl || '—';
  node.title = state.inspectedUrl || '';
}
