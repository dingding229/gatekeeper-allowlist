const SCRIPT_URL =
  "https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/surge/gatekeeper.js";

const safeLabel = (value) =>
  String(value || "user")
    .replace(/[\r\n,="\\]/g, " ")
    .trim()
    .slice(0, 48) || "user";

export function renderSurgeModule({ user, publicBaseUrl, token }) {
  const hostname = new URL(publicBaseUrl).hostname;
  const label = safeLabel(user.name);
  const suffix = user.id;
  const argument = `url=${encodeURIComponent(publicBaseUrl)}&key=${encodeURIComponent(token)}`;

  return `#!name=Gatekeeper - ${label}
#!desc=${label} 专属网段自动加白；每 3 分钟及网络切换时更新，可在策略页面手动刷新。
#!category=Gatekeeper
#!author=dingding229

[Rule]
DOMAIN,${hostname},DIRECT,extended-matching

[Script]
gatekeeper_${suffix}_cron = type=cron,cronexp="*/3 * * * *",script-path=${SCRIPT_URL},timeout=30,argument="${argument}"
gatekeeper_${suffix}_event = type=event,event-name=network-changed,script-path=${SCRIPT_URL},timeout=30,argument="${argument}"
gatekeeper_${suffix}_panel_script = type=generic,script-path=${SCRIPT_URL},timeout=30,argument="${argument}"

[Panel]
gatekeeper_${suffix}_panel = title="Gatekeeper · ${label}",content="点击右上角刷新按钮手动加白",style=info,script-name=gatekeeper_${suffix}_panel_script,update-interval=180
`;
}
