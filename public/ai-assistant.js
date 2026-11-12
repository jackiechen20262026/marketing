(() => {
  "use strict";
  const $ = (id) => document.getElementById("ai-" + id),
    csrf = $("app").dataset.csrf;
  let session = null,
    controller = null,
    last = "";
  const json = async (url, options = {}) => {
    const r = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        ...options.headers,
      },
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "请求失败");
    return data;
  };
  function message(role, text) {
    const node = document.createElement("p");
    node.textContent = (role === "user" ? "你：" : "助手：") + text;
    $("messages").append(node);
    return node;
  }
  async function sessions() {
    $("sessions").replaceChildren();
    for (const s of await json("/portal/ai-assistant/sessions")) {
      const b = document.createElement("button");
      b.textContent = s.title;
      b.onclick = async () => {
        if (controller) return;
        session = s.id;
        $("messages").replaceChildren();
        for (const m of await json("/portal/ai-assistant/sessions/" + session))
          message(m.role, m.content);
      };
      $("sessions").append(b);
    }
  }
  async function send(text) {
    if (controller || !text.trim()) return;
    last = text;
    controller = new AbortController();
    $("send").disabled = true;
    $("status").textContent = "查询中…";
    $("evidence").replaceChildren();
    try {
      if (!session) {
        const s = await json("/portal/ai-assistant/sessions", {
          method: "POST",
          body: JSON.stringify({ title: text.slice(0, 100) }),
        });
        session = s.id;
        await sessions();
      }
      message("user", text);
      const output = message("assistant", "");
      $("input").value = "";
      const r = await fetch(
        "/portal/ai-assistant/sessions/" + session + "/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({
            message: text,
            requestKey: crypto.randomUUID(),
            leadIds: $("leads")
              .value.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map(Number),
            dateFrom: $("from").value,
            dateTo: $("to").value,
          }),
          signal: controller.signal,
        },
      );
      if (!r.ok) throw Error("请求失败 " + r.status);
      const reader = r.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        failed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = block.match(/^event: (.*)$/m)?.[1],
            data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] || "{}");
          if (event === "delta") output.textContent += data.text;
          if (event === "evidence") {
            const p = document.createElement("p");
            p.textContent =
              "依据：" +
              data.tool +
              "，更新于 " +
              data.asOf +
              (data.truncated ? "（已截断，非全量）" : "");
            $("evidence").append(p);
          }
          if (event === "error") {
            failed = true;
            $("status").textContent = "失败：" + data.message;
          }
          if (event === "done")
            $("status").textContent = "已完成 · " + data.model;
        }
      }
      if (!failed && $("status").textContent === "查询中…")
        $("status").textContent = "连接已结束；回答可能不完整";
    } catch (e) {
      $("status").textContent =
        e.name === "AbortError" ? "已取消" : "失败：" + e.message;
    } finally {
      controller = null;
      $("send").disabled = false;
    }
  }
  $("form").onsubmit = (e) => {
    e.preventDefault();
    send($("input").value);
  };
  $("cancel").onclick = () => controller?.abort();
  $("retry").onclick = () => send(last);
  $("new").onclick = () => {
    if (controller) return;
    session = null;
    $("messages").replaceChildren();
  };
  sessions().catch((e) => ($("status").textContent = e.message));
})();
