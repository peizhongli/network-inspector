/*
 * bridge.js —— ISOLATED world 的桥接层
 *
 * MAIN world 的 inject.js 没有 chrome.* API，只能通过 window.postMessage 发数据；
 * 本文件负责：
 *   1. 把页面抓到的请求转发给 background service worker；
 *   2. 页面加载时通知 background 清空该 tab 的旧数据（仅主框架，background 会校验 frameId）；
 *   3. 把用户设置（单条最大捕获字节数）下发给 MAIN world。
 */
(() => {
  'use strict';

  const CHANNEL = '__NETWORK_INSPECTOR_CHANNEL__';
  const DEFAULT_MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

  function safeSend(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // 扩展被重载后可能没有接收者，读取 lastError 防止控制台报错
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // ignore
    }
  }

  function sendConfig(maxCaptureBytes) {
    try {
      window.postMessage(
        { ch: CHANNEL, type: 'config', maxCaptureBytes },
        '*'
      );
    } catch (err) {
      // ignore
    }
  }

  // 文档开始：让 background 重置该 tab 的环形缓冲（DevTools 数据不受影响）
  safeSend({ type: 'ni:reset' });

  // 读取配置并下发给 MAIN world
  try {
    chrome.storage.local.get({ maxCaptureBytes: DEFAULT_MAX_CAPTURE_BYTES }, (cfg) => {
      void chrome.runtime.lastError;
      sendConfig(cfg.maxCaptureBytes || DEFAULT_MAX_CAPTURE_BYTES);
    });
  } catch (err) {
    sendConfig(DEFAULT_MAX_CAPTURE_BYTES);
  }

  // 面板修改设置后，后台广播给各 tab
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'ni:config') return;
    sendConfig(message.maxCaptureBytes || DEFAULT_MAX_CAPTURE_BYTES);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.ch !== CHANNEL || data.type !== 'req') return;

    safeSend({ type: 'ni:request', payload: data.data });
  });
})();
