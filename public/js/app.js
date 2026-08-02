import { apiRequest } from "./api.js";
import { renderDashboard } from "./render.js";

const $ = (selector) => document.querySelector(selector);
let state = { users: [], ips: [], audit: [], stats: {} };

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function showLogin() {
  $("#dashboard").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
}

function showDashboard() {
  $("#loginView").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
}

async function loadDashboard() {
  try {
    state = await apiRequest("/api/admin/overview");
    showDashboard();
    renderDashboard(state, $("#searchInput").value);
  } catch (error) {
    if (error.status === 401) showLogin();
    else showToast("加载失败，请稍后重试");
  }
}

function showNewKey(apiKey) {
  $("#newKey").textContent = apiKey;
  $("#keyDialog").showModal();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#loginError").textContent = "";
  const credentials = Object.fromEntries(new FormData(event.target));
  try {
    await apiRequest("/api/admin/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    event.target.reset();
    await loadDashboard();
  } catch (error) {
    $("#loginError").textContent =
      error.status === 429 ? "尝试次数过多，请稍后再试" : "账号或密码不正确";
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await apiRequest("/api/admin/logout", { method: "POST" });
  window.location.reload();
});

$("#newUserBtn").addEventListener("click", () => $("#userDialog").showModal());

$("#userForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = new FormData(event.target).get("name");
  try {
    const result = await apiRequest("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    $("#userDialog").close();
    event.target.reset();
    showNewKey(result.apiKey);
    await loadDashboard();
  } catch (error) {
    showToast(
      error.message === "duplicate_user" ? "用户名称已存在" : "创建失败",
    );
  }
});

$("#copyKey").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#newKey").textContent);
  showToast("API Key 已复制");
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $("#keyDialog").close());
});

$("#searchInput").addEventListener("input", (event) => {
  renderDashboard(state, event.target.value);
});

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.dataset.tab;
  if (!tab) return;
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button === event.target);
  });
  document.querySelectorAll(".tab-content").forEach((element) => {
    element.classList.add("hidden");
  });
  $(`#${tab}Tab`).classList.remove("hidden");
});

$("#userList").addEventListener("click", async (event) => {
  const expandButton = event.target.closest("[data-expand]");
  if (expandButton) {
    const details = expandButton
      .closest(".user-row")
      .querySelector(".ip-details");
    details.classList.toggle("hidden");
    expandButton.textContent = details.classList.contains("hidden") ? "⌄" : "⌃";
    return;
  }

  try {
    const removeButton = event.target.closest("[data-delete-ip]");
    if (removeButton && window.confirm("确定移除这个 IP？")) {
      await apiRequest(`/api/admin/ips/${removeButton.dataset.deleteIp}`, {
        method: "DELETE",
      });
      showToast("IP 已移除");
      await loadDashboard();
      return;
    }

    const toggleButton = event.target.closest("[data-toggle-user]");
    if (toggleButton) {
      await apiRequest(`/api/admin/users/${toggleButton.dataset.toggleUser}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: Boolean(Number(toggleButton.dataset.enabled)),
        }),
      });
      showToast("用户状态已更新");
      await loadDashboard();
      return;
    }

    const rotateButton = event.target.closest("[data-rotate]");
    if (rotateButton && window.confirm("旧 Key 将立即失效，确定轮换？")) {
      const result = await apiRequest(
        `/api/admin/users/${rotateButton.dataset.rotate}/rotate-key`,
        { method: "POST" },
      );
      showNewKey(result.apiKey);
      await loadDashboard();
    }
  } catch {
    showToast("操作失败，请刷新后重试");
  }
});

loadDashboard();
