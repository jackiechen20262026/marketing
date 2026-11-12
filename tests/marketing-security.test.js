import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db.js";
import {
  assertEligible,
  transaction,
  savePlan,
} from "../services/mailing.service.js";
import {
  openException,
  resolveException,
} from "../services/mailingExceptions.js";
import batch from "../services/batch.service.js";
import { runAnalysis } from "../services/aiAssistant.js";
import { aiReadPool, closeAiReadPool } from "../services/aiReadPool.js";
import { executeReadTool } from "../services/aiTools.js";
test("旧规则、异常解除、权限与AI故障隔离", async (t) => {
  assert.match(process.env.DB_NAME, /^marketing_upgrade_restore_/);
  const [[admin]] = await db.query(
    "SELECT id,role FROM users WHERE role='Admin' LIMIT 1",
  );
  const [[user]] = await db.query(
    "SELECT id,role FROM users WHERE role='User' LIMIT 1",
  );
  const [l] = await db.query(
    "INSERT INTO leads(company_name,owner_id) VALUES(?,?)",
    ["SECURITY_TEST_" + Date.now(), admin.id],
  );
  const id = l.insertId;
  const [b] = await db.query(
    "INSERT INTO campaign_batches(batch_name,status) VALUES('SECURITY_TEST','done')",
  );
  const [s] = await db.query(
    "INSERT INTO shipments(batch_id,lead_id,waybill_no,created_at,dispatched_at) VALUES(?,?,?,DATE_SUB(NOW(),INTERVAL 31 DAY),UTC_TIMESTAMP())",
    [b.insertId, id, "SEC_" + id],
  );
  await t.test("未设置新周期保持无群30天、有群90天", async () => {
    await assertEligible(db, id);
    await db.query("UPDATE leads SET wechat_group_code='test' WHERE id=?", [
      id,
    ]);
    await assert.rejects(assertEligible(db, id));
    await db.query(
      "UPDATE shipments SET created_at=DATE_SUB(NOW(),INTERVAL 91 DAY) WHERE id=?",
      [s.insertId],
    );
    await assertEligible(db, id);
  });
  await t.test(
    "重要标记和管理员提前发件不能绕过明确异常；解除有审计",
    async () => {
      await db.query(
        "UPDATE shipments SET logistics_status='EXCEPTION' WHERE id=?",
        [s.insertId],
      );
      await transaction((c) =>
        openException(
          c,
          { id: s.insertId, lead_id: id },
          "returned",
          "test",
          true,
        ),
      );
      await assert.rejects(
        batch.createBatch({
          user: admin,
          batchName: "test",
          leadIds: [id],
          early: true,
          reason: "test",
        }),
      );
      const [[x]] = await db.query(
        "SELECT id FROM mailing_exceptions WHERE shipment_id=?",
        [s.insertId],
      );
      await assert.rejects(resolveException(admin, x.id, { note: "test" }));
      await resolveException(admin, x.id, {
        note: "已核实可以恢复",
        condition: "测试已解除",
      });
      await assertEligible(db, id);
    },
  );
  await t.test("非管理员不能提前发件；取消草稿释放占用", async () => {
    await assert.rejects(
      batch.createBatch({
        user,
        batchName: "test",
        leadIds: [id],
        early: true,
        reason: "test",
      }),
    );
    const draft = await batch.createBatch({
      user: admin,
      batchName: "test",
      leadIds: [id],
    });
    await batch.deleteBatch({ id: draft.id });
    await assertEligible(db, id);
  });
  await t.test("计划版本冲突、暂停、恢复和手动日期优先", async () => {
    const plan = {
      enabled: "1",
      months: 2,
      next_at: "2030-01-31T12:00",
      reminder_days: 3,
      reason: "test",
      version: 0,
    };
    await savePlan(admin, id, plan);
    await assert.rejects(savePlan(admin, id, plan));
    await assert.rejects(assertEligible(db, id));
    await savePlan(admin, id, { ...plan, version: 1, paused: "1" });
    await assert.rejects(assertEligible(db, id, { early: true }));
    await savePlan(admin, id, { ...plan, version: 2, paused: "0" });
    await assertEligible(db, id, { early: true });
  });
  await t.test("AI最小数据库权限禁止写入与凭据读取", async () => {
    const c = await aiReadPool().getConnection();
    try {
      await assert.rejects(c.query("SELECT password_hash FROM users LIMIT 1"));
      await assert.rejects(
        c.query("UPDATE leads SET important_flag=1 WHERE id=?", [id]),
      );
    } finally {
      c.release();
    }
    const r = await executeReadTool(
      "customer_search",
      {
        leadIds: [id],
        keyword: "",
        importantOnly: false,
        minDispatches: 0,
        maxFollowups: 0,
      },
      { userId: admin.id },
      aiReadPool(),
    );
    assert.equal(r.rows.length, 1);
  });
  await t.test("无揽收原单经审计释放后可人工补寄，取消补寄草稿释放占用",async()=>{
    await db.query('UPDATE shipments SET dispatched_at=NULL WHERE id=?',[s.insertId]);
    await transaction(c=>openException(c,{id:s.insertId,lead_id:id},'customer_not_received','原单未收到',true));
    await assert.rejects(batch.createBatch({user:admin,batchName:'resend test',leadIds:[id],early:true,reason:'测试',originalShipmentId:s.insertId}));
    const [[x]]=await db.query("SELECT id FROM mailing_exceptions WHERE shipment_id=? AND kind='customer_not_received'",[s.insertId]);
    await resolveException(admin,x.id,{note:'已核查原单',condition:'已确认允许补寄',release_reservation:'1'});
    const resend=await batch.createBatch({user:admin,batchName:'resend test',leadIds:[id],early:true,reason:'测试',originalShipmentId:s.insertId});
    const [[child]]=await db.query('SELECT original_shipment_id FROM shipments WHERE batch_id=?',[resend.id]);assert.equal(Number(child.original_shipment_id),Number(s.insertId));
    await batch.deleteBatch({id:resend.id});await assertEligible(db,id,{early:true});
  });
  const sessionId = crypto.randomUUID();
  await db.query("INSERT INTO ai_sessions(id,user_id,title) VALUES(?,?,?)", [
    sessionId,
    admin.id,
    "security test",
  ]);
  const nativeFetch = globalThis.fetch;
  async function run(
    message = "test",
    requestKey = crypto.randomUUID(),
    signal = new AbortController().signal,
  ) {
    return runAnalysis({
      userId: admin.id,
      sessionId,
      requestKey,
      message,
      selectedIds: [id],
      signal,
      emit: () => {},
    });
  }
  await t.test("API失败隔离、相同请求去重、取消", async () => {
    const previousBudget = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = "100";
    const key = crypto.randomUUID();
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(run("test", key), /OPENAI_HTTP_429/);
    await assert.rejects(run("test", key));
    globalThis.fetch = async (_url, options) => {
      options.signal.throwIfAborted();
      throw Error("unexpected");
    };
    const c = new AbortController();
    c.abort();
    await assert.rejects(
      run("test", crypto.randomUUID(), c.signal),
      /CANCELLED_OR_TIMEOUT/,
    );
    globalThis.fetch = nativeFetch;
    process.env.AI_DAILY_BUDGET_USD = previousBudget;
    const [[r]] = await db.query("SELECT company_name FROM leads WHERE id=?", [
      id,
    ]);
    assert.ok(r.company_name.startsWith("SECURITY_TEST_"));
  });
});
test.after(async () => {
  await closeAiReadPool();
  await db.end();
});
