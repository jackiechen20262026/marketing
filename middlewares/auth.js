// middlewares/auth.js

export function requireAuth(req, res, next) {
  const u = req.session?.user || null;
  if (!u) return res.redirect("/login");

  req.user = u;
  res.locals.user = u;
  next();
}

export function requireAdmin(req, res, next) {
  const u = req.session?.user || null;
  if (!u) return res.redirect("/login");

  const role = String(u.role || "").toLowerCase();
  if (role !== "admin") {
    return res.status(403).render("errors/500", {
      title: "无权限",
      error: new Error("需要管理员权限"),
      active: "",
      user: u,
    });
  }

  req.user = u;
  res.locals.user = u;
  next();
}