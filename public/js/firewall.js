import { escapeHtml, formatTime } from "./format.js";

const formatRuleList = (values, empty = "无") =>
  values?.length
    ? values
        .map((value) => `<code>${escapeHtml(String(value))}</code>`)
        .join(" ")
    : `<span class="muted">${empty}</span>`;

export function renderFirewallPage(config) {
  const status = config?.status || {};
  const healthy =
    status.success &&
    !status.stale &&
    status.appliedRevision === config?.revision;
  const statusText = healthy ? "规则已同步" : "规则待同步或异常";
  const statusClass = healthy ? "config-ok" : "config-warn";

  document.querySelector("#tcpPorts").value = (config?.tcpPorts || []).join(
    ", ",
  );
  document.querySelector("#udpPorts").value = (config?.udpPorts || []).join(
    ", ",
  );
  document.querySelector("#firewallConfigSummary").innerHTML = `
    <div class="config-status ${statusClass}">
      <strong>${statusText}</strong>
      <span>目标 revision ${config?.revision ?? 0} · 已应用 ${status.appliedRevision ?? 0}</span>
      ${status.error ? `<small>${escapeHtml(status.error)}</small>` : ""}
    </div>
    <div class="firewall-metrics">
      <article><span>IPv4 白名单</span><strong>${config?.ipv4?.length || 0}</strong><small>实际报告 ${status.ipv4Count ?? 0}</small></article>
      <article><span>IPv6 白名单</span><strong>${config?.ipv6?.length || 0}</strong><small>实际报告 ${status.ipv6Count ?? 0}</small></article>
      <article><span>TCP 规则</span><strong>${config?.tcpPorts?.length || 0}</strong><small>实际报告 ${status.tcpPortCount ?? 0}</small></article>
      <article><span>UDP 规则</span><strong>${config?.udpPorts?.length || 0}</strong><small>实际报告 ${status.udpPortCount ?? 0}</small></article>
    </div>
    <dl class="firewall-config-grid">
      <div><dt>TCP 保护端口</dt><dd>${formatRuleList(config?.tcpPorts)}</dd></div>
      <div><dt>UDP 保护端口</dt><dd>${formatRuleList(config?.udpPorts)}</dd></div>
      <div><dt>生效 IPv4 白名单（${config?.ipv4?.length || 0}）</dt><dd>${formatRuleList(config?.ipv4)}</dd></div>
      <div><dt>生效 IPv6 白名单（${config?.ipv6?.length || 0}）</dt><dd>${formatRuleList(config?.ipv6)}</dd></div>
      <div><dt>最近成功应用</dt><dd>${status.appliedAt ? escapeHtml(formatTime(status.appliedAt)) : "尚无同步记录"}</dd></div>
      <div><dt>状态更新时间</dt><dd>${status.updatedAt ? escapeHtml(formatTime(status.updatedAt)) : "—"}</dd></div>
      <div><dt>快照生成时间</dt><dd>${config?.generatedAt ? escapeHtml(formatTime(config.generatedAt)) : "—"}</dd></div>
      <div><dt>同步服务状态</dt><dd>${status.stale ? "超过 150 秒未上报" : status.success ? "正常" : "异常"}</dd></div>
    </dl>`;
}

export function renderFirewallLoading() {
  document.querySelector("#firewallConfigSummary").innerHTML =
    '<div class="empty">正在读取防火墙配置…</div>';
}

export function renderFirewallError() {
  document.querySelector("#firewallConfigSummary").innerHTML =
    '<div class="empty">防火墙配置加载失败，请检查同步服务后重试</div>';
}

export function createFirewallController({ apiRequest, showToast }) {
  let loaded = false;

  const load = async ({ notify = false } = {}) => {
    renderFirewallLoading();
    try {
      const result = await apiRequest("/api/admin/firewall-config");
      loaded = true;
      renderFirewallPage(result.firewallConfig);
      if (notify) showToast("防火墙配置已刷新");
    } catch (error) {
      renderFirewallError();
      if (notify) showToast("防火墙配置刷新失败");
      throw error;
    }
  };

  document
    .querySelector("#firewallForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await apiRequest("/api/admin/settings/firewall", {
          method: "PATCH",
          body: JSON.stringify({
            tcpPorts: document.querySelector("#tcpPorts").value,
            udpPorts: document.querySelector("#udpPorts").value,
          }),
        });
        await load();
        showToast("端口设置已保存，正在同步防火墙");
      } catch (error) {
        showToast(
          error.message === "invalid_port_ranges"
            ? "端口范围格式不正确"
            : "保存失败",
        );
      }
    });

  document
    .querySelector("#refreshFirewallConfig")
    .addEventListener("click", () => load({ notify: true }).catch(() => {}));

  return {
    load,
    invalidate() {
      loaded = false;
    },
    isLoaded() {
      return loaded;
    },
  };
}
