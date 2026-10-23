const labels = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  implemented: "Implemented",
  verified: "Accepted / verified",
  deferred: "Deferred",
  unreviewed: "Not audited",
};
const $ = (selector) => document.querySelector(selector);
let data;
let etag;
let activeLane = 0;
let editingId;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function option(value, text) {
  const node = element("option", text);
  node.value = value;
  return node;
}

function notice(text, error = false) {
  $("#message").textContent = text;
  $("#message").className = error ? "error" : "";
}

async function load() {
  const response = await fetch("/api/tasks");
  if (!response.ok) throw new Error((await response.json()).error);
  data = await response.json();
  etag = response.headers.get("ETag");
  $("#add").disabled = false;
  render();
}

function renderNavigation() {
  const nav = $("#lanes");
  nav.replaceChildren();
  for (const lane of [{ id: 0, name: "All lanes" }, ...data.lanes]) {
    const count = data.tasks.filter((task) => !lane.id || task.lane === lane.id).length;
    const button = element("button", lane.id ? `L${lane.id} · ${lane.name}` : lane.name);
    button.className = activeLane === lane.id ? "active" : "";
    button.setAttribute("aria-pressed", String(activeLane === lane.id));
    button.append(element("span", String(count)));
    button.onclick = () => {
      activeLane = lane.id;
      render();
    };
    nav.append(button);
  }
}

function renderMetrics(tasks) {
  const metrics = $("#metrics");
  metrics.replaceChildren();
  for (const [label, count] of [
    ["Tasks", tasks.length],
    [
      "Needs work",
      tasks.filter((task) => ["todo", "in_progress", "blocked"].includes(task.status)).length,
    ],
    ["Implemented", tasks.filter((task) => task.status === "implemented").length],
    ["Accepted", tasks.filter((task) => task.status === "verified").length],
    ["Not audited", tasks.filter((task) => task.status === "unreviewed").length],
  ]) {
    const metric = element("div", undefined, "metric");
    metric.append(element("strong", String(count)), element("span", label));
    metrics.append(metric);
  }
}

function taskCard(task) {
  const card = element("article", undefined, `task ${task.priority.toLowerCase()}`);
  const top = element("div", undefined, "task-top");
  const content = element("div");
  const meta = element("div", undefined, "meta");
  meta.append(
    element("span", `L${task.lane}`),
    element("span", task.taskIds || task.id),
    element("span", task.priority),
    element("span", labels[task.status], `badge ${task.status}`),
  );
  content.append(meta, element("h2", task.title), element("p", task.details));
  const edit = element("button", "Edit", "quiet");
  edit.onclick = () => openEditor(task);
  top.append(content, edit);
  card.append(top);
  if (task.blocker) card.append(element("p", `Dependency: ${task.blocker}`, "blocker"));
  const details = element("details");
  details.append(element("summary", `Acceptance & evidence · ${task.owner || "Unassigned"}`));
  for (const [label, text] of [
    ["Acceptance", task.acceptance],
    ["Evidence", task.evidence],
    ["Last edited", task.updatedAt || data.updatedAt],
  ]) {
    details.append(element("p", label, "detail-label"), element("p", text || "Not recorded yet."));
  }
  card.append(details);
  return card;
}

function render() {
  renderNavigation();
  const lane = data.lanes.find((item) => item.id === activeLane);
  $("#heading").textContent = lane ? `Lane ${lane.id} / ${lane.name}` : "Five lanes. One build.";
  $("#context").textContent = lane ? lane.audit : `Base branch / ${data.baseBranch}`;
  $("#summary").textContent =
    lane?.summary ||
    "Track implementation, acceptance, and blockers independently. Select a lane to focus.";
  const tasks = data.tasks.filter((task) => !activeLane || task.lane === activeLane);
  renderMetrics(tasks);
  const query = $("#search").value.toLowerCase();
  const status = $("#status").value;
  const visible = tasks.filter(
    (task) =>
      (!status || task.status === status) &&
      [task.title, task.taskIds, task.details, task.blocker]
        .join(" ")
        .toLowerCase()
        .includes(query),
  );
  const ordered = visible.toSorted(
    (a, b) => a.priority.localeCompare(b.priority) || a.lane - b.lane,
  );
  $("#tasks").replaceChildren(...ordered.map(taskCard));
  if (!visible.length)
    $("#tasks").append(element("p", "No matching tasks. Clear filters or add a task.", "empty"));
  $("#footer").textContent =
    `Saved ${data.updatedAt} · Audit baseline ${data.baselineSha} · ` +
    "File: docs/lane-tracker/tasks.json · Changes are local until committed through a PR.";
}

function openEditor(task) {
  editingId = task?.id;
  const fields = $("#form").elements;
  $("#editor-title").textContent = task ? "Edit task" : "Add task";
  const values = task || { lane: activeLane || 2, status: "todo", priority: "P2" };
  for (const name of [
    "title",
    "lane",
    "status",
    "priority",
    "taskIds",
    "owner",
    "details",
    "acceptance",
    "blocker",
    "evidence",
  ])
    fields.namedItem(name).value = values[name] ?? "";
  $("#form-error").textContent = "";
  $("#refresh-base").hidden = true;
  $("#editor").showModal();
}

async function save(event) {
  event.preventDefault();
  $("#save").disabled = true;
  const values = Object.fromEntries(new FormData($("#form")));
  const task = {
    ...values,
    lane: Number(values.lane),
    id: editingId || crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  const next = structuredClone(data);
  const index = next.tasks.findIndex((item) => item.id === task.id);
  if (index < 0) next.tasks.push(task);
  else next.tasks[index] = task;
  try {
    const response = await fetch("/api/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(next),
    });
    const result = await response.json();
    if (!response.ok) {
      $("#refresh-base").hidden = response.status !== 409;
      throw new Error(result.error);
    }
    data = result;
    etag = response.headers.get("ETag");
    $("#editor").close();
    render();
    notice("Saved to tasks.json. Commit the file to share this update.");
  } catch (error) {
    $("#form-error").textContent = error.message;
  } finally {
    $("#save").disabled = false;
  }
}

for (const [value, text] of Object.entries(labels)) {
  $("#status").append(option(value, text));
  $("#form").elements.namedItem("status").append(option(value, text));
}
for (const lane of [1, 2, 3, 4, 5]) {
  $("#form")
    .elements.namedItem("lane")
    .append(option(String(lane), `Lane ${lane}`));
}
$("#add").disabled = true;
$("#add").onclick = () => openEditor();
$("#cancel").onclick = () => $("#editor").close();
$("#form").onsubmit = save;
$("#search").oninput = render;
$("#status").onchange = render;
$("#reload").onclick = () =>
  load()
    .then(() => notice("Latest tasks loaded."))
    .catch((error) => notice(error.message, true));
$("#refresh-base").onclick = () =>
  load()
    .then(() => {
      $("#form-error").textContent =
        "Latest tasks loaded; your draft is unchanged. Save to apply it.";
      $("#refresh-base").hidden = true;
    })
    .catch((error) => {
      $("#form-error").textContent = error.message;
    });
$("#export").onclick = () => {
  if (!data) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = element("a");
  link.href = url;
  link.download = "czar-lane-tasks.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
load().catch((error) => notice(error.message, true));
