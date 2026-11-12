import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import {
  wallToUtc,
  wallTime,
  addNaturalMonths,
  utcSql,
} from "../services/mailingCalendar.js";
import {
  parseTrackSummary,
  updateTrackByShipmentId,
} from "../services/shipment.track.service.js";
import { db } from "../db.js";
import {
  setImportant,
  savePlan,
  scanPlans,
  shipmentAction,
  transaction,
  recordMailEvent,
} from "../services/mailing.service.js";
import batch from "../services/batch.service.js";
import { listStats, exportStats } from "../services/mailingStats.js";
import { executeReadTool } from "../services/aiTools.js";
import { ownedSession } from "../services/aiAssistant.js";
const node = (desc, time = "2026-03-06 12:00:00", code) => ({
  processInfo: desc,
  upload_Time: time,
  infoContent: code,
});
test("自然月月末、闰年、夏令时与固定业务时区", () => {
  assert.equal(
    wallTime(addNaturalMonths(wallToUtc("2024-01-31 12:00:00"), 1)),
    "2024-02-29 12:00:00",
  );
  assert.equal(
    wallTime(addNaturalMonths(wallToUtc("2025-01-31 12:00:00"), 1)),
    "2025-02-28 12:00:00",
  );
  assert.equal(
    wallTime(addNaturalMonths(wallToUtc("2026-03-01 12:00:00"), 1)),
    "2026-04-01 12:00:00",
  );
  assert.throws(() => wallToUtc("2026-03-29 02:30:00"));
  assert.equal(utcSql(wallToUtc("2026-10-25 02:30:00")), "2026-10-25 00:30:00");
  assert.equal(
    wallTime(addNaturalMonths(wallToUtc("2026-02-28 02:30:00"), 1)),
    "2026-03-28 02:30:00",
  );
  assert.throws(() => addNaturalMonths(new Date(), 0));
});
for (const text of [
  "未签收",
  "待签收",
  "等待签收",
  "未妥投",
  "not delivered",
  "not signed",
  "退回寄件方已签收",
  "拒收",
])
  test("不误判 " + text, () =>
    assert.equal(parseTrackSummary([node(text)]).isSigned, false),
  );
test("真实map格式、空节点、业务失败、解析失败", () => {
  assert.equal(parseTrackSummary([{...node('签收人：本人',undefined,'SIGNED'),waybill_No:'YT_TEST'}],{waybillNo:'YT_TEST'}).queryStatus,'OK');
  assert.equal(parseTrackSummary({map:{OTHER:[node('签收',undefined,'SIGNED')]}},{waybillNo:'YT_TEST'}).queryStatus,'WAYBILL_MISMATCH');
  assert.equal(
    parseTrackSummary({ map: { YT: [] }, code: "1001", success: "true" })
      .queryStatus,
    "NO_NODES",
  );
  assert.equal(
    parseTrackSummary({ success: "false", message: "error" }).queryStatus,
    "BUSINESS_ERROR",
  );
  assert.equal(parseTrackSummary({ foo: "bar" }).queryStatus, "PARSE_ERROR");
  assert.equal(
    parseTrackSummary({
      map: { YT: [node("已揽收", undefined, "GOT")] },
      success: "true",
    }).statusText,
    "IN_TRANSIT",
  );
  assert.equal(
    parseTrackSummary([node("客户签收人：本人", undefined, "SIGNED")]).isSigned,
    true,
  );
  assert.equal(
    parseTrackSummary([
      node("退回寄件方", "2026-03-06 11:00:00", "TMS_RETURN"),
      node("签收", undefined, "SIGNED"),
    ]).isSigned,
    false,
  );
  assert.equal(
    parseTrackSummary([
      node("已签收", "2026-03-06 11:00:00"),
      node("派送异常", undefined, "FAILED"),
    ]).statusText,
    "EXCEPTION",
  );
  assert.equal(parseTrackSummary([]).signReceiveType, "未知");
  assert.equal(
    parseTrackSummary([node("已签收", null, "SIGNED")]).signedTime,
    null,
  );
});
test("隔离数据库业务与权限验收", async (t) => {
  assert.match(
    process.env.DB_NAME,
    /^marketing_upgrade_restore_/,
    "禁止在生产执行测试",
  );
  const [[admin]] = await db.query(
    "SELECT id,role FROM users WHERE role='Admin' AND status=1 LIMIT 1",
  );
  const [[other]] = await db.query(
    "SELECT id,role FROM users WHERE role='User' AND status=1 LIMIT 1",
  );
  const prefix = "UPGRADE_TEST_" + Date.now();
  const [insert] = await db.query(
    "INSERT INTO leads(company_name,owner_id) VALUES(?,?)",
    [prefix, admin.id],
  );
  const id = insert.insertId;
  const plan = {
    enabled: "1",
    months: 1,
    next_at: "2020-01-31T12:00",
    reminder_days: 3,
    reason: "测试",
    owner_id: "",
    version: 0,
  };
  await t.test("重要标记、并发扫描、待分配、改计划清理旧任务", async () => {
    await setImportant(admin, id, true);
    await savePlan(admin, id, plan);
    await Promise.all([scanPlans(), scanPlans(), scanPlans()]);
    let [[n]] = await db.query(
      "SELECT COUNT(*) n FROM todo_tasks WHERE lead_id=? AND task_type='mailing_due' AND status='pending'",
      [id],
    );
    assert.equal(Number(n.n), 1);
    await savePlan(admin, id, { ...plan, version: 1, paused: "1" });
    await scanPlans();
    [[n]] = await db.query(
      "SELECT COUNT(*) n FROM todo_tasks WHERE lead_id=? AND status='pending'",
      [id],
    );
    assert.equal(Number(n.n), 0);
    await savePlan(admin, id, { ...plan, version: 2 });
    await scanPlans();
  });
  let b;
  await t.test("批次并发占用、重要标记不清除、草稿不计寄出", async () => {
    const results = await Promise.allSettled([
      batch.createBatch({ user: admin, batchName: prefix, leadIds: [id] }),
      batch.createBatch({ user: admin, batchName: prefix, leadIds: [id] }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    b = results.find((r) => r.status === "fulfilled").value;
    const [[l]] = await db.query(
      "SELECT important_flag FROM leads WHERE id=?",
      [id],
    );
    assert.equal(l.important_flag, 1);
    const r = await listStats({ keyword: prefix, user: admin });
    assert.equal(r.rows[0].dispatched_count, 0);
    assert.equal(r.rows[0].mail_count, 1);
  });
  await t.test("移出释放占用、保留历史批次次数", async () => {
    await batch.removeBatchItems({ batchId: b.id, leadIds: [id] });
    b = await batch.createBatch({
      user: admin,
      batchName: prefix,
      leadIds: [id],
    });
    const r = await listStats({ keyword: prefix, user: admin });
    assert.equal(r.rows[0].mail_count, 2);
  });
  let ship;
  await t.test("只有单号不计寄出，人工证据幂等推进周期", async () => {
    const [r] = await db.query(
      "INSERT INTO shipments(batch_id,lead_id,waybill_no,push_status) VALUES(?,?,?,'pushed')",
      [b.id, id, "TEST_" + id],
    );
    ship = r.insertId;
    assert.equal(
      (await listStats({ keyword: prefix, user: admin })).rows[0]
        .dispatched_count,
      0,
    );
    await Promise.all([
      shipmentAction(admin, ship, {
        action: "dispatch",
        at: "2024-01-31T12:00",
        evidence: "测试凭证",
      }),
      shipmentAction(admin, ship, {
        action: "dispatch",
        at: "2024-01-31T12:00",
        evidence: "重复测试",
      }),
    ]);
    assert.equal(
      (await listStats({ keyword: prefix, user: admin })).rows[0]
        .dispatched_count,
      1,
    );
    const [[p]] = await db.query(
      "SELECT next_at,version FROM mailing_plans WHERE lead_id=?",
      [id],
    );
    assert.equal(p.next_at, "2024-02-29 11:00:00");
    assert.equal(p.version, 4);
  });
  await t.test("查询失败不覆盖已有物流状态", async () => {
    await db.query(
      "UPDATE shipments SET logistics_status='SIGNED',signed_at='2024-02-01 12:00:00' WHERE id=?",
      [ship],
    );
    const r = await updateTrackByShipmentId(ship, { force: true });
    assert.equal(r.ok, false);
    const [[s]] = await db.query(
      "SELECT logistics_status,signed_at FROM shipments WHERE id=?",
      [ship],
    );
    assert.equal(s.logistics_status, "SIGNED");
    assert.equal(s.signed_at, "2024-02-01 12:00:00");
  });
  await t.test("重复轨迹、缺失签收时间、空节点及业务失败保留事实", async () => {
    const [b2]=await db.query("INSERT INTO campaign_batches(batch_name,status) VALUES(?,'done')",[prefix]);
    const [s2]=await db.query("INSERT INTO shipments(batch_id,lead_id,waybill_no,push_status) VALUES(?,?,?,'pushed')",[b2.insertId,id,'QUERY_'+id]);
    const original=globalThis.fetch;
    try{
      globalThis.fetch=async()=>new Response(JSON.stringify({map:{['QUERY_'+id]:[node('客户签收人：本人',null,'SIGNED')]},success:'true'}),{status:200});
      await updateTrackByShipmentId(s2.insertId,{force:true});await updateTrackByShipmentId(s2.insertId,{force:true});
      const [[event]]=await db.query("SELECT COUNT(*) n FROM mailing_events WHERE shipment_id=? AND event_type='signed'",[s2.insertId]);assert.equal(Number(event.n),1);
      let [[ship2]]=await db.query('SELECT signed_at,signed_observed_at FROM shipments WHERE id=?',[s2.insertId]);assert.equal(ship2.signed_at,null);assert.ok(ship2.signed_observed_at);
      for(const payload of [{map:{['QUERY_'+id]:[]},success:'true'},{map:{['QUERY_'+id]:[]},success:'false'},{unexpected:'shape'}]){
        globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:200});await updateTrackByShipmentId(s2.insertId,{force:true});
        [[ship2]]=await db.query('SELECT logistics_status FROM shipments WHERE id=?',[s2.insertId]);assert.equal(ship2.logistics_status,'SIGNED');
      }
    }finally{globalThis.fetch=original;}
  });
  await t.test("补寄不推进正常周期、重复事件不重复计数", async () => {
    const [r] = await db.query(
      "INSERT INTO campaign_batches(batch_name) VALUES(?)",
      [prefix],
    );
    const [s] = await db.query(
      "INSERT INTO shipments(batch_id,lead_id,waybill_no,original_shipment_id) VALUES(?,?,?,?)",
      [r.insertId, id, "RESEND_" + id, ship],
    );
    await shipmentAction(admin, s.insertId, {
      action: "dispatch",
      at: "2024-03-01T12:00",
      evidence: "补寄凭证",
    });
    const [[p]] = await db.query(
      "SELECT version FROM mailing_plans WHERE lead_id=?",
      [id],
    );
    assert.equal(p.version, 4);
    assert.equal(
      (await listStats({ keyword: prefix, user: admin, includeResends: "0" }))
        .rows[0].dispatched_count,
      1,
    );
  });
  await t.test("AI越权客户、会话、任意SQL与参数注入拒绝", async () => {
    await assert.rejects(
      executeReadTool(
        "customer_detail",
        { leadIds: [id], keyword: "" },
        { userId: other.id },
      ),
    );
    await assert.rejects(
      executeReadTool(
        "sql",
        { sql: "SELECT * FROM users" },
        { userId: admin.id },
      ),
    );
    await assert.rejects(
      executeReadTool(
        "customer_detail",
        { leadIds: [id], keyword: "", userId: admin.id },
        { userId: other.id },
      ),
    );
    await assert.rejects(ownedSession(other.id, "nonexistent"));
    const r = await executeReadTool(
      "customer_search",
      { leadIds: [], keyword: "' OR 1=1 --" },
      { userId: admin.id },
    );
    assert.equal(r.rows.length, 0);
  });
  await t.test("超过5000条数据库筛选、总数、分页和导出一致", async () => {
    for (let start = 0; start < 5100; start += 100) {
      const vals = Array.from({ length: 100 }, (_, i) => [
        prefix + "_page_" + (start + i),
        admin.id,
        start + i === 5099 ? 1 : 0,
      ]);
      await db.query(
        "INSERT INTO leads(company_name,owner_id,important_flag) VALUES ?",
        [vals],
      );
    }
    const f = { keyword: prefix + "_page_", important: "1", user: admin };
    const r = await listStats(f);
    assert.equal(r.pagination.total, 1);
    assert.ok(r.rows[0].company_name.endsWith("5099"));
    let count = 0;
    for await (const row of exportStats(f)) count++;
    assert.equal(count, 1);
    const all = await listStats({
      ...f,
      important: "",
      page: 26,
      pageSize: 200,
    });
    assert.equal(all.pagination.total, 5100);
    assert.equal(all.rows.length, 100);
  });
  await t.test("关闭客户不再产生发信任务", async () => {
    await db.query("UPDATE leads SET is_closed=1 WHERE id=?", [id]);
    await scanPlans();
    const [[r]] = await db.query(
      "SELECT COUNT(*) n FROM todo_tasks WHERE lead_id=? AND task_type='mailing_due' AND status='pending'",
      [id],
    );
    assert.equal(Number(r.n), 0);
  });
});
test.after(async () => db.end());
