/*
 * panel-response.js —— Response 标签页、JSON 折叠树与超大响应保护
 */
'use strict';

function jsonChildPath(base, key, isIndex) {
  if (isIndex) return `${base}[${key}]`;
  const text = String(key);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) return `${base}.${text}`;
  return `${base}[${JSON.stringify(text)}]`;
}

function isPlainContainer(value) {
  return value !== null && typeof value === 'object';
}

function jsonPrimitiveHtml(value, keyword) {
  if (value === null) return '<span class="jn-value-null">null</span>';
  if (typeof value === 'string') {
    const shown = value.length > 100 ? value.slice(0, 100) : value;
    const tail = value.length > 100 ? '…' : '';
    return `<span class="jn-value-string">"${highlightHtml(shown, keyword)}${tail}"</span>`;
  }
  if (typeof value === 'number') return `<span class="jn-value-number">${value}</span>`;
  if (typeof value === 'boolean') return `<span class="jn-value-boolean">${value}</span>`;
  return `<span class="jn-value-null">${esc(String(value))}</span>`;
}

function buildJsonNodeHtml(req, value, key, path, depth, keyword, registry) {
  const isRoot = key === null;
  const isArray = Array.isArray(value);
  const isObject = isPlainContainer(value) && !isArray;
  const isContainer = isArray || isObject;

  const nodeId = registry.nextId++;
  registry.map.set(nodeId, { value, path });

  if (!req._expanded) req._expanded = new Set(['$']);
  // 局部搜索命中的路径会被临时展开（不写回用户的 _expanded，清空搜索后恢复原状）
  const expanded =
    isContainer && (req._expanded.has(path) || (req._searchExpanded && req._searchExpanded.has(path)));

  let keyHtml = '';
  if (isRoot) {
    keyHtml = '<span class="jn-key root-key">$</span>';
  } else {
    keyHtml = `<span class="jn-key">${highlightHtml(key, keyword)}${isArray ? '' : ':'}</span>`;
  }

  let preview = '';
  if (isArray) {
    preview = `<span class="jn-type">Array(${value.length})</span>${expanded ? '' : ' …'}`;
  } else if (isObject) {
    const keys = Object.keys(value);
    preview = `<span class="jn-type">{…} ${keys.length} keys</span>`;
  } else {
    preview = jsonPrimitiveHtml(value, keyword);
  }

  const actions = `<span class="jn-actions">
    <button data-act="copy-value" data-node="${nodeId}" title="复制该节点 JSON">复制值</button>
    <button data-act="copy-path" data-node="${nodeId}" title="复制 JSONPath">复制路径</button>
  </span>`;

  let children = '';
  if (isContainer && expanded) {
    const keys = isArray ? Array.from({ length: value.length }, (_, i) => i) : Object.keys(value);
    const offset = (req._offsets && req._offsets.get(path)) || 0;
    const LIMIT = 100;
    const slice = keys.slice(offset, offset + LIMIT);
    const childHtml = slice
      .map((childKey) =>
        buildJsonNodeHtml(
          req,
          value[childKey],
          isArray ? childKey : String(childKey),
          jsonChildPath(path, childKey, isArray),
          depth + 1,
          keyword,
          registry
        )
      )
      .join('');
    const remaining = keys.length - offset - LIMIT;
    children = `<div class="jn-children">${childHtml}${
      remaining > 0
        ? `<div class="jn-more"><button data-more="${esc(path)}">显示更多（剩余 ${remaining} 项）</button></div>`
        : ''
    }</div>`;
  } else if (isContainer) {
    children = '<div class="jn-children hidden"></div>';
  }

  const arrow = isContainer ? (expanded ? '▾' : '▸') : '·';
  return `<div class="jn-node${isRoot ? ' jn-root' : ''}" data-depth="${depth}">
    <div class="jn-row" data-path="${esc(path)}" data-explode="${isContainer ? '1' : '0'}">
      <span class="jn-toggle${isContainer ? '' : ' leaf'}" data-toggle="1" data-path="${esc(path)}">${arrow}</span>
      ${keyHtml}
      <span class="jn-preview">${preview}</span>
      ${actions}
    </div>
    ${children}
  </div>`;
}

function buildJsonTreeHtml(req, value, keyword) {
  const registry = { nextId: 0, map: new Map() };
  req._jsonNodeMap = registry.map;
  return `<div class="json-tree">${buildJsonNodeHtml(req, value, null, '$', 0, keyword, registry)}</div>`;
}

function jsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, value: null };
  }
}

function downloadButtons() {
  return `<div class="body-actions" style="margin-top:8px">
    <button class="btn" data-action="download-original">下载原始响应</button>
    <button class="btn" data-action="download-text">下载为 txt</button>
  </div>`;
}

function oversizeBox(size, mime, deferred) {
  const thresholdKB = state.settings.parseThresholdKB;
  return `<div class="note-box">
    响应体 ${formatBytes(size)}，超过解析阈值 ${thresholdKB} KB，已跳过 JSON 解析与树渲染。
    <br>Content-Type：${esc(mime || '未知')}${deferred ? '<br>响应体尚未从 DevTools 读取，点击下载时会按需加载。' : ''}
  </div>
  <div class="download-box">
    <span class="meta">大小 ${formatBytes(size)}</span>
    <button class="btn" data-action="download-original">下载原始响应</button>
    <button class="btn" data-action="download-text">下载为 txt</button>
  </div>`;
}

function buildResponseTab(req) {
  const rawBody = req.respBody;
  const mime = contentTypeOf(req);
  const size = Number(rawBody && rawBody.size) || Number(req.size) || 0;
  const threshold = state.settings.parseThresholdBytes;
  // 局部搜索优先：它与顶部全局关键字完全独立，且不参与列表过滤
  const localKw = localSearchKeyword();
  const kw = localKw || (state.ui.secResponse ? cleanKeyword(state.ui.keyword) : '');

  if (!rawBody) {
    return `<div class="note-box">响应体不可用。</div>`;
  }

  if (rawBody.kind === 'deferred' || rawBody.kind === 'loading') {
    const loading = rawBody.kind === 'loading' || req._bodyState === 'loading';
    if (loading) return '<div class="hint">正在从 DevTools 读取响应体…</div>';
    if (size > threshold) return oversizeBox(size, mime, true);
    return `<div class="hint">响应体尚未读取（${formatBytes(size)}），可以按需加载后查看或下载。</div>
      <div class="body-actions">
        <button class="btn" data-action="load-body">加载响应体</button>
        <button class="btn" data-action="download-original">下载原始响应</button>
        <button class="btn" data-action="download-text">下载为 txt</button>
      </div>`;
  }

  if (rawBody.kind === 'none' || rawBody.kind === 'empty') {
    return `<div class="note-box">${esc(rawBody.note || '没有可用的响应体。')}</div>
      ${req.error ? `<div class="error-box">${esc(req.error)}</div>` : ''}`;
  }

  if (rawBody.kind === 'base64') {
    // 文本类型但以 base64 存储（HAR encoding=base64），小体积时解码展示
    const textual = isTextualMime(mime);
    if (textual && size <= threshold) {
      const text = base64ToText(rawBody.data || '');
      return `<div class="hint">HAR 以 Base64 返回了文本内容，已解码展示；下载按钮仍导出原始字节。</div>
        <pre class="code-block">${highlightHtml(trimForDisplay(text), kw)}</pre>
        ${downloadButtons()}`;
    }
    const stream = isStreamMime(mime);
    return `<div class="download-box">
      <span class="meta">${stream ? '流式响应' : '二进制响应'} · ${formatBytes(size)} · ${esc(mime || '未知类型')}</span>
      <button class="btn" data-action="download-original">下载原始响应</button>
      <button class="btn" data-action="download-text">下载为 txt</button>
    </div>
    <div class="hint">二进制内容不进入 JSON 树；下载按钮会使用 DevTools 返回的原始 base64 数据重建 Blob。</div>`;
  }

  // text
  const text = rawBody.text || '';
  if (size > threshold) {
    return oversizeBox(size, mime, false);
  }

  const parsed = jsonParse(text);
  const looksJson = parsed.ok && (isPlainContainer(parsed.value));
  const isJson = looksJson && (/\bjson\b/i.test(mime) || text.trim().startsWith('{') || text.trim().startsWith('['));

  if (isJson) {
    if (!req._jsonView) req._jsonView = 'tree';
    const tabs = `<div class="body-actions">
      <button class="btn${req._jsonView === 'tree' ? ' primary' : ''}" data-action="json-view-tree">树视图</button>
      <button class="btn${req._jsonView === 'raw' ? ' primary' : ''}" data-action="json-view-raw">原始文本</button>
      <button class="btn" data-action="download-original">下载原始响应</button>
      <button class="btn" data-action="download-text">下载为 txt</button>
    </div>`;
    if (req._jsonView === 'raw') {
      prepareJsonSearchExpansion(req, null);
      return tabs + `<pre class="code-block">${highlightHtml(trimForDisplay(text), kw)}</pre>`;
    }
    // 局部搜索命中时会自动展开对应 JSON 路径，保证命中点可见
    prepareJsonSearchExpansion(req, localKw, parsed.value);
    return tabs + buildJsonTreeHtml(req, parsed.value, kw);
  }

  let extraNote = '';
  if (rawBody.note) {
    extraNote += `<div class="note-box">${esc(rawBody.note)}</div>`;
  }
  if (isStreamMime(mime)) {
    extraNote += '<div class="note-box">流式响应（如 SSE）：这里只展示已接收/已缓存的部分，不能代表完整时长内的全部事件。</div>';
  }
  if (rawBody.truncated) {
    extraNote += `<div class="note-box">响应体读取达到上限，已截断（已捕获 ${formatBytes(rawBody.capturedBytes || 0)} / 总大小 ${formatBytes(size)}）。</div>`;
  }
  return `${extraNote}<pre class="code-block">${highlightHtml(trimForDisplay(text), kw)}</pre>${downloadButtons()}`;
}

function onRequestUpdated(req) {
  if (!req) return;
  // 快照合并可能替换了请求对象实例，这里把最新的响应体同步到列表中的实时对象
  const live = findRequest(req.id);
  if (live && live !== req) {
    live.respBody = req.respBody;
    live._bodyState = req._bodyState;
    live._entry = live._entry || req._entry;
  }
  if (state.selectedId === req.id) {
    renderDetail();
    const current = selectedRequest();
    lastDetailKey = String(state.selectedId) + '|' + state.detailTab + '|' + (current && current._outOfBuffer ? 'oob' : 'ok');
  }
  renderList();
}

// 在模型里初始化展开/偏移状态
function ensureJsonState(req) {
  if (!req._expanded) req._expanded = new Set(['$']);
  if (!req._offsets) req._offsets = new Map();
}

// ---------------------------------------------------------------- 响应区局部搜索
// 与顶部全局关键字完全独立：只作用于 Response / Raw 内容，不影响列表过滤。

function localSearchKeyword() {
  return cleanKeyword(state.ui.localKeyword);
}

function localTextHit(text, keyword) {
  if (!keyword) return false;
  const hay = state.ui.caseInsensitive ? String(text).toLowerCase() : String(text);
  const needle = state.ui.caseInsensitive ? keyword.toLowerCase() : keyword;
  return hay.includes(needle);
}

function localPrimitiveHit(value, keyword) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return localTextHit(value, keyword);
  if (typeof value === 'number' || typeof value === 'boolean') return localTextHit(String(value), keyword);
  return false;
}

const LOCAL_SCAN_MAX_NODES = 20000;

/**
 * 遍历 JSON，收集命中节点路径：
 * - 叶子 / key 命中时，让父容器展开；
 * - 子树有命中时，把子容器本身也加入展开集合。
 */
function scanJsonMatches(value, path, keyword, expandSet, counter) {
  if (!keyword) return false;
  if (counter.n > LOCAL_SCAN_MAX_NODES) return false;
  counter.n += 1;

  if (value === null || typeof value !== 'object') {
    return localPrimitiveHit(value, keyword);
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  let matched = false;
  for (const [key, child] of entries) {
    const childPath = jsonChildPath(path, key, isArray);
    let childMatched = false;
    if (child !== null && typeof child === 'object') {
      childMatched = scanJsonMatches(child, childPath, keyword, expandSet, counter);
      if (childMatched) expandSet.add(childPath);
    } else {
      childMatched = localPrimitiveHit(child, keyword);
    }
    if (!isArray && localTextHit(String(key), keyword)) childMatched = true;
    if (childMatched) matched = true;
  }
  return matched;
}

function prepareJsonSearchExpansion(req, keyword, value) {
  req._searchExpanded = null;
  if (!req || !keyword || !isPlainContainer(value)) return;
  const expandSet = new Set();
  scanJsonMatches(value, '$', keyword, expandSet, { n: 0 });
  if (expandSet.size) req._searchExpanded = expandSet;
}

function localSearchUnsupportedReason(req, tab) {
  // Raw 视图始终可以搜索（至少包含请求/响应头文本）
  if (tab === 'raw') return '';
  const body = req && req.respBody;
  if (!body) return '当前没有可搜索的响应内容';
  const size = Number(body.size) || Number(req.size) || 0;
  const threshold = state.settings.parseThresholdBytes;

  if (body.kind === 'deferred' || body.kind === 'loading' || req._bodyState === 'loading') {
    if (size > threshold) return '响应过大未解析，可下载后搜索';
    if (req._bodyState === 'loading') return '正在读取响应体…';
    return '响应体尚未加载，可先点击“加载响应体”';
  }
  if (body.kind === 'none' || body.kind === 'empty') return '当前没有可搜索的响应内容';
  if (body.kind === 'base64') {
    const textual = isTextualMime(contentTypeOf(req));
    return textual && size <= threshold ? '' : '二进制响应不可搜索';
  }
  if (size > threshold) return '响应过大未解析，可下载后搜索';
  return '';
}

function buildLocalSearchBar(req) {
  const reason = localSearchUnsupportedReason(req, state.detailTab);
  const disabled = Boolean(reason);
  const kw = state.ui.localKeyword || '';
  return `<div class="local-search-bar${disabled ? ' disabled' : ''}" id="localSearchBar">
    <span class="local-search-tag">响应内搜索</span>
    <div class="local-search-input">
      <input id="localSearchInput" type="text" spellcheck="false" autocomplete="off"
             placeholder="与顶部搜索独立，不影响列表过滤" value="${esc(kw)}"${disabled ? ' disabled' : ''}>
      <button class="clear-input${kw ? ' show' : ''}" data-local-action="clear" title="清空局部搜索"${disabled ? ' disabled' : ''}>&times;</button>
    </div>
    <button class="toggle${state.ui.caseInsensitive ? ' on' : ''}" data-local-action="case" title="大小写不敏感（与全局搜索同步）">Aa</button>
    <span class="local-search-status" id="localSearchStatus">${disabled ? esc(reason) : ''}</span>
    <button class="btn" data-local-action="prev" title="上一个命中（Shift+Enter）"${disabled ? ' disabled' : ''}>&#9650; 上一个</button>
    <button class="btn" data-local-action="next" title="下一个命中（Enter）"${disabled ? ' disabled' : ''}>&#9660; 下一个</button>
  </div>`;
}

function localMarkElements() {
  const body = $('#detailBody');
  return body ? $$('mark', body) : [];
}

function updateLocalSearchStatus(marks) {
  const statusNode = $('#localSearchStatus');
  if (!statusNode) return;
  const bar = $('#localSearchBar');
  if (bar && bar.classList.contains('disabled')) return;

  const keyword = localSearchKeyword();
  if (!keyword) {
    statusNode.textContent = '';
    statusNode.classList.remove('zero');
    return;
  }
  const total = marks ? marks.length : 0;
  statusNode.classList.toggle('zero', total === 0);
  statusNode.textContent = total
    ? `${total} 处命中 · 第 ${Math.min(state.ui.localMatchIndex + 1, total)} / ${total}`
    : '0 处命中';
}

/**
 * 高亮当前命中项并（可选）滚动定位。
 * 命中若位于折叠的 JSON 节点内，buildResponseTab 已提前展开对应路径。
 */
function focusLocalMatch(scroll) {
  const marks = localMarkElements();
  if (marks.length && (state.ui.localMatchIndex < 0 || state.ui.localMatchIndex >= marks.length)) {
    state.ui.localMatchIndex = 0;
  }
  marks.forEach((mark, index) => mark.classList.toggle('mark-current', index === state.ui.localMatchIndex));
  if (scroll && marks[state.ui.localMatchIndex]) {
    marks[state.ui.localMatchIndex].scrollIntoView({ block: 'center' });
  }
  updateLocalSearchStatus(marks);
}

function jumpLocalMatch(direction) {
  const marks = localMarkElements();
  if (!marks.length) {
    updateLocalSearchStatus(marks);
    return;
  }
  state.ui.localMatchIndex = (state.ui.localMatchIndex + direction + marks.length) % marks.length;
  focusLocalMatch(true);
}

/** 只重渲染响应内容区，保留局部搜索输入框的焦点与光标 */
function updateResponseBody(scrollToFirst) {
  const req = selectedRequest();
  const body = $('#detailBody');
  if (!req || !body) return;
  body.innerHTML = state.detailTab === 'raw' ? buildRawTab(req) : buildResponseTab(req);
  if (scrollToFirst) state.ui.localMatchIndex = 0;
  requestAnimationFrame(() => focusLocalMatch(Boolean(scrollToFirst)));
}
