/*
 * panel-main.js —— 初始化、UI 事件绑定与详情操作
 */
'use strict';

function debounce(fn, wait) {
  let timer = null;
  return function debounced() {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), wait);
  };
}

function setupModeChrome() {
  const badge = $('#modeBadge');
  const tabBar = $('#tabBar');
  const sourceNote = $('#sourceNote');

  if (state.mode === 'devtools') {
    badge.textContent = 'DevTools 模式';
    tabBar.classList.add('hidden');
    sourceNote.textContent = '数据来源：chrome.devtools.network.onRequestFinished（HAR）';
  } else {
    badge.textContent = '注入模式';
    badge.classList.add('inject');
    tabBar.classList.remove('hidden');
    sourceNote.textContent = '数据来源：页面内 fetch / XHR 包装（DevTools 关闭时使用）';
  }
}

function populateFilterOptions() {
  const methodSelect = $('#methodFilter');
  if (methodSelect) {
    methodSelect.innerHTML = [
      ['', '全部方法'],
      ['GET', 'GET'],
      ['POST', 'POST'],
      ['PUT', 'PUT'],
      ['PATCH', 'PATCH'],
      ['DELETE', 'DELETE'],
      ['HEAD', 'HEAD'],
      ['OPTIONS', 'OPTIONS'],
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  }

  const statusSelect = $('#statusFilter');
  if (statusSelect) {
    statusSelect.innerHTML = [
      ['', '全部状态'],
      ['2', '2xx 成功'],
      ['3', '3xx 重定向'],
      ['4', '4xx 客户端错误'],
      ['5', '5xx 服务端错误'],
      ['0', '失败 / 无状态'],
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  }
}

function bindFilterEvents() {
  const searchInput = $('#searchInput');
  const clearBtn = $('#searchClear');

  const applyKeyword = debounce(() => {
    state.ui.keyword = searchInput.value;
    clearBtn.classList.toggle('show', Boolean(searchInput.value));
    scheduleRender();
  }, 120);

  searchInput.addEventListener('input', applyKeyword);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      state.ui.keyword = '';
      clearBtn.classList.remove('show');
      scheduleRender();
    }
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.ui.keyword = '';
    clearBtn.classList.remove('show');
    scheduleRender();
    searchInput.focus();
  });

  const bindCheckbox = (selector, key) => {
    const node = $(selector);
    node.addEventListener('change', () => {
      state.ui[key] = node.checked;
      scheduleRender();
    });
  };
  bindCheckbox('#secUrl', 'secUrl');
  bindCheckbox('#secHeaders', 'secHeaders');
  bindCheckbox('#secPayload', 'secPayload');
  bindCheckbox('#secResponse', 'secResponse');
  bindCheckbox('#customOnly', 'customOnly');

  const caseBtn = $('#caseBtn');
  caseBtn.addEventListener('click', () => {
    state.ui.caseInsensitive = !state.ui.caseInsensitive;
    caseBtn.classList.toggle('on', state.ui.caseInsensitive);
    syncLocalCaseButton();
    scheduleRender();
    // 局部搜索的大小写行为与全局共用同一开关，若正在使用需刷新响应内容
    if (localSearchKeyword()) updateResponseBody(false);
  });

  const highlightBtn = $('#highlightBtn');
  highlightBtn.addEventListener('click', () => {
    state.ui.highlightOnly = !state.ui.highlightOnly;
    highlightBtn.classList.toggle('on', state.ui.highlightOnly);
    scheduleRender();
  });

  $('#methodFilter').addEventListener('change', (event) => {
    state.ui.method = event.target.value;
    scheduleRender();
  });
  $('#statusFilter').addEventListener('change', (event) => {
    state.ui.status = event.target.value;
    scheduleRender();
  });
}

function bindToolbar() {
  $('#pauseBtn').addEventListener('click', () => {
    setPaused(!state.paused);
    toast(state.paused ? '已暂停捕获（已有数据保留）' : '已恢复捕获');
  });

  $('#clearBtn').addEventListener('click', () => {
    clearCurrent();
    toast('已清空当前列表');
  });

  const dialog = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', () => {
    fillSettingsForm();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });

  $('#settingsCancel').addEventListener('click', () => dialog.close());

  $('#settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettingsFromForm();
    dialog.close();
  });
}

function fillSettingsForm() {
  $('#setMaxEntries').value = state.settings.maxEntries;
  $('#setParseThreshold').value = state.settings.parseThresholdKB;
  $('#setMaxCapture').value = state.settings.maxCaptureMB;
  $('#setExtraWhitelist').value = state.settings.extraWhitelist.join(', ');
  $('#setBlacklist').value = state.settings.blacklist.join(', ');
}

function saveSettingsFromForm() {
  const maxEntries = Number($('#setMaxEntries').value);
  const parseThresholdKB = Number($('#setParseThreshold').value);
  const maxCaptureMB = Number($('#setMaxCapture').value);
  const extraWhitelist = normalizeHeaderList($('#setExtraWhitelist').value);
  const blacklist = normalizeHeaderList($('#setBlacklist').value);

  const payload = {
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_SETTINGS.maxEntries,
    parseThresholdKB: Number.isFinite(parseThresholdKB) && parseThresholdKB > 0 ? parseThresholdKB : DEFAULT_SETTINGS.parseThresholdKB,
    maxCaptureMB: Number.isFinite(maxCaptureMB) && maxCaptureMB > 0 ? maxCaptureMB : DEFAULT_SETTINGS.maxCaptureMB,
    extraWhitelist,
    blacklist,
  };

  applySettings(payload);
  chrome.storage.local.set(payload).catch(() => {});
  lastDetailKey = null;
  scheduleRender();
  toast('设置已保存（注入模式的捕获上限会在新请求中生效）');
}

function bindListEvents() {
  $('#requestList').addEventListener('click', (event) => {
    const row = event.target.closest('.request-row');
    if (!row) return;
    state.selectedId = row.dataset.id;
    state.selectedSnapshot = findRequest(row.dataset.id);
    state.detailTab = 'headers';
    setDetailVisible(true);
    renderAll(true);
  });
}

// ---------------------------------------------------------------- 详情开关 / 分栏拖拽

function setDetailVisible(visible) {
  const workspace = $('.workspace');
  if (!workspace) return;
  workspace.classList.toggle('no-detail', !visible);
}

function closeDetail() {
  state.selectedId = null;
  state.selectedSnapshot = null;
  state.ui.localMatchIndex = 0;
  setDetailVisible(false);
  renderAll(true);
}

// 局部搜索的 Aa 按钮与全局 #caseBtn 共享同一个 caseInsensitive 状态
function syncLocalCaseButton() {
  const btn = $('#localSearchBar [data-local-action="case"]');
  if (btn) btn.classList.toggle('on', state.ui.caseInsensitive);
}

const SPLIT_MIN_LIST = 320;
const SPLIT_MIN_DETAIL = 360;
const SPLITTER_WIDTH = 6;

function applySplitBasis(value) {
  const workspace = $('.workspace');
  if (!workspace) return;
  workspace.style.setProperty('--list-basis', value);
}

function restoreSplitRatio() {
  chrome.storage.local.get({ splitRatio: 0.52 }).then((raw) => {
    const ratio = Number(raw && raw.splitRatio);
    if (Number.isFinite(ratio) && ratio > 0.1 && ratio < 0.9) {
      state.splitRatio = ratio;
    }
    applySplitBasis(`${(state.splitRatio * 100).toFixed(2)}%`);
  }).catch(() => {
    applySplitBasis(`${(state.splitRatio * 100).toFixed(2)}%`);
  });
}

function initSplitter() {
  const workspace = $('.workspace');
  const splitter = $('#splitter');
  if (!workspace || !splitter) return;

  let dragging = false;
  let startX = 0;
  let startBasis = 0;
  let containerWidth = 0;

  splitter.addEventListener('pointerdown', (event) => {
    if (workspace.classList.contains('no-detail')) return;
    if (event.button != null && event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    containerWidth = workspace.getBoundingClientRect().width;
    startBasis = ($('.list-pane') && $('.list-pane').getBoundingClientRect().width) || 0;
    splitter.classList.add('dragging');
    document.body.classList.add('col-resizing');
    if (typeof splitter.setPointerCapture === 'function') {
      try {
        splitter.setPointerCapture(event.pointerId);
      } catch (err) {
        // ignore
      }
    }
    event.preventDefault();
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const maxList = Math.max(SPLIT_MIN_LIST, containerWidth - SPLIT_MIN_DETAIL - SPLITTER_WIDTH);
    const basis = Math.min(maxList, Math.max(SPLIT_MIN_LIST, startBasis + (event.clientX - startX)));
    applySplitBasis(`${Math.round(basis)}px`);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    const width = ($('.list-pane') && $('.list-pane').getBoundingClientRect().width) || 0;
    const total = workspace.getBoundingClientRect().width || 0;
    if (total > 0 && width > 0) {
      state.splitRatio = Math.min(0.9, Math.max(0.1, width / total));
      applySplitBasis(`${(state.splitRatio * 100).toFixed(2)}%`);
      chrome.storage.local.set({ splitRatio: state.splitRatio }).catch(() => {});
    }
  };

  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
  window.addEventListener('resize', () => {
    // 窗口尺寸变化后如果仍处于 px 模式会挤压详情，这里统一回到比例模式
    if (!dragging) applySplitBasis(`${(state.splitRatio * 100).toFixed(2)}%`);
  });

  restoreSplitRatio();
}

function bindTabSelect() {
  $('#tabSelect').addEventListener('change', (event) => {
    const tabId = Number(event.target.value);
    if (!Number.isFinite(tabId)) return;
    subscribeTab(tabId);
    const tab = state.tabs.find((item) => item.id === tabId);
    if (tab && tab.url) {
      state.inspectedUrl = tab.url;
    }
    updatePageUrl();
    toast(`已切换到标签页 #${tabId}`);
  });
}

function bindDetailEvents() {
  const pane = $('#detailPane');

  // 局部搜索：只更新响应内容区，不重建输入框（避免焦点/光标丢失）
  const applyLocalKeyword = debounce((value) => {
    state.ui.localKeyword = value;
    state.ui.localMatchIndex = 0;
    updateResponseBody(true);
  }, 120);

  pane.addEventListener('input', (event) => {
    if (!event.target.matches || !event.target.matches('#localSearchInput')) return;
    const clearBtn = $('#localSearchBar .clear-input');
    if (clearBtn) clearBtn.classList.toggle('show', Boolean(event.target.value));
    applyLocalKeyword(event.target.value);
  });

  pane.addEventListener('keydown', (event) => {
    if (!event.target.matches || !event.target.matches('#localSearchInput')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpLocalMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      clearLocalSearch();
    }
  });

  pane.addEventListener('click', (event) => {
    const req = selectedRequest();
    if (!req) return;

    const closeBtn = event.target.closest('[data-action="close-detail"]');
    if (closeBtn) {
      closeDetail();
      return;
    }

    const localBtn = event.target.closest('[data-local-action]');
    if (localBtn) {
      const localAction = localBtn.dataset.localAction;
      if (localAction === 'prev') jumpLocalMatch(-1);
      else if (localAction === 'next') jumpLocalMatch(1);
      else if (localAction === 'clear') clearLocalSearch();
      else if (localAction === 'case') toggleLocalCase();
      return;
    }

    const tabBtn = event.target.closest('.detail-tab');
    if (tabBtn) {
      state.detailTab = tabBtn.dataset.tab;
      renderDetail();
      markDetailKey();
      return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      copyRequestAs(req, copyBtn.dataset.copy);
      return;
    }

    const copyBodyBtn = event.target.closest('[data-copy-body]');
    if (copyBodyBtn) {
      copyRequestBody(req, copyBodyBtn.dataset.copyBody === 'json');
      return;
    }

    const nodeBtn = event.target.closest('button[data-node]');
    if (nodeBtn) {
      const info = req._jsonNodeMap && req._jsonNodeMap.get(Number(nodeBtn.dataset.node));
      if (!info) return;
      if (nodeBtn.dataset.act === 'copy-path') {
        copyText(info.path, `已复制路径 ${info.path}`);
      } else {
        let text;
        if (typeof info.value === 'string') text = info.value;
        else {
          try {
            text = JSON.stringify(info.value, null, 2);
          } catch (err) {
            text = String(info.value);
          }
        }
        copyText(text == null ? String(info.value) : text, '已复制节点值');
      }
      return;
    }

    const toggleBtn = event.target.closest('.jn-toggle');
    if (toggleBtn && toggleBtn.dataset.toggle === '1') {
      ensureJsonState(req);
      const path = toggleBtn.dataset.path;
      if (req._expanded.has(path)) req._expanded.delete(path);
      else req._expanded.add(path);
      renderDetail();
      return;
    }

    const moreBtn = event.target.closest('button[data-more]');
    if (moreBtn) {
      ensureJsonState(req);
      const path = moreBtn.dataset.more;
      req._offsets.set(path, (req._offsets.get(path) || 0) + 100);
      renderDetail();
      return;
    }

    const actionBtn = event.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'download-original') {
        downloadResponse(req, false);
      } else if (action === 'download-text') {
        downloadResponse(req, true);
      } else if (action === 'load-body') {
        loadBodyAndRefresh(req);
      } else if (action === 'json-view-tree') {
        req._jsonView = 'tree';
        renderDetail();
      } else if (action === 'json-view-raw') {
        req._jsonView = 'raw';
        renderDetail();
      }
    }
  });

  // 双击 URL 方便复制
  pane.addEventListener('dblclick', (event) => {
    const urlNode = event.target.closest('.detail-url');
    if (!urlNode) return;
    copyText(urlNode.textContent, '已复制 URL');
  });
}

async function loadBodyAndRefresh(req) {
  toast('正在读取响应体…');
  await ensureBody(req);
  if (selectedRequest() && selectedRequest().id === req.id) {
    renderDetail();
  }
  markDetailKey();
}

function markDetailKey() {
  const current = selectedRequest();
  lastDetailKey =
    String(state.selectedId) + '|' + state.detailTab + '|' + (current && current._outOfBuffer ? 'oob' : 'ok');
}

function clearLocalSearch() {
  state.ui.localKeyword = '';
  state.ui.localMatchIndex = 0;
  const input = $('#localSearchInput');
  if (input) input.value = '';
  const clearBtn = $('#localSearchBar .clear-input');
  if (clearBtn) clearBtn.classList.remove('show');
  updateResponseBody(true);
}

function toggleLocalCase() {
  state.ui.caseInsensitive = !state.ui.caseInsensitive;
  const caseBtn = $('#caseBtn');
  if (caseBtn) caseBtn.classList.toggle('on', state.ui.caseInsensitive);
  syncLocalCaseButton();
  state.ui.localMatchIndex = 0;
  updateResponseBody(true);
  // 大小写开关与全局搜索共用同一个状态，列表命中标记也要同步刷新
  scheduleRender();
}

// Esc 关闭详情（输入框、设置弹窗内不处理，避免与它们自身的 Esc 行为冲突）
function bindGlobalKeys() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const dialog = $('#settingsDialog');
    if (dialog && dialog.open) return;
    const target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (state.selectedId != null) {
      event.preventDefault();
      closeDetail();
    }
  });
}

function init() {
  setupModeChrome();
  populateFilterOptions();
  bindFilterEvents();
  bindToolbar();
  bindListEvents();
  bindTabSelect();
  bindDetailEvents();
  bindGlobalKeys();
  initSplitter();

  loadSettings().then(() => {
    if (state.mode === 'devtools') {
      initDevtoolsSource();
    } else {
      const params = new URLSearchParams(location.search);
      const tabId = params.get('tabId');
      initInjectSource(tabId === null ? undefined : tabId);
    }
    updatePageUrl();
    updatePauseButton();
    scheduleRender();
  });
}

init();
