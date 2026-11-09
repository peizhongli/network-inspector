/*
 * panel-copy.js —— 复制（cURL / fetch / 原始文本）与响应下载
 */
'use strict';

function shQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

function bodyMime(req) {
  if (req.reqBody && req.reqBody.mimeType) return req.reqBody.mimeType;
  return getHeader(req.reqHeaders, 'content-type');
}

function isJsonMime(mime) {
  const m = String(mime || '').toLowerCase();
  return m.includes('json');
}

function normalizedHeadersForCopy(req, options) {
  const opts = options || {};
  const out = [];
  for (const [name, value] of Object.entries(req.reqHeaders || {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':')) continue;
    if (lower === 'content-length') continue;
    if (opts.skipContentType && lower === 'content-type') continue;
    out.push([name, String(value)]);
  }
  return out;
}

/**
 * 生成可直接粘贴到 bash/zsh 执行的 cURL：
 * 使用单引号转义（内部单引号替换为 '\''），长命令用反斜杠换行。
 */
function buildCurl(req) {
  const body = req.reqBody;
  const mime = bodyMime(req);
  const essence = mimeEssence(mime);
  const usesFormData = Boolean(body && body.kind === 'form' && Array.isArray(body.formFields) && body.formFields.length);

  const parts = [`curl ${shQuote(req.url)}`];
  if (req.method && req.method !== 'GET') parts.push(`-X ${req.method}`);

  for (const [name, value] of normalizedHeadersForCopy(req, { skipContentType: usesFormData })) {
    parts.push(`-H ${shQuote(`${name}: ${value}`)}`);
  }

  if (body) {
    if (usesFormData) {
      for (const field of body.formFields) {
        if (field.isFile || field.fileName) {
          parts.push(`-F ${shQuote(`${field.name}=@/path/to/file`)}`);
        } else {
          parts.push(`-F ${shQuote(`${field.name}=${field.value == null ? '' : field.value}`)}`);
        }
      }
    } else if (body.kind === 'binary' || (!body.text && body.size)) {
      parts.push(`--data-binary ${shQuote('@/path/to/file')}`);
    } else if (typeof body.text === 'string' && body.text.length) {
      if (essence === 'multipart/form-data') {
        // HAR / 注入都拿不到原始 multipart 边界，无法原样还原
        parts.push(`--data-binary ${shQuote('@/path/to/file')}`);
      } else {
        parts.push(`--data-raw ${shQuote(body.text)}`);
      }
    }
  }

  return parts.map((part, index) => (index === 0 ? part : '  ' + part)).join(' \\\n');
}

function buildFetchSnippet(req) {
  const headers = {};
  for (const [name, value] of normalizedHeadersForCopy(req, {})) headers[name] = value;

  const options = { method: req.method };
  if (Object.keys(headers).length) options.headers = headers;

  const body = req.reqBody;
  let comment = '';
  if (body) {
    if (body.kind === 'text' && body.text) {
      options.body = body.text;
    } else if (body.kind === 'form' && Array.isArray(body.formFields)) {
      // 生成 FormData 代码，文件字段保留占位说明
      const lines = ['const form = new FormData();'];
      for (const field of body.formFields) {
        if (field.isFile || field.fileName) {
          lines.push(`form.append(${JSON.stringify(field.name)}, /* File: ${field.fileName || 'file'} */ new File([], ${JSON.stringify(field.fileName || 'file')}));`);
        } else {
          lines.push(`form.append(${JSON.stringify(field.name)}, ${JSON.stringify(String(field.value == null ? '' : field.value))});`);
        }
      }
      lines.push(`fetch(${JSON.stringify(req.url)}, {`);
      lines.push(`  method: ${JSON.stringify(req.method)},`);
      if (Object.keys(headers).length) {
        lines.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`);
      }
      lines.push('  body: form');
      lines.push('});');
      return lines.join('\n');
    } else if (body.kind === 'binary') {
      comment = '// 提示：二进制请求体未捕获内容，请手动补充 body（如 FormData / ArrayBuffer / Blob）';
    }
  }

  let code = `fetch(${JSON.stringify(req.url)}, ${JSON.stringify(options, null, 2)});`;
  if (comment) code = comment + '\n' + code;
  return code;
}

function buildRawRequestText(req) {
  const lines = [`${req.method} ${req.url}`];
  for (const [name, value] of Object.entries(req.reqHeaders || {})) {
    if (name.toLowerCase().startsWith(':')) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push('');
  const body = req.reqBody;
  if (body && body.kind === 'text' && body.text) {
    lines.push(body.text);
  } else if (body && body.kind === 'form' && body.formFields) {
    lines.push(body.text || '');
  } else if (body && body.kind === 'binary') {
    lines.push(`[二进制请求体：${formatBytes(body.size)}，内容未捕获]`);
  }
  return lines.join('\n');
}

function copyRequestAs(req, format) {
  let text = '';
  if (format === 'curl') text = buildCurl(req);
  else if (format === 'fetch') text = buildFetchSnippet(req);
  else text = buildRawRequestText(req);

  const sensitive = requestHasSensitiveHeaders(req);
  const needsPath = Boolean(
    req.reqBody && (req.reqBody.kind === 'binary' || (req.reqBody.kind === 'form' && (req.reqBody.formFields || []).some((f) => f.isFile || f.fileName))
      || (req.reqBody.kind === 'text' && mimeEssence(bodyMime(req)) === 'multipart/form-data'))
  );

  let message = format === 'curl' ? '已复制可直接执行的 cURL' : format === 'fetch' ? '已复制 fetch 代码' : '已复制 URL + Headers';
  if (sensitive) message += '（含 Authorization/Cookie 敏感信息）';
  if (needsPath) message += '；请把 @/path/to/file 替换为真实文件路径';
  copyText(text, message);
}

function copyRequestBody(req, formatted) {
  const body = req.reqBody;
  if (!body) {
    toast('该请求没有请求体', 'warn');
    return;
  }
  if (body.kind === 'binary') {
    toast('二进制请求体未保存内容，无法复制；cURL 中已提供文件占位', 'warn');
    return;
  }
  if (body.kind === 'form') {
    const lines = (body.formFields || []).map((field) =>
      field.isFile || field.fileName
        ? `${field.name}: [File] ${field.fileName || ''} (${formatBytes(field.fileSize || 0)})`
        : `${field.name}: ${field.value == null ? '' : field.value}`
    );
    copyText(lines.join('\n'), '已复制 FormData 可读结构（文件内容未包含）');
    return;
  }

  let text = body.text || '';
  if (formatted) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch (err) {
      toast('请求体不是合法 JSON，已复制原始内容', 'warn');
    }
  }
  copyText(text, formatted ? '已复制格式化 JSON' : '已复制原始请求体');
}

/**
 * 判断请求体是否为 JSON：
 * 以 Content-Type（application/json、+json）为主；
 * 类型缺失或不可信时，回退到“内容能 JSON.parse 成功”即按 JSON 展示。
 */
function requestBodyJsonInfo(req) {
  const body = req.reqBody;
  if (!body || body.kind !== 'text' || !body.text) return { isJson: false };
  const mime = bodyMime(req);
  const mimeJson = isJsonMime(mime);
  const parsed = jsonParse(body.text);
  if (parsed.ok) {
    return { isJson: true, value: parsed.value, mime, mimeJson };
  }
  return { isJson: false, mime, mimeJson };
}

/** 下载原始请求体（body.text 为捕获到的原始内容，不做任何格式化） */
function downloadRequestBody(req) {
  const body = req.reqBody;
  if (!body || typeof body.text !== 'string' || !body.text) {
    toast('请求体内容未捕获，无法下载', 'warn');
    return;
  }
  saveBlob(
    new Blob([body.text], { type: bodyMime(req) || 'text/plain;charset=utf-8' }),
    suggestedFilename(req, '.body.txt'),
    '已开始下载原始请求体'
  );
}

// ---------------------------------------------------------------- 下载

function extensionForMime(mime, fallback) {
  const m = mimeEssence(mime);
  const map = {
    'application/json': '.json',
    'application/xml': '.xml',
    'text/html': '.html',
    'text/css': '.css',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/event-stream': '.txt',
    'application/javascript': '.js',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/octet-stream': '.bin',
    'application/x-protobuf': '.proto',
    'application/protobuf': '.proto',
    'application/wasm': '.wasm',
  };
  if (map[m]) return map[m];
  if (m.includes('json')) return '.json';
  if (m.startsWith('image/')) return '.img';
  return fallback || '.bin';
}

function suggestedFilename(req, suffix) {
  let name = 'response';
  try {
    const url = new URL(req.url);
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (last) name = decodeURIComponent(last);
  } catch (err) {
    // ignore
  }
  name = name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'response';
  const ext = extensionForMime(contentTypeOf(req), '.bin');
  if (suffix) return name.replace(/\.\w+$/, '') + suffix;
  if (name.includes('.')) return name;
  return name + ext;
}

function saveBlob(blob, filename, message) {
  const url = URL.createObjectURL(blob);
  if (chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        toast('下载失败：' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : '未知错误'), 'warn');
      } else {
        toast(message || '已开始下载');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  } else {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(message || '已开始下载');
  }
}

async function downloadResponse(req, asText) {
  let body = req.respBody;
  if (!body || (req._bodyState !== 'ready' && req._bodyState !== 'empty')) {
    toast('正在读取响应体…');
    body = await ensureBody(req);
  }
  if (!body || body.kind === 'none') {
    toast('响应体不可用：' + (body && body.note ? body.note : '可能已被清理'), 'warn');
    return;
  }
  if (body.kind === 'deferred') {
    toast('响应体尚未加载', 'warn');
    return;
  }

  if (body.kind === 'base64') {
    const bytes = base64ToBytes(body.data || '');
    if (asText) {
      const mime = contentTypeOf(req);
      if (isTextualMime(mime)) {
        saveBlob(new Blob([base64ToText(body.data || '')], { type: 'text/plain;charset=utf-8' }), suggestedFilename(req, '.txt'), '已开始下载文本');
      } else {
        // 二进制没有“可读文本”，导出 base64 文本便于排查
        saveBlob(new Blob([body.data || ''], { type: 'text/plain;charset=utf-8' }), suggestedFilename(req, '.base64.txt'), '二进制内容已按 Base64 文本下载');
      }
      return;
    }
    saveBlob(new Blob([bytes], { type: contentTypeOf(req) || 'application/octet-stream' }), suggestedFilename(req), '已开始下载原始响应');
    return;
  }

  if (body.kind === 'text') {
    const text = body.text || '';
    saveBlob(
      new Blob([text], { type: asText ? 'text/plain;charset=utf-8' : contentTypeOf(req) || 'text/plain;charset=utf-8' }),
      suggestedFilename(req, asText ? '.txt' : ''),
      '已开始下载'
    );
    return;
  }

  toast('该响应没有可下载的内容', 'warn');
}

// ---------------------------------------------------------------- Raw 视图

function buildRawDump(req) {
  const lines = [];
  lines.push('=== 请求 ===');
  lines.push(buildRawRequestText(req));
  lines.push('');
  lines.push('=== 响应 ===');
  lines.push(`HTTP ${req.status} ${req.statusText || ''}`.trim());
  for (const [name, value] of Object.entries(req.respHeaders || {})) {
    if (name.toLowerCase().startsWith(':')) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push('');

  const body = req.respBody;
  if (body && body.kind === 'text') {
    lines.push(body.truncated ? body.text + '\n…（已截断）' : body.text);
  } else if (body && body.kind === 'base64') {
    lines.push(`[二进制响应体 ${formatBytes(body.size)}，Content-Type: ${contentTypeOf(req) || '未知'}]`);
  } else if (body && body.kind === 'deferred') {
    lines.push(`[响应体待加载，${formatBytes(body.size)}；可在 Response 标签中加载或下载]`);
  } else {
    lines.push('[无响应体]');
  }
  return lines.join('\n');
}
