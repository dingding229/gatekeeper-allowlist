const SCRIPT_URL =
  "https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/surge/gatekeeper.js?v=20260802-3";

const safeLabel = (value) =>
  String(value || "user")
    .replace(/[\r\n,="\\]/g, " ")
    .trim()
    .slice(0, 48) || "user";

export function renderSurgeModule({
  user,
  publicBaseUrl,
  token,
  cooldownSeconds = 30,
}) {
  const hostname = new URL(publicBaseUrl).hostname;
  const label = safeLabel(user.name);
  const suffix = user.id;
  const argument = `url=${encodeURIComponent(publicBaseUrl)}&key=${encodeURIComponent(token)}&cooldown=${Math.max(1, Math.ceil(cooldownSeconds))}`;

  return `#!name=Gatekeeper - ${label}
#!desc=${label} 专属网段自动加白；可配置上报周期，网络切换时更新，也可在策略页面手动刷新。
#!category=Gatekeeper
#!author=dingding229
#!arguments=interval:"3"
#!arguments-desc=interval: 自动上报间隔分钟（建议 3、5、10、15、30 或 60）

[Rule]
DOMAIN,${hostname},DIRECT,extended-matching
DOMAIN,64.ipcheck.ing,DIRECT,extended-matching

[Script]
gatekeeper_${suffix}_cron = type=cron,cronexp="*/{{{interval}}} * * * *",script-path=${SCRIPT_URL},timeout=30,argument="${argument}"
gatekeeper_${suffix}_event = type=event,event-name=network-changed,script-path=${SCRIPT_URL},timeout=30,argument="${argument}"
gatekeeper_${suffix}_panel_script = type=generic,script-path=${SCRIPT_URL},timeout=30,argument="${argument}"

[Panel]
gatekeeper_${suffix}_panel = title="Gatekeeper · ${label}",content="点击右上角刷新按钮手动加白",style=info,script-name=gatekeeper_${suffix}_panel_script
`;
}
