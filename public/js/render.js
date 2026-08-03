import { escapeHtml, formatTime } from "./format.js";

const actionNames = {
  "user.created": "创建用户",
  "user.status": "用户状态",
  "key.rotated": "轮换密钥",
  "ip.added": "添加网段",
  "ip.seen": "网段再次上报",
  "ip.evicted": "自动淘汰",
  "ip.removed": "手动移除",
  "ip.cleared": "清空用户网段",
  "user.limit": "调整网段配额",
  "settings.updated": "更新端口设置",
  "settings.api_rate": "更新 API 频率",
  "admin.credentials": "修改后台凭据",
  "user.deleted": "删除用户",
  "network.blocked": "拉黑网段",
  "network.unblocked": "解除拉黑",
  "permanent.added": "永久放行",
  "permanent.removed": "移除永久放行",
  "global_network.added": "添加全局网段",
  "global_network.removed": "移除全局网段",
  "device.removed": "移除设备",
  "device.evicted": "自动淘汰设备",
  "user.device_limit": "调整设备配额",
  "surge.rotated": "撤销 Surge 模块",
  "settings.retention": "更新数据保留策略",
};

const locationText = (ip) =>
  [ip.country, ip.region, ip.city].filter(Boolean).join(" · ") ||
  "尚无地区信息，等待 Surge 下次成功查询";

const formatRuleList = (values, empty = "无") =>
  values?.length
    ? values
        .map((value) => `<code>${escapeHtml(String(value))}</code>`)
        .join(" ")
    : `<span class="muted">${empty}</span>`;

function renderFirewallConfig(config) {
  const status = config?.status || {};
  const statusText =
    status.success && !status.stale ? "已应用" : "待同步 / 异常";
  const statusClass =
    status.success && !status.stale ? "config-ok" : "config-warn";
  return `
    <div class="config-status ${statusClass}"><strong>${statusText}</strong>
      <span>配置 revision ${config?.revision ?? 0} · 已应用 ${status.appliedRevision ?? 0}</span>
      ${status.error ? `<small>${escapeHtml(status.error)}</small>` : ""}
    </div>
    <dl class="firewall-config-grid">
      <div><dt>TCP 保护端口</dt><dd>${formatRuleList(config?.tcpPorts)}</dd></div>
      <div><dt>UDP 保护端口</dt><dd>${formatRuleList(config?.udpPorts)}</dd></div>
      <div><dt>生效 IPv4 白名单（${config?.ipv4?.length || 0}）</dt><dd>${formatRuleList(config?.ipv4)}</dd></div>
      <div><dt>生效 IPv6 白名单（${config?.ipv6?.length || 0}）</dt><dd>${formatRuleList(config?.ipv6)}</dd></div>
      <div><dt>最近同步</dt><dd>${status.appliedAt ? escapeHtml(formatTime(status.appliedAt)) : "尚无同步记录"}</dd></div>
      <div><dt>服务端生成</dt><dd>${config?.generatedAt ? escapeHtml(formatTime(config.generatedAt)) : "—"}</dd></div>
    </dl>`;
}

const renderRuleRow = (value, detail, action, attribute, label = "移除") =>
  `<div class="rule-row"><div><code>${escapeHtml(value)}</code><small>${escapeHtml(detail)}</small></div><button class="danger-link" ${attribute}="${escapeHtml(String(action))}">${label}</button></div>`;

function renderIpRows(ips) {
  if (!ips.length)
    return '<tr><td colspan="4"><small>尚未添加网段</small></td></tr>';

  return ips
    .map(
      (ip, index) => `
    <tr>
      <td><span class="slot">${index + 1}</span></td>
      <td>
        <code>${escapeHtml(ip.ip)}</code><br>
        <small>IPv${ip.family} · ${escapeHtml(ip.source)} · 上报 IP ${escapeHtml(ip.observed_ip || "—")}</small><br>
        <small>${escapeHtml(locationText(ip))}${ip.isp ? ` · ${escapeHtml(ip.isp)}` : ""}${ip.geo_source ? ` · ${escapeHtml(ip.geo_source)}` : ""}</small>
      </td>
      <td>
        <small>
          加入 ${formatTime(ip.created_at)}<br>
          最近 ${formatTime(ip.last_seen_at)}
        </small>
      </td>
      <td><button class="danger-link" data-delete-ip="${ip.id}">移除</button></td>
    </tr>
  `,
    )
    .join("");
}

function renderDevices(devices, userId) {
  if (!devices.length) return '<div class="empty">尚未识别到设备</div>';
  return `<table class="ip-table device-table"><tbody>${devices
    .map(
      (device, index) => `<tr>
        <td><span class="slot">${index + 1}</span></td>
        <td>
          <code>${escapeHtml(device.name)}</code><br>
          <small>设备 · ${escapeHtml(device.source)} · 上报 IP ${escapeHtml(device.last_ip || "—")}</small><br>
          <small>ID <code class="device-id">${escapeHtml(device.device_key)}</code></small>
        </td>
        <td>
          <small>
            加入 ${formatTime(device.first_seen_at)}<br>
            最近 ${formatTime(device.last_seen_at)}
          </small>
        </td>
        <td><button class="danger-link" data-remove-device="${device.id}" data-device-user="${userId}">移除</button></td>
      </tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderUser(user, allIps, allDevices) {
  const ips = allIps
    .filter((ip) => ip.user_id === user.id)
    .sort(
      (left, right) => new Date(left.created_at) - new Date(right.created_at),
    );
  const devices = (allDevices || []).filter(
    (device) => device.user_id === user.id,
  );

  return `
    <article class="user-row" data-user="${user.id}">
      <div class="user-summary">
        <div class="identity">
          <span class="avatar">${escapeHtml(user.name.slice(0, 1).toUpperCase())}</span>
          <div>
            <strong>${escapeHtml(user.name)}</strong>
            <small>${user.ip_count}/${user.ip_limit} 个网段槽位</small>
          </div>
        </div>
        <div class="key-prefix">Key&nbsp; <code>${escapeHtml(user.key_prefix)}••••••</code></div>
        <span class="badge ${user.enabled ? "" : "off"}">
          ${user.enabled ? "已启用" : "已停用"}
        </span>
        <span class="last-seen">${formatTime(user.last_seen_at)}</span>
        <button class="chevron" data-expand aria-label="展开用户详情">⌄</button>
      </div>
      <div class="ip-details hidden">
        <h3>已放行网段（${ips.length}/${user.ip_limit}）</h3>
        <table class="ip-table"><tbody>${renderIpRows(ips)}</tbody></table>
        <h3>已识别设备（${devices.length}/${user.device_limit}）</h3>
        ${renderDevices(devices, user.id)}
        <div class="row-actions">
          <label class="limit-control">网段配额
            <input type="number" min="1" max="100" value="${user.ip_limit}" data-limit-input="${user.id}">
          </label>
          <label class="limit-control">设备配额
            <input type="number" min="1" max="100" value="${user.device_limit}" data-device-limit-input="${user.id}">
          </label>
          <button class="ghost" data-save-quota="${user.id}">保存配额</button>
          <button class="ghost" data-toggle-user="${user.id}" data-enabled="${user.enabled ? 0 : 1}">
            ${user.enabled ? "停用用户" : "重新启用"}
          </button>
          <button class="ghost" data-rotate="${user.id}">轮换 API Key</button>
          <button class="ghost" data-surge="${user.id}">Surge 安装地址</button>
          <button class="ghost" data-rotate-surge="${user.id}">撤销旧 Surge 地址</button>
          <button class="ghost" data-history="${user.id}">历史 IP</button>
          <button class="danger-outline" data-clear-ips="${user.id}">清空网段</button>
          <button class="danger-outline" data-delete-user="${user.id}">删除用户</button>
        </div>
      </div>
    </article>
  `;
}

export function renderDashboard(state, query = "") {
  document.querySelector("#serverVersion").textContent =
    `v${state.applicationSettings?.serverVersion || "未知"}`;
  document.querySelector("#statUsers").textContent = state.stats.users;
  document.querySelector("#statActive").textContent = state.stats.activeUsers;
  document.querySelector("#statIps").textContent = state.stats.ips;
  document.querySelector("#serverIps").textContent = state.server?.ips?.length
    ? state.server.ips.join(" / ")
    : "暂未获取";
  document.querySelector("#serverIpStatus").textContent = state.server
    ?.available
    ? "通过 IPCheck.ing 查询，最多缓存 10 分钟"
    : `IPCheck.ing 查询失败，30 秒后重试${state.server?.errors?.[0] ? `：${state.server.errors[0]}` : ""}`;
  document.querySelector("#tcpPorts").value = (
    state.settings?.tcpPorts || []
  ).join(", ");
  document.querySelector("#udpPorts").value = (
    state.settings?.udpPorts || []
  ).join(", ");
  document.querySelector("#firewallConfigSummary").innerHTML =
    renderFirewallConfig(state.firewallConfig);
  document.querySelector("#apiRateLimitSeconds").value =
    state.applicationSettings?.apiRateLimitSeconds || 60;
  document.querySelector("#adminUsername").value =
    state.applicationSettings?.adminUsername || "admin";
  document.querySelector("#historyRetentionDays").value =
    state.retentionSettings?.historyDays || 7;
  document.querySelector("#auditRetentionDays").value =
    state.retentionSettings?.auditDays || 365;
  document.querySelector("#deviceRetentionDays").value =
    state.retentionSettings?.deviceDays || 90;
  const firewallAlert = document.querySelector("#firewallAlert");
  const firewall = state.firewallStatus;
  const firewallHealthy =
    firewall?.success &&
    !firewall.stale &&
    firewall.applied_revision === state.firewallRevision;
  firewallAlert.classList.remove("hidden");
  firewallAlert.classList.toggle("ok", Boolean(firewallHealthy));
  firewallAlert.textContent = firewallHealthy
    ? `防火墙已同步 · revision ${firewall.applied_revision} · IPv4 ${firewall.ipv4_count} / IPv6 ${firewall.ipv6_count}`
    : firewall?.stale
      ? "警告：超过 150 秒未收到宿主机防火墙同步状态，请检查 gatekeeper-sync 服务"
      : `警告：防火墙尚未同步到最新版本（应用 ${firewall?.applied_revision ?? 0} / 需要 ${state.firewallRevision ?? 0}）`;
  document.querySelector("#whitelistUser").innerHTML = state.users.length
    ? state.users
        .filter((user) => user.enabled)
        .map(
          (user) =>
            `<option value="${user.id}">${escapeHtml(user.name)}</option>`,
        )
        .join("")
    : '<option value="">暂无启用用户</option>';

  const normalizedQuery = query.trim().toLowerCase();
  const users = state.users.filter((user) => {
    const nameMatches = user.name.toLowerCase().includes(normalizedQuery);
    const ipMatches = state.ips.some(
      (ip) => ip.user_id === user.id && ip.ip.includes(normalizedQuery),
    );
    return !normalizedQuery || nameMatches || ipMatches;
  });

  document.querySelector("#userList").innerHTML = users.length
    ? users.map((user) => renderUser(user, state.ips, state.devices)).join("")
    : '<div class="empty">没有匹配的用户</div>';

  document.querySelector("#auditList").innerHTML = state.audit.length
    ? state.audit
        .map(
          (row) => `
      <div class="audit-row">
        <time>${formatTime(row.created_at)}</time>
        <div>
          <strong>${escapeHtml(actionNames[row.action] || row.action)}</strong><br>
          <small>${escapeHtml(row.user_name || "已删除用户")} ${escapeHtml(row.ip || "")}</small>
        </div>
        <small>${escapeHtml(row.detail || "")}</small>
      </div>
    `,
        )
        .join("")
    : '<div class="empty">暂无操作记录</div>';

  document.querySelector("#blacklistList").innerHTML = state.blockedNetworks
    ?.length
    ? state.blockedNetworks
        .map((row) =>
          renderRuleRow(
            row.network,
            row.reason || "无备注",
            row.id,
            "data-unblock",
            "解除",
          ),
        )
        .join("")
    : '<div class="empty">暂无黑名单网段</div>';
  document.querySelector("#permanentList").innerHTML = state.permanentWhitelist
    ?.length
    ? state.permanentWhitelist
        .map((row) =>
          renderRuleRow(
            row.ip,
            row.label || "无备注",
            row.id,
            "data-remove-permanent",
          ),
        )
        .join("")
    : '<div class="empty">暂无永久放行 IP</div>';
  document.querySelector("#globalWhitelistList").innerHTML = state
    .globalWhitelist?.length
    ? state.globalWhitelist
        .map((row) =>
          renderRuleRow(
            row.network,
            `所有用户 · ${row.label || "无备注"}`,
            row.id,
            "data-remove-global-network",
          ),
        )
        .join("")
    : '<div class="empty">暂无全局白名单网段</div>';
}

export function renderHistory(rows) {
  if (!rows.length) return '<div class="empty">暂无历史上报记录</div>';
  return `<div class="history-scroll"><table class="history-table"><thead><tr><th>上报 IP / 网段</th><th>地区与运营商</th><th>结果</th><th>时间</th></tr></thead><tbody>${rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.observed_ip)}</code><br><small>${escapeHtml(row.network)} · ${escapeHtml(row.source)}</small></td>
        <td>${escapeHtml(locationText(row))}<br><small>${escapeHtml(row.isp || "—")}${row.geo_source ? ` · ${escapeHtml(row.geo_source)}` : ""}</small></td>
        <td>${
          row.event === "removed"
            ? "已删除"
            : row.event === "evicted"
              ? "自动淘汰"
              : row.event === "added"
                ? "新增"
                : "已上报"
        }</td>
        <td><small>${formatTime(row.created_at)}</small></td>
      </tr>`,
    )
    .join("")}</tbody></table></div>`;
}
