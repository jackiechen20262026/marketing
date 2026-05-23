// scripts/yto-track-test.mjs
import 'dotenv/config';
import { YtoClient } from '../services/yto.client.js';

const yto = new YtoClient();

async function main() {
  const waybillNo = 'YT2542472832143';
  const resp = await yto.queryTrack(waybillNo);
  console.log(resp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
