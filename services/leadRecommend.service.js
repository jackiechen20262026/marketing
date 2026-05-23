function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function recommend({ lead, brands = [], timeline = [] }) {
  const suggestions = [];
  let score = 100;

  // 信息完整性
  const need = [];
  if (isEmpty(lead.contact_name)) need.push("联系人");
  if (isEmpty(lead.phone)) need.push("电话");
  if (isEmpty(lead.city)) need.push("城市");
  if (isEmpty(lead.street)) need.push("街道");
  if (isEmpty(lead.house_no)) need.push("门牌");
  if (isEmpty(lead.postal_code)) need.push("邮编");

  if (need.length) {
    score -= Math.min(40, need.length * 6);
    suggestions.push({
      type: "data",
      title: "建议补全收件信息",
      detail: `缺少：${need.join("、")}（否则推送圆通会失败）`,
      action: { label: "去编辑", href: `/portal/leads/${lead.id}/edit` },
    });
  }

  // 品牌为空
  if (!brands.length) {
    score -= 10;
    suggestions.push({
      type: "brand",
      title: "建议补充品牌信息",
      detail: "品牌用于后续话术/模板推荐与客户画像",
      action: { label: "去编辑", href: `/portal/leads/${lead.id}/edit` },
    });
  }

  // 跟进节奏（示例：阶段=已签收/跟进中/潜在客户，且7天无跟进）
  const followups = timeline.filter(x => x.type === "followup");
  const lastFollow = followups?.[0]?.at ? new Date(followups[0].at) : null;
  const now = new Date();
  const daysNoFollow = lastFollow ? Math.floor((now - lastFollow) / 86400000) : 999;

  const hotStages = new Set(["已签收", "跟进中", "潜在客户"]);
  if (hotStages.has(lead.workflow_stage) && daysNoFollow >= 7) {
    score -= 20;
    suggestions.push({
      type: "follow",
      title: "建议尽快跟进",
      detail: `该线索处于「${lead.workflow_stage}」，已 ${daysNoFollow} 天无跟进记录`,
      action: { label: "添加跟进", href: `/portal/leads/${lead.id}` },
    });
  }

  // 推荐下一步（进入批次）
  if (lead.workflow_stage === "已筛选" || lead.workflow_stage === "已导入") {
    suggestions.push({
      type: "batch",
      title: "推荐动作：加入批次寄送",
      detail: "可在「线索管理」勾选后创建批次并推送圆通",
      action: { label: "去线索管理", href: "/portal/leads/manage" },
    });
  }

  score = Math.max(0, Math.min(100, score));
  return { score, suggestions: suggestions.slice(0, 3) };
}

export default { recommend };
