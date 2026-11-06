/*
 * inject.js —— 注入到页面 MAIN world 的抓包脚本（补充模式）
 *
 * 为什么需要它：浏览器扩展无法读取 DevTools Network 面板的数据，所以
 * DevTools 关闭时，只能由页面上下文自行包装 fetch / XMLHttpRequest 来采集。
 *
 * 关键点：
 * 1. 必须在页面脚本之前执行（manifest content_scripts, run_at: document_start, world: MAIN）。
 * 2. 读取响应体必须用 response.clone()，绝不能消费页面自己的 response / xhr.response。
 * 3. 采集到数据后通过 window.postMessage 交给 ISOLATED world 的 bridge.js，
 *    bridge.js 再转发给 background service worker。
 * 4. 响应体读取有上限（默认 5MB），超出部分截断并标记 truncated，避免拖垮页面。
 */
(() => {
  'use strict';

  if (window.__NETWORK_INSPECTOR_INJECTED__) return;
  window.__NETWORK_INSPECTOR_INJECTED__ = true;

  const CHANNEL = '__NETWORK_INSPECTOR_CHANNEL__';
  const DEFAULT_MAX_CAPTURE_BYTES = 5 * 1024 * 1024; // 单条响应/请求体落库上限

  const config = {
    maxCaptureBytes: DEFAULT_MAX_CAPTURE_BYTES,
  };

  let seq = 0;
  const sessionTag = Math.random().toString(36).slice(2, 8);

  function nextId() {
    seq += 1;
    return `${sessionTag}-${Date.now().toString(36)}-${seq}`;
  }

  // 把数据发到同页面的 ISOLATED world（bridge.js 监听）
  function post(type, data) {
    try {
      window.postMessage({ ch: CHANNEL, type, data }, '*');
    } catch (err) {
      // 忽略序列化失败：不能影响页面本身
    }
  }

  // 接收 bridge.js 下发的配置（页面加载后动态调整上限）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.ch !== CHANNEL || data.type !== 'config') return;
    const n = Number(data.maxCaptureBytes);
    if (Number.isFinite(n) && n > 0) config.maxCaptureBytes = n;
  });

  // ---------------------------------------------------------------- 工具函数

  function resolveUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (err) {
      return String(url);
    }
  }

  function shouldSkip(url) {
    if (!url) return true;
    return (
      url.startsWith('chrome-extension://') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('about:')
    );
  }

  function getHeader(headers, name) {
    if (!headers) return '';
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return '';
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        headers.forEach((value, key) => {
          out[key] = value;
        });
        return out;
      }
      if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (Array.isArray(pair)) out[pair[0]] = pair[1];
        }
        return out;
      }
      for (const key of Object.keys(headers)) out[key] = String(headers[key]);
    } catch (err) {
      // 某些 Headers 实现不可枚举，忽略
    }
    return out;
  }

  function isTextualMime(mime) {
    if (!mime) return false;
    const m = mime.toLowerCase();
    return (
      m.startsWith('text/') ||
      /(json|javascript|ecmascript|xml|x-www-form-urlencoded|csv|graphql|event-stream|html|css|yaml|protobuf)/.test(m)
    );
  }

  function charsetOf(mime) {
    const match = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mime || '');
    return match ? match[1] : '';
  }

  function decodeText(bytes, mime) {
    const charset = charsetOf(mime);
    try {
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch (err) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  // 分块 btoa，避免大数组直接 apply 导致栈溢出
  function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const sub = bytes.subarray(i, i + CHUNK);
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }

  function textByteLength(text) {
    try {
      return new TextEncoder().encode(text).length;
    } catch (err) {
      return text.length;
    }
  }

  // 把已读取的字节统一转成面板需要的 body 结构
  function buildBody(bytes, mime, truncated, totalSize) {
    const length = totalSize && totalSize > 0 ? totalSize : bytes.length;
    if (isTextualMime(mime)) {
      return {
        kind: 'text',
        text: decodeText(bytes, mime),
        size: length,
        capturedBytes: bytes.length,
        truncated: Boolean(truncated),
        mimeType: mime || '',
      };
    }
    return {
      kind: 'base64',
      data: bytesToBase64(bytes),
      size: length,
      capturedBytes: bytes.length,
      truncated: Boolean(truncated),
      mimeType: mime || '',
    };
  }

  function makeTextBody(text, mime) {
    const limit = config.maxCaptureBytes;
    let truncated = false;
    let value = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (value.length > limit) {
      value = value.slice(0, limit);
      truncated = true;
    }
    return {
      kind: 'text',
      text: value,
      size: textByteLength(value),
      capturedBytes: textByteLength(value),
      truncated,
      mimeType: mime || '',
    };
  }

  // 读取 fetch 的 clone 流：最多读 maxCaptureBytes；流式响应（如 SSE）最多等 8 秒，
  // 避免永不结束的流让整条请求一直无法上报。
  async function readStreamLimited(stream) {
    const reader = stream.getReader();
    const limit = config.maxCaptureBytes;
    const chunks = [];
    let received = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      try {
        reader.cancel().catch(() => {});
      } catch (err) {
        // ignore
      }
    }, 8000);

    try {
      while (true) {
        let result;
        try {
          result = await reader.read();
        } catch (err) {
          break; // 流本身中断，保留已读部分
        }
        if (result.done) break;

        const chunk = result.value;
        const room = limit - received;
        if (chunk.byteLength > room) {
          if (room > 0) {
            chunks.push(chunk.subarray(0, room));
            received += room;
          }
          truncated = true;
          try {
            await reader.cancel();
          } catch (err) {
            // ignore
          }
          break;
        }
        chunks.push(chunk);
        received += chunk.byteLength;
        if (received >= limit) {
          truncated = true;
          try {
            await reader.cancel();
          } catch (err) {
            // ignore
          }
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncated, timedOut };
  }

  function blobToBytes(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Blob 读取失败'));
      reader.readAsArrayBuffer(blob);
    });
  }

  // 请求体描述：字符串 / URLSearchParams / FormData / Blob / ArrayBuffer / 流
  function describeRequestBody(body, requestHeaders) {
    if (body === undefined || body === null) return null;

    const contentType =
      getHeader(requestHeaders, 'content-type') ||
      (typeof body === 'object' && body && body.type) ||
      '';

    if (typeof body === 'string') {
      return {
        kind: 'text',
        text: body,
        size: textByteLength(body),
        mimeType: contentType,
        truncated: false,
      };
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const text = body.toString();
      return {
        kind: 'text',
        text,
        size: textByteLength(text),
        mimeType: contentType || 'application/x-www-form-urlencoded',
        truncated: false,
      };
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const fields = [];
      const lines = [];
      try {
        for (const [name, value] of body.entries()) {
          if (typeof File !== 'undefined' && value instanceof File) {
            fields.push({
              name,
              fileName: value.name,
              fileSize: value.size,
              fileType: value.type,
              isFile: true,
            });
            lines.push(`${name} = [File] ${value.name} (${value.size} bytes, ${value.type || 'unknown'})`);
          } else {
            fields.push({ name, value: String(value), isFile: false });
            lines.push(`${name} = ${String(value)}`);
          }
        }
      } catch (err) {
        lines.push('[FormData 读取失败: ' + (err && err.message) + ']');
      }
      return {
        kind: 'form',
        formFields: fields,
        text: lines.join('\n'),
        mimeType: contentType || 'multipart/form-data',
        size: 0,
        truncated: false,
        note: 'FormData 已还原为字段；文件内容未捕获，cURL 中会生成 @ 路径占位。',
      };
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return {
        kind: 'binary',
        text: '',
        size: body.size,
        mimeType: body.type || contentType,
        truncated: false,
        note: 'Blob 请求体：仅记录大小与类型，未读取内容。',
      };
    }

    if (
      (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) ||
      (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body))
    ) {
      const size = body.byteLength !== undefined ? body.byteLength : body.size || 0;
      return {
        kind: 'binary',
        text: '',
        size,
        mimeType: contentType,
        truncated: false,
        note: 'ArrayBuffer / TypedArray 请求体：仅记录大小，下载请使用原始请求重放。',
      };
    }

    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return {
        kind: 'binary',
        text: '',
        size: 0,
        mimeType: contentType,
        truncated: false,
        note: 'ReadableStream 请求体无法安全读取（读取会消费页面数据）。',
      };
    }

    if (typeof Document !== 'undefined' && body instanceof Document) {
      try {
        const text = new XMLSerializer().serializeToString(body);
        return {
          kind: 'text',
          text,
          size: textByteLength(text),
          mimeType: contentType || 'text/html',
          truncated: false,
        };
      } catch (err) {
        // fallthrough
      }
    }

    let text = '';
    try {
      text = String(body);
    } catch (err) {
      text = '[unserializable body]';
    }
    return {
      kind: 'text',
      text,
      size: textByteLength(text),
      mimeType: contentType,
      truncated: false,
    };
  }

  // ---------------------------------------------------------------- fetch 劫持

  const originalFetch = window.fetch;

  async function describeFetchRequest(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = String((init && init.method) || (isRequest ? input.method : 'GET') || 'GET').toUpperCase();
    const rawUrl = isRequest ? input.url : String(input);
    const url = resolveUrl(rawUrl);
    const headers = {};

    if (isRequest) {
      try {
        input.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } catch (err) {
        // ignore
      }
    }

    if (init && init.headers) {
      try {
        if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } else if (Array.isArray(init.headers)) {
          for (const pair of init.headers) {
            if (pair && pair.length === 2) headers[pair[0]] = pair[1];
          }
        } else {
          for (const key of Object.keys(init.headers)) {
            headers[key] = String(init.headers[key]);
          }
        }
      } catch (err) {
        // ignore
      }
    }

    let body = null;
    if (init && init.body !== undefined && init.body !== null) {
      body = describeRequestBody(init.body, headers);
    } else if (isRequest && method !== 'GET' && method !== 'HEAD' && input.body) {
      // 读取 Request 的副本，不能读取原始 input（会破坏页面请求体）
      try {
        const cloned = input.clone();
        if (cloned.body) {
          const result = await readStreamLimited(cloned.body);
          const contentType = getHeader(headers, 'content-type');
          const built = buildBody(result.bytes, contentType, result.truncated, null);
          // 请求体即使文本，也只在 FormData/JSON 等场景展示；这里统一保留
          body = built;
        }
      } catch (err) {
        body = {
          kind: 'binary',
          text: '',
          size: 0,
          mimeType: getHeader(headers, 'content-type'),
          truncated: false,
          note: 'Request 请求体已被页面使用，无法复制读取。',
        };
      }
    }

    return { id: nextId(), method, url, headers, body };
  }

  async function captureFetch(info, responsePromise, cloneHolder, startTs, startPerf) {
    let response;
    try {
      response = await responsePromise;
    } catch (err) {
      post('req', {
        id: info.id,
        type: 'fetch',
        url: info.url,
        method: info.method,
        reqHeaders: info.headers,
        reqBody: info.body,
        status: 0,
        statusText: '',
        respHeaders: {},
        respBody: { kind: 'none', text: '', size: 0, mimeType: '', truncated: false },
        contentType: '',
        startTime: startTs,
        duration: Math.round((performance.now() - startPerf) * 10) / 10,
        error: String((err && err.message) || err || '请求失败'),
      });
      return;
    }

    const mime = response.headers.get('content-type') || '';
    let body = {
      kind: 'none',
      text: '',
      size: 0,
      mimeType: mime,
      truncated: false,
      note: '响应没有可读取的 body（可能是不透明响应或 body 已被页面消费）。',
    };

    const clone = cloneHolder.value;
    if (clone && clone.body) {
      try {
        const result = await readStreamLimited(clone.body);
        const contentLength = Number(response.headers.get('content-length'));
        const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
        body = buildBody(result.bytes, mime, result.truncated, total);
        if (result.timedOut) {
          body.note = '流式响应读取超过 8 秒，已停止并保留已接收部分。';
        }
      } catch (err) {
        body = {
          kind: 'none',
          text: '',
          size: 0,
          mimeType: mime,
          truncated: false,
          note: '读取 clone 响应体失败：' + (err && err.message ? err.message : err),
        };
      }
    } else if (clone) {
      // 没有流（例如 204/304），用 text() 兜底
      try {
        const text = await clone.text();
        body = makeTextBody(text, mime);
      } catch (err) {
        // ignore
      }
    }

    post('req', {
      id: info.id,
      type: 'fetch',
      url: response.url || info.url,
      method: info.method,
      reqHeaders: info.headers,
      reqBody: info.body,
      status: response.status,
      statusText: response.statusText,
      respHeaders: headersToObject(response.headers),
      respBody: body,
      contentType: mime,
      startTime: startTs,
      duration: Math.round((performance.now() - startPerf) * 10) / 10,
      redirected: response.redirected,
      error: null,
    });
  }

  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const startTs = Date.now();
      const startPerf = performance.now();
      const infoPromise = describeFetchRequest(input, init).catch(() => ({
        id: nextId(),
        method: String((init && init.method) || 'GET').toUpperCase(),
        url: resolveUrl(input instanceof Request ? input.url : String(input)),
        headers: {},
        body: null,
      }));
      const responsePromise = originalFetch.apply(this, arguments);

      // 关键：在返回 Promise 前先注册 clone，保证 clone 发生在页面任何 then 之前，
      // 这样页面即使立刻 response.json() 也不会让我们拿不到 body。
      const cloneHolder = { value: null };
      // 该 handler 在 fetch 返回前注册，因此一定早于页面自己的 then 执行
      responsePromise.then(
        (response) => {
          try {
            cloneHolder.value = response.clone();
          } catch (err) {
            cloneHolder.value = null;
          }
        },
        () => {
          cloneHolder.value = null;
        }
      );

      (async () => {
        const info = await infoPromise;
        if (shouldSkip(info.url)) return;
        try {
          await captureFetch(info, responsePromise, cloneHolder, startTs, startPerf);
        } catch (err) {
          // 采集失败不能影响页面请求
        }
      })();

      return responsePromise;
    };
  }

  // ---------------------------------------------------------------- XHR 劫持

  const XHR_PROTO = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  const originalOpen = XHR_PROTO && XHR_PROTO.open;
  const originalSend = XHR_PROTO && XHR_PROTO.send;
  const originalSetRequestHeader = XHR_PROTO && XHR_PROTO.setRequestHeader;
  const xhrMeta = new WeakMap();

  function parseRawHeaders(raw) {
    const out = {};
    if (!raw) return out;
    for (const line of String(raw).trim().split(/[\r\n]+/)) {
      const index = line.indexOf(':');
      if (index > 0) {
        const name = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (name) out[name] = value;
      }
    }
    return out;
  }

  async function captureXhr(xhr, info, startTs, startPerf) {
    const headers = parseRawHeaders(xhr.getAllResponseHeaders());
    const mime = getHeader(headers, 'content-type');
    let body = {
      kind: 'none',
      text: '',
      size: 0,
      mimeType: mime,
      truncated: false,
      note: '',
    };

    try {
      const responseType = xhr.responseType;
      if (responseType === '' || responseType === 'text') {
        body = makeTextBody(xhr.responseText || '', mime);
      } else if (responseType === 'json') {
        const json = xhr.response;
        body = makeTextBody(json == null ? '' : JSON.stringify(json), mime || 'application/json');
      } else if (responseType === 'arraybuffer') {
        const buffer = xhr.response;
        if (buffer) {
          const bytes = new Uint8Array(buffer);
          const truncated = bytes.length > config.maxCaptureBytes;
          const sliced = truncated ? bytes.subarray(0, config.maxCaptureBytes) : bytes;
          body = buildBody(sliced, mime, truncated, bytes.length);
        }
      } else if (responseType === 'blob') {
        const blob = xhr.response;
        if (blob) {
          const truncated = blob.size > config.maxCaptureBytes;
          const sliced = truncated ? blob.slice(0, config.maxCaptureBytes) : blob;
          const bytes = await blobToBytes(sliced);
          body = buildBody(bytes, mime || blob.type, truncated, blob.size);
        }
      } else if (responseType === 'document') {
        const doc = xhr.responseXML;
        if (doc) {
          body = makeTextBody(new XMLSerializer().serializeToString(doc), mime || 'text/html');
        } else if (typeof xhr.response === 'string') {
          body = makeTextBody(xhr.response, mime || 'text/html');
        }
      }
    } catch (err) {
      body = {
        kind: 'none',
        text: '',
        size: 0,
        mimeType: mime,
        truncated: false,
        note: 'XHR 响应体读取失败：' + (err && err.message ? err.message : err),
      };
    }

    const contentLength = Number(getHeader(headers, 'content-length'));
    if ((!body.size || body.size <= 0) && Number.isFinite(contentLength) && contentLength > 0) {
      body.size = contentLength;
    }

    post('req', {
      id: info.id,
      type: 'xhr',
      url: xhr.responseURL || info.url,
      method: info.method,
      reqHeaders: info.headers || {},
      reqBody: info.body || null,
      status: xhr.status,
      statusText: xhr.statusText || '',
      respHeaders: headers,
      respBody: body,
      contentType: mime,
      startTime: startTs,
      duration: Math.round((performance.now() - startPerf) * 10) / 10,
      error: xhr.status === 0 ? '请求失败或被取消（status 0）' : null,
    });
  }

  if (XHR_PROTO) {
    XHR_PROTO.open = function patchedOpen(method, url) {
      const existing = xhrMeta.get(this);
      const info = existing || {};
      info.id = nextId();
      info.method = String(method || 'GET').toUpperCase();
      info.url = resolveUrl(String(url));
      info.headers = {};
      info.body = null;
      xhrMeta.set(this, info);
      return originalOpen.apply(this, arguments);
    };

    XHR_PROTO.setRequestHeader = function patchedSetRequestHeader(name, value) {
      const info = xhrMeta.get(this);
      if (info && info.headers) info.headers[name] = String(value);
      return originalSetRequestHeader.apply(this, arguments);
    };

    XHR_PROTO.send = function patchedSend(body) {
      let info = xhrMeta.get(this);
      if (!info) {
        info = { id: nextId(), method: 'GET', url: '', headers: {}, body: null };
        xhrMeta.set(this, info);
      }
      try {
        info.body = describeRequestBody(body, info.headers);
      } catch (err) {
        info.body = null;
      }

      const startTs = Date.now();
      const startPerf = performance.now();
      const onLoadEnd = () => {
        try {
          this.removeEventListener('loadend', onLoadEnd);
        } catch (err) {
          // ignore
        }
        captureXhr(this, info, startTs, startPerf).catch(() => {});
      };
      this.addEventListener('loadend', onLoadEnd);

      try {
        return originalSend.apply(this, arguments);
      } catch (err) {
        try {
          this.removeEventListener('loadend', onLoadEnd);
        } catch (e) {
          // ignore
        }
        throw err;
      }
    };
  }
})();
