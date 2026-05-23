import 'dotenv/config';
import crypto from 'node:crypto';

function md5Bytes(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest(); // Buffer(16)
}
function md5Hex(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex'); // 32 hex chars
}
function tsMs() {
  return String(Date.now());
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, data: json };
}

// 变体A：文档版：base64(md5Bytes(data + secret))
function signA(paramStr, method, v, secret) {
  const data = `${paramStr}${method}${v}`;
  return md5Bytes(`${data}${secret}`).toString('base64');
}

// 变体B：有些平台会：base64(md5Hex(data + secret))
function signB(paramStr, method, v, secret) {
  const data = `${paramStr}${method}${v}`;
  const hex = md5Hex(`${data}${secret}`);
  return Buffer.from(hex, 'utf8').toString('base64');
}

// 变体C：文档版 + 去空白（防止极少数 base64 实现差异）
function signC(paramStr, method, v, secret) {
  return signA(paramStr, method, v, secret).replace(/\s+/g, '');
}

async function main() {
  const baseUrl = (process.env.YTO_BASE_URL || '').trim();
  const path = (process.env.YTO_CREATE_PATH || '').trim();
  const url = `${baseUrl}${path}`;

  const method = String(process.env.YTO_CREATE_METHOD || '').trim();
  const v = String(process.env.YTO_CREATE_V || '').trim();
  const secret = String(process.env.YTO_SECRET || '').trim();

  if (!baseUrl || !path || !method || !v || !secret) {
    console.log({ baseUrl, path, method, v, secretLen: secret.length });
    throw new Error('env missing: need YTO_BASE_URL/YTO_CREATE_PATH/YTO_CREATE_METHOD/YTO_CREATE_V/YTO_SECRET');
  }

  // 下单参数（尽量简洁，减少变量）
  const logisticsNo = `TEST${Date.now()}`; // >= 7
  const paramObj = {
    logisticsNo,
    senderName: '测试1',
    senderProvinceName: '上海',
    senderCityName: '上海市',
    senderCountyName: '青浦区',
    senderAddress: '汇金路100号',
    senderMobile: '15900521555',
    recipientName: '测试2',
    recipientProvinceName: '重庆',
    recipientCityName: '重庆市',
    recipientCountyName: '万州区',
    recipientAddress: '汇金路100号',
    recipientMobile: '15900521556',
    productCode: 'PK',
  };

  const paramStr = JSON.stringify(paramObj);

  console.log('--- ENV CHECK ---');
  console.log('url=', url);
  console.log('method=', method);
  console.log('v=', v);
  console.log('secret(len)=', secret.length);
  console.log('paramStr=', paramStr);

  const variants = [
    ['A_doc_md5bytes_base64', signA],
    ['B_md5hex_then_base64', signB],
    ['C_doc_base64_trimws', signC],
  ];

  for (const [name, fn] of variants) {
    const sign = fn(paramStr, method, v, secret);
    const body = {
      timestamp: tsMs(),
      param: paramStr,
      sign,
      format: 'JSON',
    };

    const resp = await postJson(url, body);
    console.log(`\n=== TRY ${name} ===`);
    console.log('sign=', sign);
    console.log('status=', resp.status);
    console.log('resp=', resp.data);

    // 一旦不是 401，就说明算法正确或至少过了加密校验
    if (resp?.data && resp.data.code !== 401) {
      console.log('\n>>> NOT 401 ANYMORE. This variant likely matches signing rule.');
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
