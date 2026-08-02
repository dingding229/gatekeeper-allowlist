import { SURGE_MODULE_VERSION, SURGE_SCRIPT_VERSION } from "./version.js";

const SCRIPT_URL = `https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/surge/gatekeeper.js?v=${SURGE_SCRIPT_VERSION}`;

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
  const argument = `url=${encodeURIComponent(publicBaseUrl)}&key=${encodeURIComponent(token)}&cooldown=${Math.max(1, Math.ceil(cooldownSeconds))}&moduleVersion=${SURGE_MODULE_VERSION}`;

  return `#!name=Gatekeeper - ${label}
#!version=${SURGE_MODULE_VERSION}
#!desc=${label} 专属网段自动加白；每 10 分钟检查；模块 v${SURGE_MODULE_VERSION}。
#!category=Gatekeeper
#!author=dingding229
[Rule]
DOMAIN,${hostname},DIRECT,extended-matching
DOMAIN,64.ipcheck.ing,DIRECT,extended-matching

[Script]
gatekeeper_${suffix}_cron = type=cron,cronexp="*/10 * * * *",script-path=${SCRIPT_URL},script-update-interval=300,timeout=30,argument="${argument}"
gatekeeper_${suffix}_event = type=event,event-name=network-changed,script-path=${SCRIPT_URL},script-update-interval=300,timeout=30,argument="${argument}"
gatekeeper_${suffix}_panel_script = type=generic,script-path=${SCRIPT_URL},script-update-interval=300,timeout=30,argument="${argument}"

[Panel]
gatekeeper_${suffix}_panel = title="Gatekeeper · ${label} · v${SURGE_MODULE_VERSION}",content="点击右上角刷新上报当前 IP",style=info,script-name=gatekeeper_${suffix}_panel_script
`;
}
