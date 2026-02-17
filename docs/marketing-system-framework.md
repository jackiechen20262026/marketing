# 市场推广系统（EJS + Node.js + MySQL）一期框架

## 1. 技术栈与分层

- **前端渲染层**：EJS 模板（SSR），用于后台运营系统页面。
- **后端服务层**：Node.js + Express，按 `routes / services / integrations / jobs` 分层。
- **数据层**：MySQL（主业务库），通过 `mysql2` 连接池访问。
- **外部集成**：亚马逊卖家信息导入（文件/接口）与圆通快递推单 + 轨迹回传。

建议目录（可在当前 `server/` 下逐步演进）：

```text
server/
  routes/
    portal.ts              # 页面路由
    api.ts                 # 后续前后端分离接口
  services/
    lead.service.ts        # 线索池、筛选、批量操作
    campaign.service.ts    # 宣传单任务
    shipment.service.ts    # 圆通推单、状态同步
    followup.service.ts    # 客户跟进记录
    analytics.service.ts   # 分析统计
  integrations/
    amazon.provider.ts     # 亚马逊数据适配
    yto.client.ts          # 圆通 API client
  jobs/
    sync-shipment.ts       # 物流轨迹定时同步
  views/
    portal/
      lead_pool.ejs
      campaign.ejs
      shipments.ejs
      followups.ejs
      analytics.ejs
```

## 2. 业务模块（按你给的 6 步）

### 模块 A：导入/新建线索池（来源：亚马逊卖家信息）

- 支持两种入口：
  1. Excel/CSV 导入。
  2. 手工新建。
- 线索去重规则：`amazon_seller_id` 优先，其次 `company_name + country + phone/email`。
- 导入结果分组：成功、重复、失败（含失败原因）。

### 模块 B：筛选勾选客户 → 进入发宣传单页面

- 在线索池页按国家、类目、店铺评分、活跃度筛选。
- 支持批量勾选，生成「宣传单任务」（campaign batch）。
- 在宣传单页面可维护：模板、语言、投放备注、预计发单日期。

### 模块 C：推单给圆通快递

- 将宣传单任务中需要邮寄的客户地址打包成 shipment 批次。
- 对接圆通下单接口，拿到 `waybill_no`。
- 推送状态：`NotPushed / Pushed / Failed`，失败支持重推。

### 模块 D：跟进轨迹

- 快递轨迹同步：
  - 主动拉取（定时任务每 15~30 分钟）。
  - 被动回调（若圆通支持 webhook）。
- 轨迹状态标准化：`Pending / InTransit / Delivered / Exception / Returned`。

### 模块 E：客户跟进汇总

- 每个客户记录触达动作：电话、邮件、WhatsApp、站内信。
- 跟进结果归类：无响应、意向中、待报价、成交、关闭。
- 提供客户 360 时间线：线索导入 → 发宣传单 → 物流签收 → 人工跟进。

### 模块 F：分析页

一期重点指标：

- 线索漏斗：导入数 → 筛选数 → 发单数 → 签收数 → 有效跟进数 → 成交数。
- 物流转化：签收后 7/14/30 天内意向率与成交率。
- 团队效率：人均跟进量、人均转化。
- 渠道质量：不同来源（亚马逊类目/国家）线索质量对比。

## 3. 核心数据模型（MySQL）

建议核心表：

1. `leads`：线索主表（来源、联系人、阶段、owner）。
2. `lead_tags`：线索标签（国家、类目、优先级）。
3. `campaign_batches`：宣传单批次。
4. `campaign_batch_items`：批次内客户明细。
5. `shipments`：运单主表（waybill、推单状态、物流状态）。
6. `shipment_events`：物流轨迹事件。
7. `lead_followups`：人工跟进记录。
8. `workflow_stage_history`：阶段变更历史。

阶段建议：

- `已导入` → `已筛选` → `已发册` → `跟踪中` → `已签收` → `跟进中` → `潜在客户` → `已转化`
- 旁路：`退件`、`已关闭`

## 4. 接口与任务流（一期）

- 导入线索：`POST /api/leads/import`
- 新建线索：`POST /api/leads`
- 批量建宣传单任务：`POST /api/campaigns/batches`
- 批量推单圆通：`POST /api/shipments/push`
- 物流轨迹同步任务：`POST /api/jobs/sync-shipments`（内部调用）
- 客户跟进记录：`POST /api/leads/:id/followups`
- 分析页聚合：`GET /api/analytics/overview`

## 5. 一期里程碑（2~3 周）

- **M1（第 1 周）**：线索导入、新建、筛选、勾选 + 宣传单页面。
- **M2（第 2 周）**：圆通推单、运单列表、轨迹回传、状态看板。
- **M3（第 3 周）**：客户跟进汇总、分析页、基础权限（Admin/运营/销售）。

## 6. 当前仓库落地建议

- 保留现有 EJS + Express 架构。
- 在现有 `portal` 路由上增加：
  - 线索导入页（upload + preview）
  - 宣传单任务页（batch create）
  - 跟进汇总页（按销售/阶段汇总）
  - 分析页（漏斗 + 趋势）
- 圆通先做 mock client，联调时替换成正式鉴权与签名。
