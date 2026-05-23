import { pool } from "../db.js";

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clampInt(v, min, max, def) {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ✅ 关键：按 txn_date,id 顺序，基于 NORMAL 金额重算整条余额链
async function recomputeBalances(conn) {
  const [rows] = await conn.query(
    `
    SELECT id, type, amount, status
    FROM finance_ledger
    ORDER BY txn_date ASC, id ASC
    `
  );

  let bal = 0;
  // 批量更新（逐条 update，数据量通常不大；后续可优化成批量 CASE WHEN）
  for (const r of rows) {
    const amt = toNum(r.amount, 0);

    if (r.status === "NORMAL") {
      bal = r.type === "IN" ? bal + amt : bal - amt;
    } else {
      // VOID：不影响余额，直接“继承当前余额”
    }

    await conn.query(
      `UPDATE finance_ledger SET balance_after=:bal WHERE id=:id`,
      { bal, id: r.id }
    );
  }

  return bal;
}

export async function listPage(req, res) {
  const q = req.query || {};
  const page = clampInt(q.page, 1, 99999, 1);
  const pageSize = clampInt(q.pageSize, 10, 200, 50);

  const type = (q.type === "IN" || q.type === "OUT") ? q.type : "";
  const status = (q.status === "NORMAL" || q.status === "VOID") ? q.status : ""; // 空=全部
  const start = q.start ? String(q.start) : "";
  const end = q.end ? String(q.end) : "";
  const kw = q.kw ? String(q.kw).trim() : "";
  const category = q.category ? String(q.category).trim() : "";

  let where = "WHERE 1=1";
  const params = {};

  if (type) { where += " AND type=:type"; params.type = type; }
  if (status) { where += " AND status=:status"; params.status = status; }
  if (start) { where += " AND txn_date>=:start"; params.start = start; }
  if (end) { where += " AND txn_date<=:end"; params.end = end; }
  if (category) { where += " AND category=:category"; params.category = category; }
  if (kw) {
    where += " AND (note LIKE :kw OR operator_name LIKE :kw)";
    params.kw = `%${kw}%`;
  }

  const offset = (page - 1) * pageSize;

  const [[cntRow]] = await pool.query(
    `SELECT COUNT(*) as c FROM finance_ledger ${where}`,
    params
  );
  const total = Number(cntRow?.c || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const [rows] = await pool.query(
    `
    SELECT *
    FROM finance_ledger
    ${where}
    ORDER BY txn_date DESC, id DESC
    LIMIT :limit OFFSET :offset
    `,
    { ...params, limit: pageSize, offset }
  );

  // 本月汇总（只算 NORMAL）
  const [m] = await pool.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN type='IN' THEN amount ELSE 0 END),0) as total_in,
      COALESCE(SUM(CASE WHEN type='OUT' THEN amount ELSE 0 END),0) as total_out
    FROM finance_ledger
    WHERE status='NORMAL'
      AND DATE_FORMAT(txn_date,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')
    `
  );
  const monthStats = m?.[0] || { total_in: 0, total_out: 0 };

  // 当前余额：取按链重算后的最新一条 balance_after（包含 VOID 的“继承值”也没问题）
  const [b] = await pool.query(
    `SELECT balance_after FROM finance_ledger ORDER BY txn_date DESC, id DESC LIMIT 1`
  );
  const currentBalance = b?.length ? toNum(b[0].balance_after, 0) : 0;

  res.render("finance/ledger", {
    title: "财务流水",
    rows,

    filters: { type, status, start, end, kw, category, page, pageSize },
    pager: { page, pageSize, total, totalPages },

    monthStats,
    currentBalance,
  });
}

export async function create(req, res) {
  const body = req.body || {};
  const txn_date = String(body.txn_date || "");
  const type = body.type === "IN" ? "IN" : (body.type === "OUT" ? "OUT" : "");
  const amount = toNum(body.amount, NaN);
  const category = (body.category == null ? "" : String(body.category).trim()) || null;
  const note = (body.note == null ? "" : String(body.note).trim()) || null;

  if (!txn_date || !type || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).render("errors/500", {
      title: "参数错误",
      error: new Error("txn_date/type/amount 参数不正确"),
      active: "",
      user: req.session?.user || null,
    });
  }

  const user = req.session.user;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 先插入（balance_after 先写 0，随后统一重算，确保补录历史也正确）
    await conn.query(
      `
      INSERT INTO finance_ledger
      (txn_date,type,amount,balance_after,category,note,status,operator_id,operator_name)
      VALUES
      (:txn_date,:type,:amount,0,:category,:note,'NORMAL',:operator_id,:operator_name)
      `,
      {
        txn_date,
        type,
        amount,
        category,
        note,
        operator_id: user.id,
        operator_name: user.name || user.username || "",
      }
    );

    await recomputeBalances(conn);

    await conn.commit();
    return res.redirect("/portal/finance-ledger");
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function voidRecord(req, res) {
  const { id } = req.params;
  const reason = (req.body?.reason == null ? "" : String(req.body.reason).trim()) || null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `
      UPDATE finance_ledger
      SET status='VOID', void_reason=:reason, voided_at=NOW()
      WHERE id=:id
      `,
      { id, reason }
    );

    await recomputeBalances(conn);

    await conn.commit();
    return res.redirect("/portal/finance-ledger");
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}