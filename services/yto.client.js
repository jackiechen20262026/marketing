// services/yto.client.js
import crypto from 'node:crypto';

function md5Bytes(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest(); // Buffer(16)
}

function signForOpen({ paramStr, method, v, secret }) {
  // 文档：data = param + method + v；签名内容 = data + secret；md5(byte16) + base64
  const data = `${paramStr}${method}${v}`;
  return md5Bytes(`${data}${secret}`).toString('base64');
}

function tsMs() {
  return String(Date.now());
}

async function postJson(url, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }

    return { ok: res.ok, status: res.status, data: json };
  } finally {
    clearTimeout(t);
  }
}

export class YtoClient {
  constructor() {
    this.baseUrl = (process.env.YTO_BASE_URL || '').trim();
    this.secret = (process.env.YTO_SECRET || '').trim();

    this.create = {
      path: (process.env.YTO_CREATE_PATH || '').trim(),
      method: (process.env.YTO_CREATE_METHOD || '').trim(),
      v: String(process.env.YTO_CREATE_V || '').trim(), // ✅ 必须是 v1
    };

    this.track = {
      path: (process.env.YTO_TRACK_PATH || '').trim(),
      method: (process.env.YTO_TRACK_METHOD || '').trim(),
      v: String(process.env.YTO_TRACK_V || '').trim(), // ✅ 建议 v1
    };

    if (!this.baseUrl) throw new Error('Missing env: YTO_BASE_URL');
    if (!this.secret) throw new Error('Missing env: YTO_SECRET');

    for (const [k, api] of Object.entries({ create: this.create, track: this.track })) {
      if (!api.path || !api.method || !api.v) {
        throw new Error(`Missing env for ${k}: path/method/v`);
      }
    }
  }

  buildEnvelope(paramObj, api) {
    const timestamp = tsMs();
    const paramStr = JSON.stringify(paramObj); // param 必须是 JSON 字符串
    const sign = signForOpen({ paramStr, method: api.method, v: api.v, secret: this.secret });
    return { timestamp, param: paramStr, sign, format: 'JSON' };
  }

  async createOrder(paramObj) {
    const url = `${this.baseUrl}${this.create.path}`;
    const body = this.buildEnvelope(paramObj, this.create);
    const resp = await postJson(url, body);

    if (!resp.ok) {
      throw new Error(`YTO create HTTP ${resp.status}: ${JSON.stringify(resp.data)}`);
    }
    if (resp.data && resp.data.success === false) {
      throw new Error(`YTO create failed: code=${resp.data.code} reason=${resp.data.reason}`);
    }
    return resp.data;
  }

  async queryTrack(waybillNo) {
    const url = `${this.baseUrl}${this.track.path}`;
    const body = this.buildEnvelope({ NUMBER: waybillNo }, this.track);
    const resp = await postJson(url, body);
    if (!resp.ok) throw new Error(`YTO track HTTP ${resp.status}: ${JSON.stringify(resp.data)}`);
    return resp.data;
  }
}
