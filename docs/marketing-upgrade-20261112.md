# 德国 Marketing 升级

生产调查基线：`C:\othello\marketing`，端口 8899，Company 的 server_control_apps 第 6 项启动 `node server.js`，进程实际工作目录经只读 PEB 核实。磁盘分支 `codex/redesign-marketing-promotion-system`，SHA `d980c887784e0da15e667e3eb98a50f62c263a17`。远端参考 `406939e…` 含另外五次提交，不能替代现场基线。本升级从现场 SHA 创建独立分支，不合并 main。

## 功能入口

- `/portal/mailing`：发信次数、重要、阶段、物流、到期、日期组合筛选；汇总、分页、CSV 导出共用数据库查询。
- `/portal/leads/:id/mailing`：重要标记，周期及负责人，延期、暂停、恢复，寄出凭证，客户确认，异常解决、附件、管理员提前发件和补寄草稿。
- `/portal/todos`：周期/异常待办；管理员能看到未分配待办，处理入口跳转发信计划。
- `/portal/ai-assistant`：个人历史会话、连续聊天、Responses 流式回答、客户范围和日期、引用、取消、重试。客户详情、线索池提供分析入口。

## 业务口径

“加入批次次数”保留原 COUNT(DISTINCT batch_id) 含已移出记录的口径。新版本取消草稿和移出保留记录；旧版本已物理删除的记录无法凭空恢复。

下单成功必须有成功接口事件；单号本身不证明寄出。实际寄出依赖圆通 GOT 揽收节点或人工录入实际时间及凭证。物流签收使用收件路径的 SIGNED 节点，退件路径的签收不算客户签收。客户确认收到为独立人工事实。事件以承运商与运单号、事件类型唯一去重；后续异常不会删除已记录成功事实。补寄关联原运单，可选择统计是否计入，默认不推进正常周期。

历史无可靠寄出依据为未知，不补造事件。全部历史包含已确认但缺少事件时间的事实，日期区间只包含有可靠事件时间的事实。寄出、下单、签收、确认各用自身时间，不共用 shipment.created_at。

新周期固定 Europe/Berlin，自然月加法按目标月月末截断，闰年正确；春季不存在的手工本地时间拒绝，重复时间选较早一次；自动月周期落在春季缺口时顺延一小时。新计划要求首次日期，启用后按下一次日期候选。修改计划增版本并使旧待办失效；批次记录计划版本，修改后旧批次的寄出不会覆盖手工下一次日期。默认只有实际寄出推进周期。暂停、关闭、停用、明确物流异常和重复占用都阻止常规入批。重要标记只排序，绝不绕过这些限制。未启用新计划的客户维持旧无群30天/有群90天、按历史单号及创建时间的规则。

新事件、计划时间保存 UTC。圆通没有时区的节点按 Asia/Shanghai 解释。历史 signed_at、track_updated_at 和老业务表保留原字段与原时钟口径，不做推测性批量时区转换。列表区分 UTC 物流事件时间与历史本地查询时间。签收观察时间与事件时间分离；无时间节点不能用当前时间补成签收时间。

## 轨迹与异常

查询状态分开保存 OK / NO_NODES / BUSINESS_ERROR / PARSE_ERROR / HTTP_ERROR / QUERY_ERROR；失败或空结果保留上次可靠轨迹，保存最后响应或事件引用。生产真实结构包括数组及 map[运单号]。GOT、SIGNED、FAILED、TMS_RETURN 等码已经通过备份中真实响应校核；文字只作受控兜底。历史可疑签收输出人工核查清单，不清空 signed_at。

默认异常阈值：下单48小时无可靠揽收；在途72小时无新节点；代收24小时仍未客户确认。由 MAIL_NO_PICKUP_HOURS、MAIL_STALE_HOURS、MAIL_PROXY_CONFIRM_HOURS 配置。这是内部运营阈值，不是圆通时效承诺。拒收、退回、派送明确异常及客户反馈未收到暂停常规入批；解除须填写条件、备注并审计。附件只接受经文件签名检查的 PDF/PNG/JPEG，下载再查客户权限。补寄只创建待人工操作的草稿，聊天不下单。无揽收原单可由管理员在异常解除时明确核实并释放占用，留下审计，不伪造寄出或完成事实。

## AI 安全与配置

官方接口 https://api.openai.com/v1/responses；模型只从 OPENAI_MODEL 读取。OPENAI_API_KEY 仅保存服务端 .env。使用列级 SELECT 授权的独立 AI_DB_USER，禁止读取 password_hash、写业务表或访问其他数据库；服务端每次工具调用重新核验用户和客户范围。模型没有 SQL、文件或配置工具。新增 AI/计划编辑采用普通用户仅本人负责客户、管理员全部客户的保守范围；原共享线索池和普通批次入口保持既有可见性。自由文本脱敏，数据库文字视为不可信数据。

全站默认并发2（AI_MAX_CONCURRENT，最高3），每用户跨进程并发1、每分钟3次、工具最多4轮、每次50行、每运单20节点、上下文最大60000 UTF-8字节、单次输出1200 token、默认60秒超时。截断和错误明确返回；统计由数据库计算。每日默认预留预算5美元、每次最多预留1美元；失败也保留预留额，防止故障重试突破预算。每轮按 UTF-8字节输入token上界和最大输出token预估费用，执行前检查。AI_INPUT_USD_PER_MILLION 和 AI_OUTPUT_USD_PER_MILLION 必须配置为不低于对应模型价格的保守费率；本次验证配置10/100，比核实的 gpt-5.5 标准价5/30更保守。模型变更必须同时核实费率。

Responses 文档：https://developers.openai.com/api/docs/guides/function-calling
模型/费率：https://developers.openai.com/api/docs/models/gpt-5.5

会话隔离、CSRF、请求去重、服务端权限、文本化流输出防 XSS。AI 不可用只影响 AI 请求，其他页面不依赖 API。

## 迁移、验证和发布

必须先备份并在隔离数据库恢复验证，再显式运行：

```
node scripts/migrate-marketing.mjs <与DB_NAME完全一致的数据库名>
node scripts/materialize-mailing.mjs <同上>
node scripts/provision-ai-reader.mjs <同上>
```

禁止旧初始化脚本。新增表和字段向后兼容，迁移可重复；只有迁移脚本显式执行，不在服务启动时偷偷改表。materialize 根据历史 PushSucceeded 和原始节点补充独立事实、派生显示字段，不推进计划，不改历史 signed_at 或物流状态。MAIL_REVIEW_FILE 可指定核查清单路径。AI 账号创建脚本若发现同名账号会停止，不覆盖既有凭据。

备份目录：`C:\othello\backups\marketing-upgrade-20261112`，仅 Administrators/SYSTEM 访问。包含应用 archive、git bundle、原 .env、部署清单、uploads、完整数据库 SQL，以及恢复 INSERT 语句 SHA256 比对结果。数据库备份已恢复到独立验证库，734条 INSERT 语句内容 SHA256 完全一致。测试使用独立 `marketing_upgrade_restore_20261112`，绝不对生产写测试记录。测试环境圆通地址为本机不可用端口且 DISABLE_JOBS=1。

```
npm test
node scripts/browser-smoke.mjs
```

仅重启端口8899的 Marketing；不得重启 Company/IIS 或其他 Node。发布前再次校验工作树、PID/工作目录及基线SHA。原目录固定，uploads 不移动。使用确切提交 detached checkout，保存原配置，应用失败切回原 SHA 并恢复本次配置备份后只重启 Marketing。增量数据库保留，不回删新表或业务数据。部署操作记录、实际 SHA、进程快照及验证结果在私有备份目录。

定时任务：Europe/Berlin 每5分钟周期/异常扫描，圆通每2小时查询。数据库唯一键和命名锁控制多实例并发；进程重启后继续按计划版本和已有业务事件恢复。DISABLE_JOBS=1 用于隔离测试和一次性扫描命令。

样例 #4363 / YT2596636848330：生产保存的响应为 code=1001、success="true"、map 中该单号为空数组，message="查询结果为空。"；有 PushSucceeded 证据，没有该响应内的揽收、签收或客户确认依据。因此“查询无节点，寄出/收信未知”，不能认定未收到；未执行真实下单或补寄。
