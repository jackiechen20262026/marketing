// controllers/auth.controller.js
import * as userService from "../services/user.service.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}

function redirectWithMsg(res, base, { success, error } = {}) {
  const qs = [];
  if (success) qs.push(`success=${encodeURIComponent(success)}`);
  if (error) qs.push(`error=${encodeURIComponent(error)}`);
  res.redirect(qs.length ? `${base}?${qs.join("&")}` : base);
}

export async function loginPage(req, res) {
  // 已登录直接进系统
  if (req.session?.user) return res.redirect("/portal/lead-pool");

  res.render("auth/login", {
    title: "登录",
    active: "",
    user: null,
    success: s(req.query.success),
    error: s(req.query.error),
  });
}

export async function login(req, res) {
  const username = s(req.body.username);
  const password = s(req.body.password);

  const user = await userService.verifyLogin(username, password);
  if (!user) {
    return redirectWithMsg(res, "/login", { error: "账号或密码错误，或账号已停用" });
  }

  req.session.user = user;
  return res.redirect("/portal/lead-pool");
}

export async function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.redirect("/login");
  });
}