/*
 * panel-data.js —— 数据源：DevTools HAR（主模式）与页面注入（补充模式）
 * 两种源最终都产出统一结构，渲染层无需区分。
 */
'use strict';

let injectPort = null;
let injectReconnectTimer = null;
let devtoolsSeq = 0;

// ---------------------------------------------------------------- 统一模型

function headersToObject(list) {
  const out = {};
  for (const item of list || []) {
    if (!item || !item.name) continue;
    out[item.name] = item.value == null ? '' : String(item.value);
  }
  return out;
}

function harRequestBody(postData) {
  if (!postData) return null;
  const mime = postData.mimeType || '';
  if (Array.isArray(postData.params) && postData.params.length) {
    const fields = postData.params.map((p) => ({
      name: p.name,
      value: p.value,
      fileName: p.fileName,
      fileSize: p.fileSize,
      isFile: Boolean(p.fileName),
    }));
    const text = fields
      .map((f) => (f.isFile ? `${f.name} = [File] ${f.fileName}` : `${f.name} = ${f.value}`))
      .join('\n');
    return {
      kind: /multipart/.test(mime) ? 'form' : 'text',
      text,
      formFields: fields,
      mimeType: mime,
      size: 0,
      truncated: false,
    };
  }
  if (typeof postData.text === 'string' && postData.text.length) {
    return {
      kind: 'text',
      text: postData.text,
      mimeType: mime,
      size: postData.text.length,
      truncated: false,
    };
  }
  return null;
}

function harToRequest(entry, id) {
  const request = entry.request || {};
  const response = entry.response || {};
  const content = response.content || {};
  const mime = content.mimeType || getHeader(headersToObject(response.headers), 'content-type') || '';

  let size = Number(content.size);
  if (!Number.isFinite(size) || size < 0) size = Number(response.bodySize);
  if (!Number.isFinite(size) || size < 0) size = 0;

  const duration = Number(entry.time);
  const started = Date.parse(entry.startedDateTime || '');

  const respBody = {
    kind: 'deferred',
    size,
    capturedBytes: 0,
    mimeType: mime,
    truncated: false,
    note: '',
  };

  // HAR 里 content.text 有时已经存在；否则等面板按需调用 getContent。
  if (typeof content.text === 'string' && content.text.length && size <= state.settings.parseThresholdBytes) {
    respBody.kind = content.encoding === 'base64' ? 'base64' : 'text';
    if (respBody.kind === 'base64') {
      respBody.data = content.text;
    } else {
      respBody.text = content.text;
    }
    respBody.capturedBytes = size;
  }

  const req = {
    id,
    source: 'devtools',
    type: request.httpVersion ? 'xhr' : 'fetch',
    method: String(request.method || 'GET').toUpperCase(),
    url: request.url || '',
    status: Number(response.status) || 0,
    statusText: response.statusText || '',
    reqHeaders: headersToObject(request.headers),
    respHeaders: headersToObject(response.headers),
    reqBody: harRequestBody(request.postData),
    respBody,
    contentType: mime,
    startTime: Number.isFinite(started) ? started : Date.now(),
    duration: Number.isFinite(duration) ? duration : 0,
    size,
    error: null,
    _entry: entry,
    _bodyState: respBody.kind === 'deferred' ? 'deferred' : 'ready',
  };

  // 小响应立即预取，保证搜索能覆盖 response body
  if (req._bodyState === 'deferred' && size <= state.settings.parseThresholdBytes) {
    Promise.resolve().then(() => ensureBody(req)).catch(() => {});
  }
  return req;
}

/**
 * DevTools 模式：通过 HAR entry.getContent 读取响应体（可能为空/已清理）。
 * 返回 Promise，加载完成后同步更新请求模型。
 */
function ensureBody(req) {
  if (req._bodyState === 'ready' || req._bodyState === 'empty') return Promise.resolve(req.respBody);
  if (req._bodyState === 'loading') return req._loading || Promise.resolve(req.respBody);
  if (!req._entry || typeof req._entry.getContent !== 'function') {
    req._bodyState = 'empty';
    return Promise.resolve(req.respBody);
  }

  req._bodyState = 'loading';
  req._loading = new Promise((resolve) => {
    let settled = false;
    const finish = (body, bodyState) => {
      if (settled) return;
      settled = true;
      req.respBody = body;
      req._bodyState = bodyState;
      resolve(body);
      if (typeof onRequestUpdated === 'function') onRequestUpdated(req);
    };

    try {
      req._entry.getContent((content, encoding) => {
        if (typeof content !== 'string' || !content.length) {
          finish(
            {
              kind: 'none',
              text: '',
              size: req.respBody.size || 0,
              mimeType: req.contentType,
              truncated: false,
              note: 'DevTools 未返回内容：响应体可能已被清理、未缓存，或该请求没有响应体。',
            },
            'empty'
          );
          return;
        }
        if (encoding === 'base64') {
          finish(
            {
              kind: 'base64',
              data: content,
              size: req.respBody.size || content.length,
              capturedBytes: content.length,
              mimeType: req.contentType || req.respBody.mimeType,
              truncated: false,
            },
            'ready'
          );
          return;
        }
        finish(
          {
            kind: 'text',
            text: content,
            size: req.respBody.size || content.length,
            capturedBytes: content.length,
            mimeType: req.contentType || req.respBody.mimeType,
            truncated: false,
          },
          'ready'
        );
      });
    } catch (err) {
      finish(
        {
          kind: 'none',
          text: '',
          size: req.respBody.size || 0,
          mimeType: req.contentType,
          truncated: false,
          note: '调用 getContent 失败：' + String(err && err.message ? err.message : err),
        },
        'empty'
      );
    }
  });
  return req._loading;
}

// ---------------------------------------------------------------- 公共数据操作

function addRequest(req) {
  if (!req || !req.id) return;
  if (state.requests.some((item) => item.id === req.id)) return;
  state.requests.push(req);
  const max = state.settings.maxEntries;
  if (state.requests.length > max) {
    // 环形缓冲裁剪：把被裁掉的请求中的“当前选中项”保留为快照，避免详情静默消失
    const removed = state.requests.splice(0, state.requests.length - max);
    for (const gone of removed) {
      if (gone.id === state.selectedId) {
        state.selectedSnapshot = gone;
        gone._outOfBuffer = true;
      }
    }
  }
  scheduleRender();
}

function clearRequests() {
  state.requests = [];
  state.selectedId = null;
  state.selectedSnapshot = null;
  state.ui.localMatchIndex = 0;
  scheduleRender();
}

function findRequest(id) {
  return state.requests.find((item) => item.id === id) || null;
}

/**
 * 解析当前选中项：
 * 1) 优先取列表中的实时对象；
 * 2) 若已被缓冲挤出，回退到选中快照（标记 _outOfBuffer），详情继续渲染。
 */
function selectedRequest() {
  if (state.selectedId == null) return null;
  const live = findRequest(state.selectedId);
  if (live) {
    state.selectedSnapshot = live;
    return live;
  }
  const snapshot = state.selectedSnapshot;
  if (snapshot && snapshot.id === state.selectedId) return snapshot;
  return null;
}

// ---------------------------------------------------------------- 搜索与过滤

function requestHeaderText(req) {
  const lines = [];
  for (const [name, value] of Object.entries(req.reqHeaders || {})) {
    lines.push(`${name}: ${value}`);
  }
  for (const [name, value] of Object.entries(req.respHeaders || {})) {
    lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

function requestPayloadText(req) {
  const lines = [];
  try {
    const url = new URL(req.url);
    lines.push(url.search);
    // query string 同样提供解码后形式，避免只勾 Payload 时编码差异导致搜不到
    lines.push(safeDecodeUrl(url.search));
    lines.push(safeDecodeUrl(url.search.replace(/\+/g, ' ')));
  } catch (err) {
    // ignore
  }
  const body = req.reqBody;
  if (body) {
    if (body.text) lines.push(body.text);
    if (Array.isArray(body.formFields)) {
      for (const field of body.formFields) {
        lines.push(`${field.name}=${field.value == null ? '' : field.value}`);
        if (field.fileName) lines.push(`${field.fileName} ${field.fileSize || 0}`);
      }
    }
  }
  return lines.join('\n');
}

function requestResponseText(req) {
  const body = req.respBody;
  if (!body) return '';
  if (body.kind === 'text') return body.text || '';
  if (body.kind === 'base64' && isTextualMime(body.mimeType || req.contentType)) {
    return base64ToText(body.data || '');
  }
  return '';
}

/**
 * URL 搜索语料：完整 URL、path、query string，并同时提供编码前 / 解码后的形式。
 * 这样无论是从详情里复制解码后的片段（如中文），还是复制 `%2F` / `+` 这类编码串，
 * 都能命中同一条请求。
 */
function requestUrlText(req) {
  const raw = String(req.url || '');
  if (!raw) return '';
  const variants = new Set([raw]);
  const push = (value) => {
    const text = String(value == null ? '' : value);
    if (text) variants.add(text);
  };

  push(safeDecodeUrl(raw));
  // form-urlencoded 中 + 表示空格，额外提供一份按该规则的解码结果
  push(safeDecodeUrl(raw.replace(/\+/g, ' ')));

  try {
    const url = new URL(raw);
    const pathname = url.pathname || '';
    push(pathname);
    push(safeDecodeUrl(pathname));

    const search = url.search || '';
    if (search) {
      const decodedSearch = safeDecodeUrl(search);
      const plusDecodedSearch = safeDecodeUrl(search.replace(/\+/g, ' '));
      push(search);
      push(search.replace(/^\?/, ''));
      push(decodedSearch);
      push(decodedSearch.replace(/^\?/, ''));
      push(plusDecodedSearch);
      push(plusDecodedSearch.replace(/^\?/, ''));
    }
    push(url.hash);
  } catch (err) {
    // 非标准 URL（如 data:）时至少保留原文与解码文本
  }
  return Array.from(variants).join('\n');
}

function computeMatch(req) {
  const keyword = cleanKeyword(state.ui.keyword);
  if (!keyword) return null;

  const cacheKey = [
    keyword,
    state.ui.caseInsensitive ? 'i' : 's',
    state.ui.secHeaders, state.ui.secUrl, state.ui.secPayload, state.ui.secResponse,
  ].join('|');
  if (req._matchKey === cacheKey && req._match) return req._match;

  const result = { headers: 0, url: 0, payload: 0, response: 0, total: 0 };
  if (state.ui.secHeaders) result.headers = countMatches(requestHeaderText(req), keyword);
  if (state.ui.secUrl) result.url = countMatches(requestUrlText(req), keyword);
  if (state.ui.secPayload) result.payload = countMatches(requestPayloadText(req), keyword);
  if (state.ui.secResponse) result.response = countMatches(requestResponseText(req), keyword);
  result.total = result.headers + result.url + result.payload + result.response;

  req._matchKey = cacheKey;
  req._match = result;
  return result;
}

function statusCategory(status) {
  const n = Number(status);
  if (!n) return '0';
  if (n >= 500) return '5';
  if (n >= 400) return '4';
  if (n >= 300) return '3';
  return '2';
}

function passesFilters(req) {
  if (state.ui.customOnly && !requestHasCustomHeader(req)) return false;
  if (state.ui.method && req.method !== state.ui.method) return false;
  if (state.ui.status && statusCategory(req.status) !== state.ui.status) return false;

  const keyword = cleanKeyword(state.ui.keyword);
  if (keyword && !state.ui.highlightOnly) {
    const anySection = state.ui.secHeaders || state.ui.secUrl || state.ui.secPayload || state.ui.secResponse;
    if (anySection) {
      const match = computeMatch(req);
      if (!match || match.total === 0) return false;
    }
  }
  return true;
}

function visibleRequests() {
  // 新请求在前；过滤条件统一走 passesFilters
  return state.requests.slice().reverse().filter(passesFilters);
}

// ---------------------------------------------------------------- DevTools 数据源

function initDevtoolsSource() {
  state.mode = 'devtools';
  state.requests = [];

  chrome.devtools.network.onRequestFinished.addListener((entry) => {
    if (state.paused) return;
    devtoolsSeq += 1;
    let req;
    try {
      req = harToRequest(entry, `dt-${devtoolsSeq}`);
    } catch (err) {
      return;
    }
    if (req.url.startsWith('chrome-extension://')) return;
    addRequest(req);
  });

  chrome.devtools.network.onNavigated.addListener((url) => {
    state.inspectedUrl = String(url || '');
    updatePageUrl();
    clearRequests();
    toast('页面已导航，列表已重置');
  });

  chrome.devtools.inspectedWindow.eval('location.href', (result, isException) => {
    if (!isException && typeof result === 'string') {
      state.inspectedUrl = result;
    }
    updatePageUrl();
  });
}

// ---------------------------------------------------------------- 注入数据源

function initInjectSource(initialTabId) {
  state.mode = 'inject';
  loadTabs(initialTabId);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== state.tabId) return;
    if (changeInfo.url) {
      state.inspectedUrl = changeInfo.url;
      updatePageUrl();
    }
    if (tab) refreshTabLabel(tab);
  });

  chrome.tabs.onRemoved.addListener(() => {
    loadTabs(state.tabId);
  });

  connectInjectPort();
}

function loadTabs(preferredTabId) {
  chrome.tabs.query({}).then((tabs) => {
    state.tabs = tabs.filter((tab) => {
      const url = tab.url || '';
      return tab.id != null && !url.startsWith('chrome-extension://') && !url.startsWith('devtools://');
    }).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

    const select = $('#tabSelect');
    if (!select) return;
    select.innerHTML = state.tabs
      .map((tab) => {
        const title = tab.title || (tab.url ? shortUrl(tab.url) : '新标签页');
        return `<option value="${tab.id}">#${tab.id} ${esc(title)}</option>`;
      })
      .join('');

    let targetId = null;
    const fromQuery = Number(preferredTabId);
    if (Number.isFinite(fromQuery) && state.tabs.some((t) => t.id === fromQuery)) {
      targetId = fromQuery;
    } else if (preferredTabId === undefined && state.tabId != null && state.tabs.some((t) => t.id === state.tabId)) {
      targetId = state.tabId;
    } else if (state.tabs.length) {
      targetId = state.tabs[0].id;
    }

    if (targetId == null) {
      state.tabId = null;
      scheduleRender();
      return;
    }
    state.tabId = targetId;
    select.value = String(targetId);
    subscribeTab(targetId);
    const tab = state.tabs.find((t) => t.id === targetId);
    if (tab && tab.url) {
      state.inspectedUrl = tab.url;
      updatePageUrl();
    }
  }).catch(() => {});
}

function refreshTabLabel(tab) {
  if (!tab || tab.id == null) return;
  const index = state.tabs.findIndex((t) => t.id === tab.id);
  if (index >= 0) state.tabs[index] = Object.assign({}, state.tabs[index], tab);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch (err) {
    return url;
  }
}

function connectInjectPort() {
  if (injectPort) return;
  try {
    injectPort = chrome.runtime.connect({ name: 'ni-panel' });
  } catch (err) {
    injectPort = null;
    return;
  }

  injectPort.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'snapshot') {
      applySnapshot(message.requests, message.paused);
    } else if (message.type === 'request') {
      addRequest(message.request);
    } else if (message.type === 'clear') {
      clearRequests();
    } else if (message.type === 'paused') {
      state.paused = Boolean(message.paused);
      updatePauseButton();
    }
  });

  injectPort.onDisconnect.addListener(() => {
    injectPort = null;
    clearTimeout(injectReconnectTimer);
    injectReconnectTimer = setTimeout(() => {
      connectInjectPort();
      if (state.tabId != null) subscribeTab(state.tabId);
    }, 800);
  });

  if (state.tabId != null) subscribeTab(state.tabId);
}

/**
 * storage.session 镜像刷新 / SW 重连后的整表快照：
 * 不能直接替换 state.requests（会丢掉选中态与已解析的响应体），改为按 id 合并。
 */
function mergeSnapshotRequest(oldReq, incoming) {
  // 本地已经解析好的响应体优先保留，避免镜像刷新把详情打回“未加载”
  if (oldReq._bodyState === 'ready' || oldReq._bodyState === 'empty') {
    incoming.respBody = oldReq.respBody;
    incoming._bodyState = oldReq._bodyState;
    incoming._entry = oldReq._entry || incoming._entry;
  }
  incoming._expanded = oldReq._expanded;
  incoming._offsets = oldReq._offsets;
  incoming._jsonView = oldReq._jsonView;
  return incoming;
}

function applySnapshot(list, paused) {
  const incomingList = Array.isArray(list) ? list : [];
  const existing = new Map(state.requests.map((item) => [item.id, item]));
  const merged = incomingList.map((incoming) => {
    const old = existing.get(incoming.id);
    return old ? mergeSnapshotRequest(old, incoming) : incoming;
  });

  state.requests = merged;
  const pausedValue = Boolean(paused);
  if (state.paused !== pausedValue) {
    state.paused = pausedValue;
    updatePauseButton();
  }

  // 选中的请求若被后台移出缓冲，用快照继续展示，而不是清空详情
  if (state.selectedId != null && !merged.some((item) => item.id === state.selectedId)) {
    const kept = existing.get(state.selectedId) || state.selectedSnapshot;
    if (kept && kept.id === state.selectedId) {
      kept._outOfBuffer = true;
      state.selectedSnapshot = kept;
    } else {
      state.selectedId = null;
      state.selectedSnapshot = null;
    }
  }
  scheduleRender();
}

function subscribeTab(tabId, options) {
  const opts = options || {};
  const changed = state.tabId !== tabId;
  state.tabId = tabId;
  // 仅在真正切换标签页（或显式 reset）时清空数据与选中；
  // SW 回收导致的同 tab 重连不能重置，否则用户选中的详情会“自己消失”。
  if (changed || opts.reset) {
    state.requests = [];
    state.selectedId = null;
    state.selectedSnapshot = null;
    state.ui.localMatchIndex = 0;
  }
  if (injectPort) {
    injectPort.postMessage({ type: 'subscribe', tabId });
  }
  scheduleRender();
}

function setPaused(paused) {
  state.paused = paused;
  updatePauseButton();
  if (state.mode === 'inject' && injectPort) {
    injectPort.postMessage({ type: paused ? 'pause' : 'resume' });
  }
}

function clearCurrent() {
  clearRequests();
  if (state.mode === 'inject' && injectPort) {
    injectPort.postMessage({ type: 'clear' });
  }
}
