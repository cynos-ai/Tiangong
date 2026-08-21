const MAX_RENDERED_MESSAGES = 1000;

const state = {
  session: null,
  csrfToken: null,
  rooms: [],
  room: null,
  members: new Map(),
  messages: new Map(),
  historyEnd: null,
  syncToken: null,
  facts: null,
  selectedWorkId: null,
  running: false,
  runtimeStream: null,
};

const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const workspace = $("#workspace");

function clear(node) { node.replaceChildren(); }
function text(tag, value, className) { const node = document.createElement(tag); if (className) node.className = className; node.textContent = value ?? ""; return node; }
function button(value, className, action) { const node = text("button", value, className); node.type = "button"; node.addEventListener("click", action); return node; }
function formatTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date) : "时间未知"; }
function formatAge(value) { if (!value) return "无"; const ms = Date.now() - Date.parse(value); if (!Number.isFinite(ms) || ms < 0) return formatTime(value); if (ms < 60_000) return "不到 1 分钟"; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`; if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时`; return `${Math.floor(ms / 86_400_000)} 天`; }
function errorLabel(code) {
  const labels = {
    WEB_SESSION_REQUIRED: "请重新登录 Matrix。",
    MATRIX_SESSION_REVOKED: "Matrix 会话已撤销，请重新登录。",
    MATRIX_ROOM_MEMBERSHIP_REVOKED: "你已不在这个 Team Room 中。",
    MATRIX_ENCRYPTED_ROOM_UNSUPPORTED: "第一版暂不支持加密 Room，未将其伪装为空对话。",
    MATRIX_UNAVAILABLE: "Matrix 暂时不可用，请稍后重试。",
    CSRF_INVALID: "当前操作已失效，请刷新会话。",
    ROOM_ROUTE_NOT_BOUND: "该 Room 未绑定到当前 Team。",
    WEB_SESSION_CAPACITY_EXCEEDED: "当前 Web 会话已达上限。",
  };
  return labels[code] ?? `请求未完成（${code || "UNKNOWN"}）`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.csrf ? { "x-tiangong-csrf": state.csrfToken } : {}), ...options.headers } });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `HTTP_${response.status}`);
    error.code = body.error;
    error.status = response.status;
    if (response.status === 401) showLogin(errorLabel(error.code));
    throw error;
  }
  return body;
}

function setConnection(label, kind = "") {
  const node = $("#connection-state");
  node.textContent = label;
  node.className = `connection-state ${kind}`.trim();
}

function showLogin(message = "") {
  state.running = false;
  state.runtimeStream?.close();
  state.runtimeStream = null;
  state.session = null;
  state.csrfToken = null;
  loginView.classList.remove("hidden");
  workspace.classList.add("hidden");
  $("#login-error").textContent = message;
}

async function enterWorkspace(session) {
  state.session = session;
  state.csrfToken = session.csrfToken;
  state.running = true;
  loginView.classList.add("hidden");
  workspace.classList.remove("hidden");
  $("#actor-id").textContent = session.actorId;
  setConnection("正在同步");
  await Promise.all([loadRooms(), loadRuntime()]);
  await loadHistory(false);
  startRuntimeStream();
  void syncLoop();
}

async function loadRooms() {
  const value = await api("/api/chat/rooms");
  state.rooms = value.rooms;
  state.room = value.rooms[0] ?? null;
  state.members = new Map((state.room?.members ?? []).map((member) => [member.userId, member]));
  $("#team-name").textContent = value.team?.teamId ?? "当前团队";
  renderRooms();
  if (state.room) {
    $("#room-title").textContent = state.room.name || state.room.roomId;
    $("#room-meta").textContent = `${state.room.members.length} 位成员 · ${state.room.roomId}`;
  }
}

function renderRooms() {
  const container = $("#room-list");
  clear(container);
  for (const room of state.rooms) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `room-button${room.roomId === state.room?.roomId ? " active" : ""}`;
    const avatar = text("span", (room.name || "#").slice(0, 1).toUpperCase(), "room-avatar");
    const copy = document.createElement("span");
    const roomId = text("span", room.roomId, "room-id"); roomId.title = room.roomId;
    copy.append(text("span", room.name || "Team Room", "room-name"), roomId);
    item.append(avatar, copy);
    item.addEventListener("click", () => { state.room = room; renderRooms(); });
    container.append(item);
  }
}

function addEvents(events, { prepend = false } = {}) {
  for (const event of events) state.messages.set(event.eventId, event);
  let capped = false;
  if (state.messages.size > MAX_RENDERED_MESSAGES) {
    capped = true;
    const ordered = [...state.messages.values()].sort((a, b) => (b.originServerTs - a.originServerTs) || String(b.eventId).localeCompare(String(a.eventId)));
    state.messages = new Map(ordered.slice(0, MAX_RENDERED_MESSAGES).map((event) => [event.eventId, event]));
    state.historyEnd = null;
    $("#load-older").classList.add("hidden");
    $("#history-state").textContent = `当前视图最多保留 ${MAX_RENDERED_MESSAGES} 条消息`;
  }
  renderMessages({ preserveScroll: prepend });
  return capped;
}

async function loadHistory(older) {
  if (!state.room) return;
  const list = $("#message-list");
  list.setAttribute("aria-busy", "true");
  $("#history-state").textContent = older ? "正在加载更早消息…" : "正在读取 Matrix 历史…";
  try {
    const query = new URLSearchParams({ limit: "50" });
    if (older && state.historyEnd) query.set("from", state.historyEnd);
    const value = await api(`/api/chat/rooms/${encodeURIComponent(state.room.roomId)}/messages?${query}`);
    state.historyEnd = value.end;
    const capped = addEvents(value.events, { prepend: older });
    $("#load-older").classList.toggle("hidden", capped || !state.historyEnd || value.events.length === 0);
    if (!capped) $("#history-state").textContent = value.events.length === 0 ? "没有更多消息" : "";
  } catch (error) {
    $("#history-state").textContent = errorLabel(error.code);
  } finally { list.setAttribute("aria-busy", "false"); }
}

function senderName(sender) { return state.members.get(sender)?.displayName || sender; }
function senderInitial(sender) { return senderName(sender).replace(/^@/u, "").slice(0, 1).toUpperCase(); }

function appendTextWithLinks(parent, value) {
  const urlPattern = /https?:\/\/[^\s<>{}\[\]"']+/gu;
  let offset = 0;
  for (const match of value.matchAll(urlPattern)) {
    if (match.index > offset) parent.append(document.createTextNode(value.slice(offset, match.index)));
    try {
      const parsed = new URL(match[0]);
      const link = text("a", match[0]);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      parent.append(link);
    } catch { parent.append(document.createTextNode(match[0])); }
    offset = match.index + match[0].length;
  }
  if (offset < value.length) parent.append(document.createTextNode(value.slice(offset)));
}

function renderBody(value) {
  const container = document.createElement("div");
  container.className = "message-body";
  const chunks = String(value).split("```");
  chunks.forEach((chunk, index) => {
    if (index % 2 === 1) container.append(text("pre", chunk.replace(/^\w+\n/u, "")));
    else if (chunk) { const paragraph = document.createElement("p"); appendTextWithLinks(paragraph, chunk); container.append(paragraph); }
  });
  return container;
}

function renderMessages({ preserveScroll = false } = {}) {
  const list = $("#message-list");
  const oldHeight = list.scrollHeight;
  const oldTop = list.scrollTop;
  clear(list);
  const events = [...state.messages.values()].sort((a, b) => (a.originServerTs - b.originServerTs) || String(a.eventId).localeCompare(String(b.eventId)));
  for (const event of events) {
    if (event.kind === "encrypted-unsupported" || event.kind === "unsupported-message") {
      const item = text("li", event.kind === "encrypted-unsupported" ? "此加密消息无法在第一版安全读取" : `暂不支持的 Matrix 消息类型：${event.msgtype}`, "system-message");
      list.append(item);
      continue;
    }
    const item = document.createElement("li");
    item.className = `message${event.local ? " local" : ""}${event.failed ? " failed" : ""}`;
    item.dataset.eventId = event.eventId;
    item.append(text("div", senderInitial(event.sender), "message-avatar"));
    const content = document.createElement("div");
    const head = document.createElement("div");
    head.className = "message-head";
    head.append(text("span", senderName(event.sender), "message-sender"), text("time", formatTime(event.originServerTs), "message-time"));
    if (event.local || event.failed) head.append(text("span", event.failed ? "发送失败" : "发送中", "message-state"));
    content.append(head);
    if (event.kind === "attachment") {
      const summary = `${event.body} · ${event.mimeType || "附件"}${event.size === null ? "" : ` · ${Math.ceil(event.size / 1024)} KB`}`;
      content.append(renderBody(summary));
    } else content.append(renderBody(event.body));
    item.append(content);
    list.append(item);
  }
  if (preserveScroll) list.scrollTop = list.scrollHeight - oldHeight + oldTop;
  else list.scrollTop = list.scrollHeight;
}

async function syncLoop() {
  while (state.running && state.room) {
    try {
      const query = state.syncToken ? `?since=${encodeURIComponent(state.syncToken)}` : "";
      const value = await api(`/api/chat/sync${query}`);
      state.syncToken = value.nextBatch;
      addEvents(value.events);
      setConnection("Matrix 已连接", "online");
    } catch (error) {
      if (!state.running || error.status === 401) return;
      setConnection("同步重试中", "error");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function loadRuntime() {
  try { renderFacts(await api("/api/runtime")); } catch (error) { if (error.status !== 401) setConnection("事实暂不可用", "error"); }
}

function startRuntimeStream() {
  state.runtimeStream?.close();
  const stream = new EventSource("/api/runtime/events");
  state.runtimeStream = stream;
  stream.addEventListener("runtime", (event) => { try { renderFacts(JSON.parse(event.data)); } catch { /* next source fact can recover */ } });
  stream.addEventListener("revoked", () => { stream.close(); showLogin("Matrix 身份或 Room 权限已撤销。"); });
  stream.onerror = () => { if (state.running) setConnection("事实流重连中", "error"); };
}

function latestAt(work) { return work.timeline?.at(-1)?.at ?? null; }
function statusLabel(value) { return ({ open: "进行中", completed: "已完成", stopped: "已停止", assigned: "等待 / 进行中", reported: "已报告", cancelled: "已取消", active: "工作中", waiting: "等待中", "requirement-pending": "需求待形成", "recovery-required": "需要恢复", success: "成功", failed: "失败", observed: "已观察" })[value] ?? value; }
function statusNode(value) { return text("span", statusLabel(value), `status-badge ${value}`); }
function refLabel(ref) { if (!ref) return "无"; return ref.repositoryId ? `${ref.repositoryId}@${ref.commitSha}` : `${ref.adapter}:${ref.ref}`; }

function renderFacts(facts) {
  state.facts = facts;
  const metrics = facts.admissionMetrics ?? {};
  $("#pending-count").textContent = String(metrics.pendingCount ?? 0);
  $("#oldest-pending").textContent = formatAge(metrics.oldestReceivedAt);
  $("#routing-error").textContent = metrics.lastErrorCode ?? "无";
  $("#backlog-dot").className = `status-dot ${metrics.lastErrorCode ? "error" : metrics.pendingCount ? "pending" : "clear"}`;
  const works = (facts.works ?? []).filter((work) => !state.room || work.roomId === state.room.roomId).sort((a, b) => String(latestAt(b)).localeCompare(String(latestAt(a))));
  if (state.selectedWorkId && !works.some((work) => work.workId === state.selectedWorkId)) state.selectedWorkId = null;
  if (!state.selectedWorkId && works.length) state.selectedWorkId = works[0].workId;
  renderWorkList(works);
  renderWorkDetail(works.find((work) => work.workId === state.selectedWorkId));
}

function renderWorkList(works) {
  $("#work-count").textContent = String(works.length);
  const container = $("#work-list");
  clear(container);
  for (const work of works) {
    const tasks = (state.facts.tasks ?? []).filter((task) => task.workId === work.workId);
    const active = tasks.filter((task) => task.status === "assigned").length;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `work-card${work.workId === state.selectedWorkId ? " active" : ""}`;
    const top = document.createElement("div"); top.className = "work-card-top";
    top.append(text("span", work.title || work.workId, "work-card-title"), statusNode(work.requirementState === "requirement-pending" ? "requirement-pending" : work.status));
    card.append(top, text("div", `${formatAge(latestAt(work))}前 · ${tasks.length} Tasks · ${active} 活跃 Agent`, "work-card-meta"));
    card.addEventListener("click", () => { state.selectedWorkId = work.workId; renderFacts(state.facts); });
    container.append(card);
  }
}

function factCard(label, value) { const card = document.createElement("div"); card.className = "fact-card"; card.append(text("div", label, "fact-label"), text("p", value)); return card; }
function listCard(label, values) { const card = document.createElement("div"); card.className = "fact-card"; card.append(text("div", label, "fact-label")); const list = document.createElement("ul"); list.className = "fact-list"; for (const value of values.length ? values : ["无"]) list.append(text("li", value)); card.append(list); return card; }

function renderWorkDetail(work) {
  $("#work-empty").classList.toggle("hidden", Boolean(work));
  $("#work-detail").classList.toggle("hidden", !work);
  if (!work) return;
  const status = $("#work-status"); status.textContent = statusLabel(work.status); status.className = `status-badge ${work.status}`;
  $("#work-epoch").textContent = `epoch ${work.epoch}`;
  $("#work-title").textContent = work.title || work.workId;
  $("#work-activity").textContent = `最近活动 ${formatTime(latestAt(work))} · ${work.workId}`;
  const trajectory = $("#work-trajectory");
  trajectory.classList.toggle("hidden", !work.trajectoryUrl);
  if (work.trajectoryUrl) trajectory.href = work.trajectoryUrl; else trajectory.removeAttribute("href");
  renderSpec(work);
  renderPlan(work);
  renderAgents(work);
  renderTasks(work);
  renderTools(work);
  renderTimeline(work);
}

function renderSpec(work) {
  const container = $("#work-spec"); clear(container);
  const spec = work.currentWorkSpec;
  $("#spec-revision").textContent = spec ? `revision ${spec.revision}` : "待形成";
  if (!spec) { container.append(factCard("需求状态", "需求待形成。Leader 尚未形成可执行 WorkSpec；这不是数据丢失。")); return; }
  container.append(factCard("目标", spec.goal || "未提供"), listCard("完成条件", spec.doneWhen), listCard("范围", spec.scope), listCard("约束", spec.constraints));
  if (spec.unresolvedAssumptions?.length) container.append(listCard("未解决假设", spec.unresolvedAssumptions));
}

function planRefs(work) {
  return work.timeline.filter((entry) => entry.type === "work-plan-changed" && entry.payload?.planRef).map((entry) => ({ ref: entry.payload.planRef, at: entry.at, reason: entry.payload.reason }));
}

function renderPlan(work) {
  const container = $("#plan-content"); clear(container);
  const history = planRefs(work);
  $("#plan-state").textContent = work.currentPlanRef ? `${history.length} 次发布` : "未发布";
  const current = document.createElement("div"); current.className = "plan-card";
  current.append(text("div", "当前 Plan", "fact-label"), text("p", refLabel(work.currentPlanRef), "ref")); container.append(current);
  if (history.length > 1) container.append(factCard("Plan Diff", `${refLabel(history.at(-2).ref)} → ${refLabel(history.at(-1).ref)}。内容差异只在有对应交付物时展示，不从模型描述伪造。`));
  else container.append(factCard("Plan Diff", "尚无两个已发布 Plan 引用可比较。"));
  const roleByMember = new Map((state.facts.agents ?? []).map((agent) => [agent.memberId, agent.responsibility]));
  const tasks = (state.facts.tasks ?? []).filter((task) => task.workId === work.workId);
  const currentLabel = refLabel(work.currentPlanRef);
  const candidates = tasks.filter((task) => roleByMember.get(task.assigneeMemberId) === "architect" && task.result).flatMap((task) => task.result.deliverableRefs.map((ref) => ({ ref, summary: task.result.summary }))).filter((item) => refLabel(item.ref) !== currentLabel);
  for (const candidate of candidates) { const card = document.createElement("div"); card.className = "plan-card"; card.append(text("div", "Architect 候选交付物", "fact-label"), text("p", refLabel(candidate.ref), "ref"), text("p", candidate.summary || "无 Result 摘要")); container.append(card); }
  const challenges = tasks.filter((task) => roleByMember.get(task.assigneeMemberId) === "challenger" && task.result);
  for (const challenge of challenges) container.append(factCard("Challenger Result", challenge.result.summary || "已提交，无摘要"));
}

function renderAgents(work) {
  const container = $("#agent-list"); clear(container);
  const workTasks = (state.facts.tasks ?? []).filter((task) => task.workId === work.workId);
  const taskMembers = new Set(workTasks.map((task) => task.assigneeMemberId));
  const agents = (state.facts.agents ?? []).filter((agent) => agent.responsibility === "leader" || taskMembers.has(agent.memberId));
  $("#agent-count").textContent = String(agents.length);
  for (const agent of agents) {
    const active = workTasks.filter((task) => task.assigneeMemberId === agent.memberId && task.status === "assigned");
    const card = document.createElement("div"); card.className = "agent-card";
    const row = document.createElement("div"); row.className = "card-title-row";
    row.append(text("span", agent.responsibility, "card-title"), statusNode(active.length ? "active" : "waiting"));
    card.append(row, text("div", `${agent.model || "model unknown"} · ${agent.agentPackageId || "package unknown"}@${agent.agentPackageVersion || "?"}`, "card-meta"));
    const used = agent.usedSkills.filter((skill) => !skill.taskId || workTasks.some((task) => task.taskId === skill.taskId));
    for (const skill of used) card.append(text("span", `${skill.skillId}@${skill.version || "?"}`, "skill-chip"));
    if (!used.length) card.append(text("div", "本 Work 暂无实际 Skill 使用记录", "card-meta"));
    container.append(card);
  }
}

function renderTasks(work) {
  const container = $("#task-list"); clear(container);
  const tasks = (state.facts.tasks ?? []).filter((task) => task.workId === work.workId);
  $("#task-count").textContent = String(tasks.length);
  if (!tasks.length) { container.append(factCard("Task", work.currentWorkSpec ? "尚未创建 Task" : "WorkSpec 形成前不会创建执行 Task")); return; }
  for (const task of tasks) {
    const card = document.createElement("div"); card.className = "task-card";
    const row = document.createElement("div"); row.className = "card-title-row";
    row.append(text("span", task.objective || task.taskId, "card-title"), statusNode(task.status));
    card.append(row, text("div", `${task.assigneeMemberId} · ${task.sessionRef || "Session 未观察"}`, "card-meta"));
    if (task.trajectoryUrl) {
      const link = text("a", "查看 Task 轨迹 ↗", "trajectory-link");
      link.href = task.trajectoryUrl; link.target = "_blank"; link.rel = "noreferrer noopener";
      card.append(link);
    }
    if (task.cancellation) card.append(text("div", task.cancellation.reason || "已取消", "result-block"));
    if (task.result) {
      const result = document.createElement("div"); result.className = "result-block";
      result.append(text("div", task.result.summary || "Result 已提交，无摘要"));
      for (const ref of task.result.deliverableRefs) result.append(text("div", refLabel(ref), "ref deliverable"));
      card.append(result);
    }
    container.append(card);
  }
}

function renderTools(work) {
  const container = $("#tool-list"); clear(container);
  const tools = (state.facts.toolResults ?? []).filter((tool) => tool.workId === work.workId);
  $("#tool-count").textContent = String(tools.length);
  if (!tools.length) { container.append(factCard("ToolResult", "没有观察到属于此 Work 的顶层工具事实。")); return; }
  for (const tool of tools) {
    const card = document.createElement("div"); card.className = "tool-card";
    const outcome = tool.resultSummary?.outcome || "observed";
    const row = document.createElement("div"); row.className = "card-title-row";
    row.append(text("span", tool.tool, "card-title"), statusNode(outcome));
    card.append(row, text("div", `${tool.actorId} · ${formatTime(tool.completedAt)} · ${tool.taskId || "Work scope"}`, "card-meta"));
    if (tool.outputRef) card.append(text("div", refLabel(tool.outputRef), "ref deliverable"));
    container.append(card);
  }
}

function renderTimeline(work) {
  const container = $("#timeline-list"); clear(container);
  $("#timeline-count").textContent = String(work.timeline.length);
  for (const entry of [...work.timeline].reverse()) {
    const item = document.createElement("li");
    item.append(text("div", entry.type || "unknown-fact", "timeline-type"));
    const details = [formatTime(entry.at), entry.actorId, entry.payload?.eventId || entry.payload?.source?.eventId, entry.payload?.reason].filter(Boolean).join(" · ");
    item.append(text("div", details, "timeline-meta"));
    container.append(item);
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const buttonNode = $("#login-button"); buttonNode.disabled = true; $("#login-error").textContent = "";
  const userId = $("#user-id").value.trim();
  const password = $("#password").value;
  try {
    const session = await api("/api/chat/login", { method: "POST", body: JSON.stringify({ userId, password }) });
    $("#password").value = "";
    await enterWorkspace(session);
  } catch (error) { $("#password").value = ""; $("#login-error").textContent = errorLabel(error.code); }
  finally { buttonNode.disabled = false; }
});

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/chat/logout", { method: "POST", body: JSON.stringify({}), csrf: true }); } catch { /* local UI still forgets the session */ }
  showLogin();
});

$("#load-older").addEventListener("click", () => void loadHistory(true));
$("#message-body").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("#message-body").value.trim();
  if (!body || !state.room || !state.session) return;
  const transactionId = `web-${crypto.randomUUID()}`;
  const localId = `local-${transactionId}`;
  state.messages.set(localId, { eventId: localId, sender: state.session.actorId, originServerTs: Date.now(), kind: "text", msgtype: "m.text", body, local: true });
  $("#message-body").value = ""; renderMessages(); $("#send-button").disabled = true; $("#chat-error").classList.add("hidden");
  try {
    const sent = await api(`/api/chat/rooms/${encodeURIComponent(state.room.roomId)}/messages`, { method: "POST", body: JSON.stringify({ body, clientTransactionId: transactionId }), csrf: true });
    state.messages.delete(localId);
    state.messages.set(sent.eventId, { eventId: sent.eventId, sender: sent.sender, originServerTs: Date.now(), kind: "text", msgtype: "m.text", body });
    renderMessages();
  } catch (error) {
    const local = state.messages.get(localId); if (local) { local.local = false; local.failed = true; }
    $("#chat-error").textContent = errorLabel(error.code); $("#chat-error").classList.remove("hidden"); renderMessages();
  } finally { $("#send-button").disabled = false; }
});

(async function start() {
  try {
    const session = await api("/api/chat/session");
    if (session.authenticated) await enterWorkspace(session); else showLogin();
  } catch (error) { showLogin(error.status === 404 ? "此部署尚未启用 Matrix Web 入口。" : errorLabel(error.code)); }
})();
