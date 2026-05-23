// middlewares/leadStats.js
import { pool } from "../db.js";

export async function leadStatsMiddleware(req, res, next) {
  try {
    if (!req.session?.user) return next();

    // 默认值（即便部分 SQL 失败也不会影响页面）
    res.locals.leadStats = { today: 0, week: 0, month: 0 };
    res.locals.navCounts = {
      demand: 0,
      partner: 0,
      sample: 0,
      deal: 0,
      plans: 0,
      followups: 0,
      batches: 0,
    };

    // ===== 1) 顶部统计 + 四阶段角标：一条 SQL（leads）=====
    const sqlLeadStatsAndStages = `
      SELECT
        /* 顶部：今日/本周/本月新增（只统计 is_active=1） */
        SUM(
          CASE
            WHEN is_active = 1
             AND created_at >= CURDATE()
             AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
            THEN 1 ELSE 0
          END
        ) AS today,

        SUM(
          CASE
            WHEN is_active = 1
             AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
            THEN 1 ELSE 0
          END
        ) AS week,

        SUM(
          CASE
            WHEN is_active = 1
             AND YEAR(created_at) = YEAR(CURDATE())
             AND MONTH(created_at) = MONTH(CURDATE())
            THEN 1 ELSE 0
          END
        ) AS month,

        /* 第1步：有需求客人（is_active=1 且不含已关闭） */
        SUM(
          CASE
            WHEN is_active = 1
             AND COALESCE(is_closed,0)=0
             AND wechat IS NOT NULL
             AND TRIM(wechat) <> ''
             AND (wechat_group_code IS NULL OR TRIM(wechat_group_code) = '')
            THEN 1 ELSE 0 END
        ) AS demand_count,

        /* 第2步：合作意向客人（已建群 + 未寄样） */
        SUM(
          CASE
            WHEN is_active = 1
             AND COALESCE(is_closed,0)=0
             AND wechat_group_code IS NOT NULL
             AND TRIM(wechat_group_code) <> ''
             AND (sample_tracking_no IS NULL OR TRIM(sample_tracking_no) = '')
            THEN 1 ELSE 0 END
        ) AS partner_count,

        /* 第3步：已寄样品（有单号 + 未成交） */
        SUM(
          CASE
            WHEN is_active = 1
             AND COALESCE(is_closed,0)=0
             AND sample_tracking_no IS NOT NULL
             AND TRIM(sample_tracking_no) <> ''
             AND COALESCE(workflow_stage, '') <> '已成交'
            THEN 1 ELSE 0 END
        ) AS sample_count,

        /* 第4步：已成交 */
        SUM(
          CASE
            WHEN is_active = 1
             AND COALESCE(is_closed,0)=0
             AND COALESCE(workflow_stage, '') = '已成交'
            THEN 1 ELSE 0 END
        ) AS deal_count
      FROM leads
    `;

    try {
      const [rows] = await pool.query(sqlLeadStatsAndStages);
      const r = rows?.[0] || {};

      res.locals.leadStats = {
        today: Number(r.today || 0),
        week: Number(r.week || 0),
        month: Number(r.month || 0),
      };

      res.locals.navCounts.demand = Number(r.demand_count || 0);
      res.locals.navCounts.partner = Number(r.partner_count || 0);
      res.locals.navCounts.sample = Number(r.sample_count || 0);
      res.locals.navCounts.deal = Number(r.deal_count || 0);
    } catch (e) {
      console.error("leadStatsAndStages query error:", e?.message || e);
    }

    // ===== 2) 总计划角标：未完成计划数（PLANNED）=====
    try {
      const [[r]] = await pool.query(
        `
        SELECT COUNT(1) AS cnt
        FROM lead_followup_plans
        WHERE status='PLANNED'
        `
      );
      res.locals.navCounts.plans = Number(r?.cnt || 0);
    } catch (e) {
      console.error("navCounts.plans query error:", e?.message || e);
    }

    // ===== 3) 总跟进角标：需要分析但未分析（待处理）=====
    try {
      const [[r]] = await pool.query(
        `
        SELECT COUNT(1) AS cnt
        FROM lead_followups
        WHERE COALESCE(need_analysis,0)=1
          AND (analysis IS NULL OR TRIM(analysis)='')
        `
      );
      res.locals.navCounts.followups = Number(r?.cnt || 0);
    } catch (e) {
      console.error("navCounts.followups query error:", e?.message || e);
    }

    // ===== 4) 批次角标：批次数量（表名已确认 campaign_batches）=====
    try {
      const [[r]] = await pool.query(
        `
        SELECT COUNT(1) AS cnt
        FROM campaign_batches
        `
      );
      res.locals.navCounts.batches = Number(r?.cnt || 0);
    } catch (e) {
      console.error("navCounts.batches query error:", e?.message || e);
    }

    return next();
  } catch (err) {
    console.error("leadStatsMiddleware error:", err);
    // 兜底：不让页面炸
    res.locals.leadStats = null;
    res.locals.navCounts = {
      demand: 0,
      partner: 0,
      sample: 0,
      deal: 0,
      plans: 0,
      followups: 0,
      batches: 0,
    };
    return next();
  }
}