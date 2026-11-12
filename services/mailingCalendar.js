export const BUSINESS_ZONE = "Europe/Berlin";
export const TRACK_ZONE = "Asia/Shanghai";
const fmt = (zone) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
export function wallTime(date, zone = BUSINESS_ZONE) {
  return fmt(zone).format(new Date(date));
}
export function wallToUtc(value, zone = BUSINESS_ZONE) {
  const wall = String(value || "")
    .replace("T", " ")
    .slice(0, 19);
  const normalized = wall.length === 16 ? wall + ":00" : wall;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized))
    throw Error("日期时间格式不正确");
  const base = Date.parse(normalized.replace(" ", "T") + "Z");
  if (!Number.isFinite(base)) throw Error("无效时间");
  // Enumerate actual offsets; reject nonexistent spring times, choose earlier fall occurrence.
  const candidates = [];
  for (let h = -14; h <= 14; h++) {
    const d = new Date(base + h * 3600000);
    if (wallTime(d, zone) === normalized) candidates.push(d);
  }
  if (!candidates.length)
    throw Error("该本地时间不存在（夏令时跳时或无效日期），请选择其他时间");
  return candidates[0];
}
export function utcSql(date) {
  return new Date(date).toISOString().slice(0, 19).replace("T", " ");
}
export function fromUtcSql(s) {
  return new Date(String(s).replace(" ", "T") + "Z");
}
export function addNaturalMonths(date, months, zone = BUSINESS_ZONE) {
  if (!Number.isSafeInteger(months) || months < 1 || months > 1200)
    throw Error("周期月份须为 1–1200 的整数");
  const w = wallTime(date, zone),
    y = Number(w.slice(0, 4)),
    m = Number(w.slice(5, 7)),
    day = Number(w.slice(8, 10));
  const end = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  const target = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, end.getUTCDate())).padStart(2, "0")} ${w.slice(11)}`;
  try {
    return wallToUtc(target, zone);
  } catch {
    // Monthly recurrence falling in a spring gap advances by one hour.
    const shifted = new Date(
      Date.parse(target.replace(" ", "T") + "Z") + 3600000,
    )
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    return wallToUtc(shifted, zone);
  }
}
