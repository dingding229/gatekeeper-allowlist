import { escapeHtml, formatTime } from "./format.js";

const actionNames = {
  "user.created": "创建用户",
  "user.status": "用户状态",
  "key.rotated": "轮换密钥",
  "ip.added": "添加网段",
  "ip.seen": "网段再次上报",
  "ip.evicted": "自动淘汰",
  "ip.removed": "手动移除",
  "settings.updated": "更新端口设置",
};

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
        <small>IPv${ip.family} · ${escapeHtml(ip.source)}</small>
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

function renderUser(user, allIps) {
  const ips = allIps
    .filter((ip) => ip.user_id === user.id)
    .sort(
      (left, right) => new Date(left.created_at) - new Date(right.created_at),
    );

  return `
    <article class="user-row" data-user="${user.id}">
      <div class="user-summary">
        <div class="identity">
          <span class="avatar">${escapeHtml(user.name.slice(0, 1).toUpperCase())}</span>
          <div>
            <strong>${escapeHtml(user.name)}</strong>
            <small>${user.ip_count}/3 个网段槽位</small>
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
        <table class="ip-table"><tbody>${renderIpRows(ips)}</tbody></table>
        <div class="row-actions">
          <button class="ghost" data-toggle-user="${user.id}" data-enabled="${user.enabled ? 0 : 1}">
            ${user.enabled ? "停用用户" : "重新启用"}
          </button>
          <button class="ghost" data-rotate="${user.id}">轮换 API Key</button>
        </div>
      </div>
    </article>
  `;
}

export function renderDashboard(state, query = "") {
  document.querySelector("#statUsers").textContent = state.stats.users;
  document.querySelector("#statActive").textContent = state.stats.activeUsers;
  document.querySelector("#statIps").textContent = state.stats.ips;
  document.querySelector("#tcpPorts").value = (
    state.settings?.tcpPorts || []
  ).join(", ");
  document.querySelector("#udpPorts").value = (
    state.settings?.udpPorts || []
  ).join(", ");

  const normalizedQuery = query.trim().toLowerCase();
  const users = state.users.filter((user) => {
    const nameMatches = user.name.toLowerCase().includes(normalizedQuery);
    const ipMatches = state.ips.some(
      (ip) => ip.user_id === user.id && ip.ip.includes(normalizedQuery),
    );
    return !normalizedQuery || nameMatches || ipMatches;
  });

  document.querySelector("#userList").innerHTML = users.length
    ? users.map((user) => renderUser(user, state.ips)).join("")
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
}
