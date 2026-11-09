/*
 * panel-render.js —— 请求列表与详情框架（Headers / Payload / Raw）
 */
'use strict';

let renderTimer = null;
let lastDetailKey = null;
// 列表行按请求 id 缓存，实现增量渲染（复用 DOM、保留滚动位置）
const listRowCache = new Map();

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll(false);
  }, 60);
}

function renderAll(forceDetail) {
  renderList();
  const current = selectedRequest();
  // 关键字 / URL 范围变化会影响详情内的高亮，需要一并纳入缓存键
  const key = [
    state.selectedId,
    state.detailTab,
    cleanKeyword(state.ui.keyword),
    state.ui.caseInsensitive ? 'i' : 's',
    state.ui.secUrl ? 'u' : '-',
    current && current._outOfBuffer ? 'oob' : 'ok',
  ].join('|');
  if (forceDetail || key !== lastDetailKey) {
    lastDetailKey = key;
    renderDetail();
  }
}

function requestRowCells(req, selectedId) {
  const match = computeMatch(req);
  const flags = [];
  if (match) {
    if (match.headers) flags.push('<span class="flag h" title="命中 Header">H</span>');
    if (match.url) flags.push('<span class="flag u" title="命中 URL">U</span>');
    if (match.payload) flags.push('<span class="flag p" title="命中 Payload">P</span>');
    if (match.response) flags.push('<span class="flag r" title="命中响应体">R</span>');
  }
  if (requestHasCustomHeader(req)) flags.push('<span class="flag custom" title="含自定义 Header">自定义</span>');
  if (req.status === 0 || req.error) flags.push('<span class="flag err" title="请求失败">失败</span>');

  const size = Number(req.size) || Number(req.respBody && req.respBody.size) || 0;
  return `<span class="method ${esc(methodClass(req.method))}">${esc(req.method)}</span>
      <span class="status ${statusClass(req.status)}">${req.status || '—'}</span>
      <span class="url-cell" title="${esc(req.url)}">${esc(shortUrl(req.url))}</span>
      <span class="type-cell">${esc(mimeLabel(contentTypeOf(req), req.url))}</span>
      <span class="size-cell">${formatBytes(size)}</span>
      <span class="time-cell">${formatDuration(req.duration)}</span>
      <span class="flags-cell">${flags.join('')}</span>`;
}

// 行内容签名：只有签名变化时才重建该行，其余行原样复用
function requestRowSignature(req, selectedId) {
  const match = computeMatch(req);
  return [
    req.id,
    req.method,
    req.status,
    req.statusText,
    req.url,
    Number(req.size) || 0,
    req.duration,
    selectedId === req.id ? '1' : '0',
    match ? `${match.headers}|${match.url}|${match.payload}|${match.response}` : '-',
    requestHasCustomHeader(req) ? 'c' : '-',
    req.error || '-',
  ].join('|');
}

function createRequestRow(req, selectedId, signature) {
  const row = document.createElement('div');
  row.className = 'request-row' + (req.id === selectedId ? ' selected' : '');
  row.dataset.id = req.id;
  row.dataset.sig = signature;
  row.innerHTML = requestRowCells(req, selectedId);
  return row;
}

/**
 * 增量渲染列表：按 id 复用已有行，仅重排 / 局部替换。
 * 这样新请求到达、响应体加载完成、或 storage.session 快照刷新时，
 * 都不会整表重建（滚动位置与选中行不会闪一下）。
 */
function renderList() {
  const listNode = $('#requestList');
  const emptyNode = $('#listEmpty');
  if (!listNode) return;

  const items = visibleRequests();
  const selectedId = state.selectedId;

  let cursor = listNode.firstElementChild;
  for (const req of items) {
    const signature = requestRowSignature(req, selectedId);
    let row = listRowCache.get(req.id);
    if (!row) {
      row = createRequestRow(req, selectedId, signature);
      listRowCache.set(req.id, row);
    } else if (row.dataset.sig !== signature) {
      row.className = 'request-row' + (req.id === selectedId ? ' selected' : '');
      row.dataset.sig = signature;
      row.innerHTML = requestRowCells(req, selectedId);
    }
    if (row === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      listNode.insertBefore(row, cursor);
    }
  }

  // 移除不再可见的行（被过滤掉、被缓冲挤出，或请求被清空）
  while (cursor) {
    const next = cursor.nextElementSibling;
    if (cursor.dataset.id) listRowCache.delete(cursor.dataset.id);
    cursor.remove();
    cursor = next;
  }

  if (state.requests.length === 0) {
    emptyNode.style.display = 'block';
    emptyNode.innerHTML = '暂无请求。<br><span class="muted">DevTools 面板打开后刷新页面；注入模式下请求会随页面实时出现。</span>';
  } else if (items.length === 0) {
    emptyNode.style.display = 'block';
    emptyNode.innerHTML = '没有符合当前过滤条件的请求。<br><span class="muted">试试清空关键字、取消“仅自定义 Header”或切换方法/状态过滤。</span>';
  } else {
    emptyNode.style.display = 'none';
  }

  const countNode = $('#countInfo');
  if (countNode) {
    countNode.textContent = `显示 ${items.length} / 共 ${state.requests.length} 条`;
  }
}

function detailTabButton(tab, label) {
  return `<button class="detail-tab${state.detailTab === tab ? ' active' : ''}" data-tab="${tab}">${label}</button>`;
}

function renderDetail() {
  const pane = $('#detailPane');
  if (!pane) return;
  const req = selectedRequest();
  if (!req) {
    pane.innerHTML = '<div class="empty-state">选择左侧请求查看详细信息</div>';
    lastDetailKey = String(state.selectedId) + '|' + state.detailTab + '|ok';
    return;
  }

  const sensitive = requestHasSensitiveHeaders(req);
  const urlKeyword = state.ui.secUrl ? cleanKeyword(state.ui.keyword) : '';
  const size = Number(req.size) || Number(req.respBody && req.respBody.size) || 0;
  const sourceLabel = req.source === 'devtools' ? 'DevTools HAR' : '页面注入';
  const errorBadge = req.error ? `<span class="flag err">${esc(req.error)}</span>` : '';
  const outOfBufferHint = req._outOfBuffer
    ? '<div class="note-box out-of-buffer">该请求已超出缓冲：列表中可能已不再显示它，以下内容来自本地快照，重新选择其他请求前会一直保留。</div>'
    : '';

  const head = `<div class="detail-head">
    <div class="detail-title">
      <span class="method ${esc(methodClass(req.method))}">${esc(req.method)}</span>
      <span class="status ${statusClass(req.status)}">${req.status || '—'} ${esc(req.statusText || '')}</span>
      ${errorBadge}
      <button class="detail-close" data-action="close-detail" title="关闭详情（Esc）">&#215;</button>
    </div>
    <div class="detail-url">${highlightHtml(req.url, urlKeyword)}</div>
    <div class="detail-meta">
      <span>耗时 ${formatDuration(req.duration)}</span>
      <span>大小 ${formatBytes(size)}</span>
      <span>类型 ${esc(mimeLabel(contentTypeOf(req), req.url))}</span>
      <span>来源 ${sourceLabel}${req.frameIsMain === false ? '（子框架）' : ''}</span>
    </div>
    <div class="copy-bar">
      <span class="label">复制请求</span>
      <button class="copy-btn${sensitive ? ' warn' : ''}" data-copy="curl" title="${sensitive ? '包含 Authorization/Cookie 等敏感信息' : '可直接在终端执行'}">cURL</button>
      <button class="copy-btn${sensitive ? ' warn' : ''}" data-copy="fetch" title="${sensitive ? '包含 Authorization/Cookie 等敏感信息' : ''}">fetch</button>
      <button class="copy-btn${sensitive ? ' warn' : ''}" data-copy="raw" title="${sensitive ? '包含 Authorization/Cookie 等敏感信息' : ''}">URL + Headers</button>
    </div>
    <div class="detail-tabs">
      ${detailTabButton('headers', 'Headers')}
      ${detailTabButton('payload', 'Payload')}
      ${detailTabButton('response', 'Response')}
      ${detailTabButton('raw', 'Raw')}
    </div>
    ${['response', 'raw', 'payload'].includes(state.detailTab) ? buildLocalSearchBar(req) : ''}
  </div>`;

  let bodyHtml = '';
  if (state.detailTab === 'payload') bodyHtml = buildPayloadTab(req);
  else if (state.detailTab === 'response') bodyHtml = buildResponseTab(req);
  else if (state.detailTab === 'raw') bodyHtml = buildRawTab(req);
  else bodyHtml = buildHeadersTab(req);

  pane.innerHTML = `<div class="detail-inner">${head}${outOfBufferHint}<div class="detail-body" id="detailBody">${bodyHtml}</div></div>`;

  if (['response', 'raw', 'payload'].includes(state.detailTab)) {
    // 渲染完成后重新定位局部搜索命中（展开的 JSON 节点已在此次渲染中生效）
    requestAnimationFrame(() => focusLocalMatch(false));
  }
}

function headerRows(req, kind, keyword) {
  const source = kind === 'request' ? req.reqHeaders : req.respHeaders;
  const entries = Object.entries(source || {});
  if (!entries.length) {
    return '<div class="hint">无（可能是跨域限制，或响应头未被暴露）</div>';
  }
  return `<div class="kv-table">${entries.map(([name, value], index) => {
    const custom = isCustomHeader(name, kind);
    const badge = custom ? '<span class="badge-custom">自定义</span>' : '';
    return `<div class="kv-row">
      <span class="kv-name"><span class="kv-index">${index + 1}</span>${highlightHtml(name, keyword)}${badge}</span>
      <span class="kv-value">${highlightHtml(value, keyword)}</span>
    </div>`;
  }).join('')}</div>`;
}

function buildHeadersTab(req) {
  const kw = state.ui.secHeaders ? cleanKeyword(state.ui.keyword) : '';
  const urlKw = state.ui.secUrl ? cleanKeyword(state.ui.keyword) : '';
  const reqCount = Object.keys(req.reqHeaders || {}).length;
  const resCount = Object.keys(req.respHeaders || {}).length;
  const size = Number(req.size) || Number(req.respBody && req.respBody.size) || 0;

  return `
    <div class="section-title">概要</div>
    <div class="kv-table">
      <div class="kv-row"><span class="kv-name">请求 URL</span><span class="kv-value">${highlightHtml(req.url, urlKw)}</span></div>
      <div class="kv-row"><span class="kv-name">方法 / 状态</span><span class="kv-value">${esc(req.method)} · ${req.status || 0} ${esc(req.statusText || '')}</span></div>
      <div class="kv-row"><span class="kv-name">耗时</span><span class="kv-value">${formatDuration(req.duration)}</span></div>
      <div class="kv-row"><span class="kv-name">大小</span><span class="kv-value">${formatBytes(size)}</span></div>
      <div class="kv-row"><span class="kv-name">Content-Type</span><span class="kv-value">${esc(contentTypeOf(req) || '—')}</span></div>
      <div class="kv-row"><span class="kv-name">数据来源</span><span class="kv-value">${req.source === 'devtools' ? 'DevTools HAR（onRequestFinished）' : '页面注入（fetch/XHR 包装）'}</span></div>
    </div>
    ${req.error ? `<div class="error-box" style="margin-top:10px">${esc(req.error)}</div>` : ''}
    <div class="section-title">请求 Header <span class="count">(${reqCount})</span></div>
    ${headerRows(req, 'request', kw)}
    <div class="section-title">响应 Header <span class="count">(${resCount})</span></div>
    ${headerRows(req, 'response', kw)}
  `;
}

function requestBodySize(req) {
  const body = req.reqBody;
  if (!body) return 0;
  return Number(body.size) || (body.text ? body.text.length : 0);
}

function bodyCopyActions(extraHtml) {
  return `<div class="body-actions">
    <button class="btn" data-copy-body="raw">复制原始 body</button>
    <button class="btn" data-action="download-request-body">下载原始 body</button>
    ${extraHtml || ''}
  </div>`;
}

/** multipart/form-data：字段列表 + 文件占位信息 */
function buildMultipartBody(body, kw) {
  const fields = body.formFields || [];
  return `<div class="body-actions">
      <button class="btn" data-copy-body="raw">复制原始请求体</button>
    </div>
    <div class="hint">multipart/form-data 已被还原为字段列表；文件内容未捕获，cURL 中会生成 @ 路径占位。</div>
    <div class="kv-table">${fields.map((field, index) => `
      <div class="kv-row">
        <span class="kv-name"><span class="kv-index">${index + 1}</span>${highlightHtml(field.name, kw)}</span>
        <span class="kv-value">${field.isFile || field.fileName
          ? `<span class="file-chip">[File]</span> ${esc(field.fileName || '未命名文件')} · ${formatBytes(field.fileSize || 0)}`
          : highlightHtml(field.value == null ? '' : field.value, kw)}</span>
      </div>`).join('')}</div>
    <div class="section-title">可读结构</div><pre class="code-block">${highlightHtml(body.text || '', kw)}</pre>`;
}

/** application/x-www-form-urlencoded：解码后的字段表格，可切换原始串 */
function buildUrlEncodedBody(body, kw) {
  const view = state.ui.formBodyView === 'raw' ? 'raw' : 'table';
  const fields = Array.isArray(body.formFields) && body.formFields.length
    ? body.formFields.map((field) => ({ name: field.name, value: field.value == null ? '' : field.value }))
    : parseUrlEncoded(body.text || '');

  const actions = `<div class="body-actions">
    <button class="btn${view === 'table' ? ' primary' : ''}" data-action="form-body-view-table">字段表格</button>
    <button class="btn${view === 'raw' ? ' primary' : ''}" data-action="form-body-view-raw">原始串</button>
    <button class="btn" data-copy-body="raw">复制原始 body</button>
    <button class="btn" data-action="download-request-body">下载原始 body</button>
  </div>`;

  if (view === 'raw') {
    return `${actions}<pre class="code-block">${highlightHtml(trimForDisplay(body.text || ''), kw)}</pre>`;
  }
  return `${actions}
    <div class="hint">已按 form-urlencoded 规则解码（+ 视为空格）为 ${fields.length} 个字段。</div>
    <div class="kv-table">${fields.map((field, index) => `
      <div class="kv-row">
        <span class="kv-name"><span class="kv-index">${index + 1}</span>${highlightHtml(field.name, kw)}</span>
        <span class="kv-value">${highlightHtml(field.value, kw)}</span>
      </div>`).join('')}</div>`;
}

/** JSON 请求体：默认格式化折叠树，可切换原始 body */
function buildJsonBody(req, body, info, kw) {
  const view = state.ui.reqBodyView === 'raw' ? 'raw' : 'formatted';
  const actions = `<div class="body-actions">
    <button class="btn${view === 'formatted' ? ' primary' : ''}" data-action="req-body-view-json">格式化 JSON</button>
    <button class="btn${view === 'raw' ? ' primary' : ''}" data-action="req-body-view-raw">原始 body</button>
    <button class="btn" data-copy-body="raw">复制原始 body</button>
    <button class="btn" data-copy-body="json">复制格式化 JSON</button>
    <button class="btn" data-action="download-request-body">下载原始 body</button>
  </div>`;

  const notes = [];
  if (!info.mimeJson) {
    notes.push(`Content-Type 为 ${esc(info.mime || '未提供')}，内容可解析为 JSON，已按 JSON 展示。`);
  }
  if (body.truncated) {
    notes.push('请求体已截断，格式化结果可能不完整；复制/下载仍是已捕获的原始内容。');
  }
  const noteHtml = notes.length ? `<div class="hint">${notes.join('<br>')}</div>` : '';

  if (view === 'raw') {
    return `${actions}${noteHtml}<pre class="code-block">${highlightHtml(trimForDisplay(body.text || ''), kw)}</pre>`;
  }
  if (!isPlainContainer(info.value)) {
    // 顶层是字符串 / 数字 / 布尔等标量，直接展示格式化结果
    const pretty = JSON.stringify(info.value, null, 2);
    return `${actions}${noteHtml}<pre class="code-block">${highlightHtml(trimForDisplay(pretty), kw)}</pre>`;
  }
  // 搜索命中路径自动展开（局部搜索优先，其次顶部关键字）
  prepareJsonSearchExpansion(req, kw, info.value, 'payload');
  return `${actions}${noteHtml}${buildJsonTreeHtml(req, info.value, kw, 'payload')}`;
}

function buildPayloadTab(req) {
  // 详情内局部搜索优先；未设置时沿用顶部全局关键字
  const kw = localSearchKeyword() || (state.ui.secPayload ? cleanKeyword(state.ui.keyword) : '');
  const body = req.reqBody;
  const parts = [];

  let queryParams = [];
  try {
    const url = new URL(req.url);
    queryParams = Array.from(url.searchParams.entries());
  } catch (err) {
    queryParams = [];
  }

  if (queryParams.length) {
    parts.push(`<div class="section-title">Query 参数 <span class="count">(${queryParams.length})</span></div>`);
    parts.push(`<div class="kv-table">${queryParams.map(([name, value], index) => `
      <div class="kv-row">
        <span class="kv-name"><span class="kv-index">${index + 1}</span>${highlightHtml(name, kw)}</span>
        <span class="kv-value">${highlightHtml(value, kw)}</span>
      </div>`).join('')}</div>`);
  }

  parts.push('<div class="section-title">请求体</div>');

  if (!body) {
    parts.push('<div class="hint">该请求没有请求体。</div>');
    return parts.join('');
  }

  if (body.kind === 'form') {
    parts.push(buildMultipartBody(body, kw));
    return parts.join('');
  }

  if (body.kind === 'binary') {
    parts.push(`<div class="note-box">${esc(body.note || '二进制请求体，内容未捕获。')}<br>大小：${formatBytes(body.size)} · 类型：${esc(body.mimeType || bodyMime(req) || '—')}</div>`);
    parts.push('<div class="hint">复制 cURL 时会生成 --data-binary @/path/to/file 占位，需要手动替换文件路径。</div>');
    return parts.join('');
  }

  const mime = bodyMime(req) || '';
  const essence = mimeEssence(mime);
  const size = requestBodySize(req);
  const threshold = state.settings.parseThresholdBytes;

  if (size > threshold) {
    // 超大请求体不解析，只给大小/类型与复制、下载入口
    parts.push(`<div class="note-box">请求体 ${formatBytes(size)}，超过解析阈值 ${state.settings.parseThresholdKB} KB，已跳过格式化与折叠树解析（避免渲染卡顿）。</div>`);
    parts.push(`<div class="hint">Content-Type：${esc(mime || '未提供')}${body.truncated ? ' · 已截断' : ''}</div>`);
    parts.push(bodyCopyActions(''));
    return parts.join('');
  }

  const jsonInfo = requestBodyJsonInfo(req);
  if (jsonInfo.isJson) {
    parts.push(buildJsonBody(req, body, jsonInfo, kw));
    return parts.join('');
  }

  const isUrlEncoded =
    essence === 'application/x-www-form-urlencoded' ||
    (Array.isArray(body.formFields) && body.formFields.length > 0 && !/multipart/.test(essence));
  if (isUrlEncoded) {
    parts.push(buildUrlEncodedBody(body, kw));
    return parts.join('');
  }

  if (jsonInfo.mimeJson) {
    parts.push(`<div class="note-box">Content-Type 声明为 JSON，但内容解析失败，已按纯文本展示。</div>`);
  }
  parts.push(bodyCopyActions(''));
  parts.push(`<div class="hint">Content-Type：${esc(mime || '未提供')}${body.truncated ? ' · 请求体已截断' : ''}</div>`);
  parts.push(`<pre class="code-block">${highlightHtml(trimForDisplay(body.text || ''), kw)}</pre>`);
  return parts.join('');
}

function buildRawTab(req) {
  // 局部搜索优先；未设置时沿用顶部全局关键字（不影响列表过滤）
  const kw = localSearchKeyword() || cleanKeyword(state.ui.keyword);
  return `<div class="body-actions">
      <button class="btn" data-copy="raw">复制 URL + Headers</button>
      <button class="btn" data-copy="curl">复制 cURL</button>
    </div>
    <pre class="code-block">${highlightHtml(buildRawDump(req), kw)}</pre>`;
}

function updatePauseButton() {
  const btn = $('#pauseBtn');
  if (!btn) return;
  btn.textContent = state.paused ? '继续' : '暂停';
  btn.classList.toggle('active', state.paused);
}

// 详情头部、Payload、Raw 中按钮统一由 main.js 的委托事件处理
