import 'dotenv/config';
import crypto from 'node:crypto';

function md5Bytes(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest(); // Buffer(16)
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
  return { status: res.status, data: json };
}

// 文档版：base64(md5( (param+method+v)+secret ))
function signDoc(paramStr, method, v, secret) {
  const data = `${paramStr}${method}${v}`;
  return md5Bytes(`${data}${secret}`).toString('base64');
}

// 常见变体1：把 timestamp 也拼进去（有的网关这么做）
function signWithTs(paramStr, method, v, secret, timestamp) {
  const data = `${paramStr}${method}${v}${timestamp}`;
  return md5Bytes(`${data}${secret}`).toString('base64');
}

// 常见变体2：把 token 也拼进去（URL 里的 jEJxlq）
function signWithToken(paramStr, method, v, secret, token) {
  const data = `${paramStr}${method}${v}${token}`;
  return md5Bytes(`${data}${secret}`).toString('base64');
}

async function main() {
  const baseUrl = (process.env.YTO_BASE_URL || '').trim();
  const path = (process.env.YTO_CREATE_PATH || '').trim();
  const url = `${baseUrl}${path}`;

  const secret = (process.env.YTO_SECRET || '').trim();
  if (!baseUrl || !path || !secret) throw new Error('need YTO_BASE_URL/YTO_CREATE_PATH/YTO_SECRET');

  // 从你的 URL 里提取 token（/v1/<token>/<customerCode>）
  const token = path.split('/').slice(-2, -1)[0]; // jEJxlq

  const logisticsNo = `TEST${Date.now()}`;
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

  const timestamp = tsMs();

  // 你当前“猜测”的 method/v + 一些常见候选
  const methodCandidates = [
    (process.env.YTO_CREATE_METHOD || '').trim(),
    'privacy_create_adapter',
    'PRIVACY_CREATE_ADAPTER',
    'privacyCreateAdapter',
    'open/privacy_create_adapter',
    '/open/privacy_create_adapter',
    'createOrder',
    'CREATE_ORDER',
    token, // jEJxlq（有些平台把这个当 method 或参与签名）
  ].filter(Boolean);

  const vCandidates = [
    String(process.env.YTO_CREATE_V || '').trim(),
    '1',
    'v1',
    'V1',
    '01',
    '1.0',
  ].filter(Boolean);

  console.log('url=', url);
  console.log('token=', token);
  console.log('secret(len)=', secret.length);
  console.log('timestamp=', timestamp);
  console.log('paramStr=', paramStr);

  // 依次尝试：文档版 / 带timestamp / 带token
  const strategies = [
    { name: 'DOC', fn: (m, v) => signDoc(paramStr, m, v, secret) },
    { name: 'WITH_TS', fn: (m, v) => signWithTs(paramStr, m, v, secret, timestamp) },
    { name: 'WITH_TOKEN', fn: (m, v) => signWithToken(paramStr, m, v, secret, token) },
  ];

  for (const st of strategies) {
    for (const m of methodCandidates) {
      for (const v of vCandidates) {
        const sign = st.fn(m, v);
        const body = { timestamp, param: paramStr, sign, format: 'JSON' };
        const resp = await postJson(url, body);

        const code = resp?.data?.code;
        const reason = resp?.data?.reason;

        // 只要不是 401，就说明加密校验过了（哪怕后续入参错）
        if (code !== 401) {
          console.log('\n✅ PASSED ENCRYPT CHECK');
          console.log('strategy=', st.name);
          console.log('method=', m);
          console.log('v=', v);
          console.log('sign=', sign);
          console.log('status=', resp.status);
          console.log('resp=', resp.data);
          return;
        }
      }
    }
  }

  console.log('\n❌ All attempts still 401. Then either:');
  console.log('1) secret is not the real signing secret for this interface, or');
  console.log('2) method/v must be taken from console exactly (not guessable), or');
  console.log('3) the account is not enabled/whitelisted for this API on production URL.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
