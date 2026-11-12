import crypto from "node:crypto";
export function csrfToken(req, res, next) {
  if (req.session && !req.session.marketingCsrf)
    req.session.marketingCsrf = crypto.randomBytes(32).toString("hex");
  res.locals.marketingCsrf = req.session?.marketingCsrf || "";
  next();
}
export function csrfCheck(req, res, next) {
  const supplied = String(req.get("x-csrf-token") || req.body?._csrf || "");
  const expected = req.session?.marketingCsrf || "";
  if (
    !expected ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    return res.status(403).send("CSRF 校验失败，请刷新页面");
  next();
}
