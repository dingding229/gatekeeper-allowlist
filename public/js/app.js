import { apiRequest } from "./api.js";
import { renderDashboard, renderHistory } from "./render.js";

const $ = (selector) => document.querySelector(selector);
let state = {
  users: [],
  ips: [],
  devices: [],
  audit: [],
  settings: {},
  stats: {},
};
let historyUserId = null;

async function loadHistory(userId, search = "") {
  const query = new URLSearchParams({ limit: "200" });
  if (search.trim()) query.set("q", search.trim());
  const result = await apiRequest(
    `/api/admin/users/${userId}/history?${query.toString()}`,
  );
  $("#historyContent").innerHTML = renderHistory(result.history);
}

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

function showSurgeModule(result) {
  $("#surgeModuleUrl").textContent = result.moduleUrl;
  $("#openSurgeModule").href = result.installUrl;
  $("#surgeDialog").showModal();
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
  button.addEventListener("click", () => button.closest("dialog").close());
});

$("#copySurgeModule").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#surgeModuleUrl").textContent);
  showToast("Surge 模块地址已复制");
});

$("#searchInput").addEventListener("input", (event) => {
  renderDashboard(state, event.target.value);
});

$("#firewallForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await apiRequest("/api/admin/settings/firewall", {
      method: "PATCH",
      body: JSON.stringify({
        tcpPorts: $("#tcpPorts").value,
        udpPorts: $("#udpPorts").value,
      }),
    });
    state.settings = result.settings;
    renderDashboard(state, $("#searchInput").value);
    showToast("端口设置已保存，正在同步防火墙");
  } catch (error) {
    showToast(
      error.message === "invalid_port_ranges"
        ? "端口范围格式不正确"
        : "保存失败",
    );
  }
});

$("#refreshFirewallConfig").addEventListener("click", async () => {
  try {
    const result = await apiRequest("/api/admin/firewall-config");
    state.firewallConfig = result.firewallConfig;
    renderDashboard(state, $("#searchInput").value);
    showToast("防火墙配置已刷新");
  } catch {
    showToast("防火墙配置刷新失败");
  }
});

$("#apiRateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await apiRequest("/api/admin/settings/api-rate", {
      method: "PATCH",
      body: JSON.stringify({
        seconds: Number($("#apiRateLimitSeconds").value),
      }),
    });
    state.applicationSettings.apiRateLimitSeconds = result.apiRateLimitSeconds;
    showToast(`API 请求间隔已改为 ${result.apiRateLimitSeconds} 秒`);
  } catch {
    showToast("API 访问频率格式不正确");
  }
});

$("#retentionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await apiRequest("/api/admin/settings/retention", {
      method: "PATCH",
      body: JSON.stringify({
        historyDays: Number($("#historyRetentionDays").value),
        auditDays: Number($("#auditRetentionDays").value),
        deviceDays: Number($("#deviceRetentionDays").value),
      }),
    });
    state.retentionSettings = result.retentionSettings;
    showToast("数据保留策略已保存");
  } catch {
    showToast("保留天数必须在 7 到 3650 之间");
  }
});

$("#historySearch").addEventListener("input", async (event) => {
  if (!historyUserId) return;
  try {
    await loadHistory(historyUserId, event.target.value);
  } catch {
    $("#historyContent").innerHTML =
      '<div class="empty">历史记录搜索失败，请稍后重试</div>';
  }
});

$("#adminCredentialsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPassword = $("#newAdminPassword").value;
  if (newPassword !== $("#confirmAdminPassword").value) {
    showToast("两次输入的新密码不一致");
    return;
  }
  try {
    await apiRequest("/api/admin/settings/admin-credentials", {
      method: "PATCH",
      body: JSON.stringify({
        username: $("#adminUsername").value,
        currentPassword: $("#currentAdminPassword").value,
        newPassword,
      }),
    });
    window.alert("登录凭据已修改，请使用新账号密码重新登录。");
    window.location.reload();
  } catch (error) {
    showToast(
      error.message === "current_password_incorrect"
        ? "当前密码不正确"
        : "登录凭据修改失败",
    );
  }
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
    const removeDeviceButton = event.target.closest("[data-remove-device]");
    if (
      removeDeviceButton &&
      window.confirm("确定移除这台设备记录和限频状态？")
    ) {
      await apiRequest(
        `/api/admin/users/${removeDeviceButton.dataset.deviceUser}/devices/${removeDeviceButton.dataset.removeDevice}`,
        { method: "DELETE" },
      );
      showToast("设备已移除；再次上报时会重新登记");
      await loadDashboard();
      return;
    }

    const removeButton = event.target.closest("[data-delete-ip]");
    if (removeButton && window.confirm("确定移除这个网段？")) {
      await apiRequest(`/api/admin/ips/${removeButton.dataset.deleteIp}`, {
        method: "DELETE",
      });
      showToast("网段已移除");
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

    const limitButton = event.target.closest("[data-save-limit]");
    if (limitButton) {
      const input = document.querySelector(
        `[data-limit-input="${limitButton.dataset.saveLimit}"]`,
      );
      const ipLimit = Number(input.value);
      const result = await apiRequest(
        `/api/admin/users/${limitButton.dataset.saveLimit}`,
        { method: "PATCH", body: JSON.stringify({ ipLimit }) },
      );
      showToast(
        result.evicted.length
          ? `配额已保存，并淘汰 ${result.evicted.length} 个旧网段`
          : "用户网段配额已保存",
      );
      await loadDashboard();
      return;
    }

    const deviceLimitButton = event.target.closest("[data-save-device-limit]");
    if (deviceLimitButton) {
      const input = document.querySelector(
        `[data-device-limit-input="${deviceLimitButton.dataset.saveDeviceLimit}"]`,
      );
      const result = await apiRequest(
        `/api/admin/users/${deviceLimitButton.dataset.saveDeviceLimit}`,
        {
          method: "PATCH",
          body: JSON.stringify({ deviceLimit: Number(input.value) }),
        },
      );
      showToast(
        result.evictedDevices?.length
          ? `设备配额已保存，并移除 ${result.evictedDevices.length} 台旧设备`
          : "设备数量配额已保存",
      );
      await loadDashboard();
      return;
    }

    const clearButton = event.target.closest("[data-clear-ips]");
    if (
      clearButton &&
      window.confirm("确定清空该用户当前放行的全部网段？历史记录会保留。")
    ) {
      const result = await apiRequest(
        `/api/admin/users/${clearButton.dataset.clearIps}/ips`,
        { method: "DELETE" },
      );
      showToast(`已清空 ${result.removed} 个网段`);
      await loadDashboard();
      return;
    }

    const deleteUserButton = event.target.closest("[data-delete-user]");
    if (
      deleteUserButton &&
      window.confirm(
        "确定永久删除该用户？其当前网段和全部历史记录也会被删除，此操作不可撤销。",
      )
    ) {
      await apiRequest(
        `/api/admin/users/${deleteUserButton.dataset.deleteUser}`,
        { method: "DELETE" },
      );
      showToast("用户已删除");
      await loadDashboard();
      return;
    }

    const historyButton = event.target.closest("[data-history]");
    if (historyButton) {
      const user = state.users.find(
        (item) => item.id === Number(historyButton.dataset.history),
      );
      historyUserId = Number(historyButton.dataset.history);
      $("#historyTitle").textContent = `${user?.name || "用户"} · 历史 IP`;
      $("#historySearch").value = "";
      $("#historyContent").innerHTML = '<div class="empty">正在加载…</div>';
      $("#historyDialog").showModal();
      await loadHistory(historyUserId);
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
      return;
    }

    const surgeButton = event.target.closest("[data-surge]");
    if (surgeButton) {
      const result = await apiRequest(
        `/api/admin/users/${surgeButton.dataset.surge}/surge-module`,
      );
      showSurgeModule(result);
      return;
    }

    const rotateSurgeButton = event.target.closest("[data-rotate-surge]");
    if (
      rotateSurgeButton &&
      window.confirm("所有使用旧地址安装的 Surge 模块将立即失效，确定继续？")
    ) {
      const result = await apiRequest(
        `/api/admin/users/${rotateSurgeButton.dataset.rotateSurge}/rotate-surge-token`,
        { method: "POST" },
      );
      showSurgeModule(result);
      showToast("旧 Surge 地址已撤销，请安装新地址");
    }
  } catch {
    showToast("操作失败，请刷新后重试");
  }
});

async function submitRuleForm(event, path) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try {
    await apiRequest(path, { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    if (event.target.id === "whitelistNetworkForm") {
      $("#whitelistUser").disabled = true;
    }
    showToast("规则已保存，正在同步防火墙");
    await loadDashboard();
  } catch (error) {
    showToast(
      error.message === "network_blacklisted"
        ? "该 IP 所在网段已被拉黑"
        : "规则保存失败",
    );
  }
}

$("#blacklistForm").addEventListener("submit", (event) =>
  submitRuleForm(event, "/api/admin/network-rules/blacklist"),
);
$("#whitelistNetworkForm").addEventListener("submit", (event) =>
  submitRuleForm(event, "/api/admin/network-rules/whitelist"),
);
$("#whitelistScope").addEventListener("change", (event) => {
  $("#whitelistUser").disabled = event.target.value !== "user";
});
$("#permanentForm").addEventListener("submit", (event) =>
  submitRuleForm(event, "/api/admin/network-rules/permanent"),
);
$("#rulesTab").addEventListener("click", async (event) => {
  const unblock = event.target.closest("[data-unblock]");
  const permanent = event.target.closest("[data-remove-permanent]");
  const globalNetwork = event.target.closest("[data-remove-global-network]");
  if (!unblock && !permanent && !globalNetwork) return;
  if (!window.confirm("确定移除这条规则？")) return;
  const path = unblock
    ? `/api/admin/network-rules/blacklist/${unblock.dataset.unblock}`
    : permanent
      ? `/api/admin/network-rules/permanent/${permanent.dataset.removePermanent}`
      : `/api/admin/network-rules/whitelist/global/${globalNetwork.dataset.removeGlobalNetwork}`;
  try {
    await apiRequest(path, { method: "DELETE" });
    showToast("规则已移除");
    await loadDashboard();
  } catch {
    showToast("操作失败");
  }
});

loadDashboard();
