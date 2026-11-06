// DevTools 入口：注册扩展自己的 Network Filter 面板。
// 面板打开后由 panel.js 直接消费 chrome.devtools.network 的 HAR 数据。
chrome.devtools.panels.create('Network Filter', '', 'panel.html', () => {
  // 面板创建完成，无需额外动作；panel 自己注册监听。
});
