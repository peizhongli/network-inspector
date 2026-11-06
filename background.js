/*
 * background.js —— 注入模式的“服务端”
 *
 * 职责：
 *   1. 接收 bridge.js 发来的请求数据，按 tabId 维护环形缓冲（默认 500 条，可在面板设置里修改）。
 *   2. 通过长连接（chrome.runtime.connect）把数据推送给插件自己的 panel.html。
 *   3. 处理清空、暂停、页面导航重置、tab 关闭回收。
 *
 * 说明：缓冲保存在 service worker 内存中，并镜像到 chrome.storage.session（浏览器运行期有效）。
 * MV3 的 service worker 在长时间空闲后会被回收，内存数据随之丢失；写入 session 后，
 * service worker 重建时可以把最近的记录恢复出来，避免面板突然变空。
 */
'use strict';

const MAX_ENTRIES_DEFAULT = 500;
const SESSION_KEY = 'ni_buffers_v1';
const SESSION_LIMIT = 8 * 1024 * 1024; // 序列化上限，超过时逐步丢弃旧数据

/** @type {Map<number, {list: any[], paused: boolean}>} */
const buffers = new Map();
/** @type {Set<{port: chrome.runtime.Port, tabId: number|null}>} */
const panelPorts = new Set();

let maxEntries = MAX_ENTRIES_DEFAULT;

// service worker 重启后先从 session 存储恢复历史，再接受 subscribe
const ready = (async () => {
  try {
    const saved = await chrome.storage.session.get(SESSION_KEY);
    const data = saved && saved[SESSION_KEY];
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        const tabId = Number(key);
        if (!Number.isFinite(tabId) || !value) continue;
        buffers.set(tabId, {
          paused: !!value.paused,
          list: Array.isArray(value.list) ? value.list : [],
        });
      }
    }
  } catch (err) {
    // session 存储不可用时忽略，退化为纯内存
  }
  try {
    const cfg = await chrome.storage.local.get({ maxEntries: MAX_ENTRIES_DEFAULT });
    const value = Number(cfg.maxEntries);
    if (Number.isFinite(value) && value > 0) maxEntries = value;
  } catch (err) {
    // ignore
  }
  trimAll();
})();

// 写 session 存储做防抖，避免高频请求时反复序列化
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistBuffers();
  }, 600);
}

async function persistBuffers() {
  try {
    let text = '';
    // 逐步缩减保留条数，确保不超过 session 存储的大小限制
    for (const keep of [maxEntries, 100, 30, 5, 0]) {
      const snapshot = {};
      for (const [tabId, buffer] of buffers) {
        snapshot[tabId] = {
          paused: buffer.paused,
          list: keep > 0 ? buffer.list.slice(-keep) : [],
        };
      }
      text = JSON.stringify(snapshot);
      if (text.length <= SESSION_LIMIT) break;
    }
    await chrome.storage.session.set({ [SESSION_KEY]: JSON.parse(text || '{}') });
  } catch (err) {
    // 配额不足等情况直接跳过，内存中的数据仍然可用
  }
}

function getBuffer(tabId) {
  if (!Number.isFinite(tabId)) return null;
  let buffer = buffers.get(tabId);
  if (!buffer) {
    buffer = { list: [], paused: false };
    buffers.set(tabId, buffer);
  }
  return buffer;
}

function trimAll() {
  for (const buffer of buffers.values()) {
    while (buffer.list.length > maxEntries) buffer.list.shift();
  }
}

function broadcast(tabId, message) {
  for (const item of panelPorts) {
    if (item.tabId !== tabId) continue;
    try {
      item.port.postMessage(message);
    } catch (err) {
      // 端口可能已断开，忽略
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'ni:request') {
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isFinite(tabId)) return;
    const buffer = getBuffer(tabId);
    if (!buffer || buffer.paused) return;
    const payload = message.payload;
    if (!payload) return;

    // 附加采集来源信息（DevTools 模式不使用这里的数据）
    payload.tabId = tabId;
    payload.frameId = sender.frameId;
    payload.frameIsMain = sender.frameId === 0;

    buffer.list.push(payload);
    if (buffer.list.length > maxEntries) buffer.list.shift();
    schedulePersist();
    broadcast(tabId, { type: 'request', tabId, request: payload });
    return;
  }

  if (message.type === 'ni:reset') {
    // 只有主框架导航才清空，避免 iframe 刷新把整页数据清掉
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isFinite(tabId) || sender.frameId !== 0) return;
    const buffer = getBuffer(tabId);
    buffer.list.length = 0;
    schedulePersist();
    broadcast(tabId, { type: 'clear', tabId, reason: 'navigate' });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ni-panel') return;

  const item = { port, tabId: null };
  panelPorts.add(item);

  port.onMessage.addListener(async (message) => {
    if (!message || typeof message.type !== 'string') return;
    await ready;

    if (message.type === 'subscribe') {
      const tabId = Number(message.tabId);
      item.tabId = tabId;
      const buffer = getBuffer(tabId);
      if (!buffer) return;
      port.postMessage({
        type: 'snapshot',
        tabId,
        paused: buffer.paused,
        maxEntries,
        requests: buffer.list.slice(),
      });
      return;
    }

    if (message.type === 'pause' || message.type === 'resume') {
      const buffer = getBuffer(item.tabId);
      if (!buffer) return;
      buffer.paused = message.type === 'pause';
      schedulePersist();
      broadcast(item.tabId, { type: 'paused', tabId: item.tabId, paused: buffer.paused });
      return;
    }

    if (message.type === 'clear') {
      const buffer = getBuffer(item.tabId);
      if (!buffer) return;
      buffer.list.length = 0;
      schedulePersist();
      broadcast(item.tabId, { type: 'clear', tabId: item.tabId, reason: 'manual' });
    }
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(item);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  buffers.delete(tabId);
  schedulePersist();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.maxEntries) {
    const value = Number(changes.maxEntries.newValue);
    if (Number.isFinite(value) && value > 0) {
      maxEntries = value;
      trimAll();
    }
  }

  // 把新的捕获上限广播给所有 tab 的 bridge.js，再下发到 MAIN world
  if (changes.maxCaptureBytes) {
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs
          .sendMessage(tab.id, {
            type: 'ni:config',
            maxCaptureBytes: changes.maxCaptureBytes.newValue,
          })
          .catch(() => {});
      }
    });
  }
});

// 点击工具栏图标：打开独立面板窗口（注入模式）
chrome.action.onClicked.addListener(async (tab) => {
  const panelBase = chrome.runtime.getURL('panel.html');
  const url = panelBase + (tab && tab.id != null ? `?tabId=${tab.id}` : '');

  try {
    const windows = await chrome.windows.getAll({ populate: true });
    for (const win of windows) {
      const existing = (win.tabs || []).find(
        (t) => t.url && t.url.startsWith(panelBase)
      );
      if (existing) {
        await chrome.windows.update(win.id, { focused: true });
        await chrome.tabs.update(existing.id, { url });
        return;
      }
    }
    await chrome.windows.create({
      url,
      type: 'normal',
      width: 1440,
      height: 900,
      focused: true,
    });
  } catch (err) {
    // ignore
  }
});
