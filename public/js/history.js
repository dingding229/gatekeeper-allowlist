import { escapeHtml, formatTime } from "./format.js";

const eventLabels = {
  reported: "已上报",
  added: "新增",
  removed: "已删除",
  evicted: "自动淘汰",
};

const locationText = (row) =>
  [row.country, row.region, row.city].filter(Boolean).join(" · ") ||
  "尚无地区信息";

export function renderHistory(rows) {
  if (!rows.length) return '<div class="empty">当前条件下没有历史记录</div>';
  return `<div class="history-scroll"><table class="history-table"><thead><tr><th>上报 IP / 网段</th><th>地区与运营商</th><th>结果</th><th>时间</th></tr></thead><tbody>${rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.observed_ip)}</code><br><small>${escapeHtml(row.network)} · ${escapeHtml(row.source)}</small></td>
        <td>${escapeHtml(locationText(row))}<br><small>${escapeHtml(row.isp || "—")}${row.geo_source ? ` · ${escapeHtml(row.geo_source)}` : ""}</small></td>
        <td><span class="event-badge event-${escapeHtml(row.event || "reported")}">${eventLabels[row.event] || "已上报"}</span></td>
        <td><small>${formatTime(row.created_at)}</small></td>
      </tr>`,
    )
    .join("")}</tbody></table></div>`;
}
