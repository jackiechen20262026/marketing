// controllers/user.controller.js
import * as userService from "../services/user.service.js";

function s(v) {
  return String(v == null ? "" : v).trim();
}
function n(v, def = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}
function redirectWithMsg(res, base, { success, error } = {}) {
  const qs = [];
  if (success) qs.push(`success=${encodeURIComponent(success)}`);
  if (error) qs.push(`error=${encodeURIComponent(error)}`);
  res.redirect(qs.length ? `${base}?${qs.join("&")}` : base);
}

// GET /portal/users
export async function index(req, res) {
  const keyword = s(req.query.keyword);
  const role = s(req.query.role).toLowerCase();      // admin/user
  const status = s(req.query.status).toLowerCase();  // active/disabled
  const page = Math.max(1, n(req.query.page, 1));

  const { rows, pagination } = await userService.listUsers({
    keyword,
    role: role === "admin" || role === "user" ? role : "",
    status: status === "active" || status === "disabled" ? status : "",
    page,
    pageSize: 20,
  });

  const mapped = rows.map((u) => ({
    ...u,
    role_ui: u.role === "Admin" ? "Admin" : "User",
    status_ui: Number(u.status) === 1 ? "Active" : "Disabled",
  }));

  res.render("portal/users/index", {
    title: "用户管理",
    active: "users",
    user: req.session?.user || null,
    success: s(req.query.success),
    error: s(req.query.error),
    filters: {
      keyword,
      role: role === "admin" || role === "user" ? role : "",
      status: status === "active" || status === "disabled" ? status : "",
    },
    rows: mapped,
    pagination,
  });
}

// GET /portal/users/new
export async function newPage(req, res) {
  res.render("portal/users/form", {
    title: "新建用户",
    active: "users",
    user: req.session?.user || null,
    success: "",
    error: "",
    mode: "create",
    form: {
      username: "",
      name: "",
      role: "user",
      status: "active",
    },
  });
}

// POST /portal/users
export async function create(req, res) {
  try {
    const username = s(req.body.username);
    const name = s(req.body.name);
    const password = s(req.body.password);
    const role = s(req.body.role).toLowerCase();       // admin/user
    const status = s(req.body.status).toLowerCase();   // active/disabled

    await userService.createUser({
      username,
      name,
      password,
      role: role === "admin" ? "admin" : "user",
      status: status === "disabled" ? "disabled" : "active",
    });

    return redirectWithMsg(res, "/portal/users", { success: "Created" });
  } catch (e) {
    return res.status(400).render("portal/users/form", {
      title: "新建用户",
      active: "users",
      user: req.session?.user || null,
      success: "",
      error: e?.message || "创建失败",
      mode: "create",
      form: {
        username: s(req.body.username),
        name: s(req.body.name),
        role: s(req.body.role).toLowerCase() === "admin" ? "admin" : "user",
        status: s(req.body.status).toLowerCase() === "disabled" ? "disabled" : "active",
      },
    });
  }
}

// GET /portal/users/:id/edit
export async function editPage(req, res) {
  const id = req.params.id;
  const u = await userService.getUserById(id);
  if (!u) return redirectWithMsg(res, "/portal/users", { error: "Not Found" });

  res.render("portal/users/form", {
    title: "编辑用户",
    active: "users",
    user: req.session?.user || null,
    success: s(req.query.success),
    error: s(req.query.error),
    mode: "edit",
    form: {
      id: u.id,
      username: u.username,
      name: u.name || "",
      role: u.role === "Admin" ? "admin" : "user",
      status: Number(u.status) === 1 ? "active" : "disabled",
    },
  });
}

// POST /portal/users/:id
export async function update(req, res) {
  const id = req.params.id;
  try {
    const name = s(req.body.name);
    const role = s(req.body.role).toLowerCase();
    const status = s(req.body.status).toLowerCase();

    await userService.updateUser(id, {
      name,
      role: role === "admin" ? "admin" : "user",
      status: status === "disabled" ? "disabled" : "active",
    });

    return redirectWithMsg(res, `/portal/users/${id}/edit`, { success: "Saved" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/users/${id}/edit`, {
      error: e?.message || "保存失败",
    });
  }
}

// POST /portal/users/:id/reset-password
export async function resetPassword(req, res) {
  const id = req.params.id;
  const pw = s(req.body.newPassword);

  try {
    await userService.resetPassword(id, pw);
    return redirectWithMsg(res, `/portal/users/${id}/edit`, { success: "Password reset" });
  } catch (e) {
    return redirectWithMsg(res, `/portal/users/${id}/edit`, {
      error: e?.message || "重置失败",
    });
  }
}

// ✅ POST /portal/users/:id/toggle-status
export async function toggleStatus(req, res) {
  const id = req.params.id;

  // 保留筛选与分页，切换后回到原列表状态
  const keyword = s(req.query.keyword);
  const role = s(req.query.role);
  const status = s(req.query.status);
  const page = s(req.query.page);

  const backQs = [];
  if (keyword) backQs.push(`keyword=${encodeURIComponent(keyword)}`);
  if (role) backQs.push(`role=${encodeURIComponent(role)}`);
  if (status) backQs.push(`status=${encodeURIComponent(status)}`);
  if (page) backQs.push(`page=${encodeURIComponent(page)}`);

  const back = `/portal/users${backQs.length ? `?${backQs.join("&")}` : ""}`;

  try {
    await userService.toggleUserStatus(id);
    return redirectWithMsg(res, back, { success: "Status updated" });
  } catch (e) {
    return redirectWithMsg(res, back, { error: e?.message || "更新失败" });
  }
}