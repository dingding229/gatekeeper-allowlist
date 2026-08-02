/* Gatekeeper Surge automatic allowlist client. */

function argumentsFromSurge() {
  var result = {};
  var raw = typeof $argument === "string" ? $argument : "";
  raw.split("&").forEach(function (part) {
    var index = part.indexOf("=");
    if (index > 0) {
      result[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
    }
  });
  return result;
}

function finish(title, content, ok) {
  $done({
    title: title,
    content: content,
    style: ok ? "good" : "error",
  });
}

var config = argumentsFromSurge();
var baseUrl = String(config.url || "").replace(/\/+$/, "");
var apiKey = String(config.key || "");
var keySuffix = apiKey.slice(-16).replace(/[^A-Za-z0-9_-]/g, "");
var DEVICE_ID_STORE_KEY = "gatekeeper_device_id_" + keySuffix;
var deviceId = String($persistentStore.read(DEVICE_ID_STORE_KEY) || "");
if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
  deviceId =
    "surge_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 12);
  $persistentStore.write(deviceId, DEVICE_ID_STORE_KEY);
}
var deviceName = String(config.device || "Surge").trim().slice(0, 64) || "Surge";
var STATE_KEY = "gatekeeper_allowlist_state_" + deviceId;
var LAST_REPORTED_IP_KEY = "gatekeeper_last_reported_ip_" + deviceId;
var NEXT_REPORT_KEY = "gatekeeper_next_report_" + deviceId;
var cooldownSeconds = parseInt(config.cooldown || "30", 10);
if (!isFinite(cooldownSeconds) || cooldownSeconds < 1) cooldownSeconds = 30;

function apiFailureReason(error, data) {
  if (error) return "网络连接失败，请检查 Gatekeeper 域名与直连规则";
  var code = data && data.error;
  if (code === "rate_limit_exceeded") {
    return "请求过于频繁，请在 " + String(data.retryAfter || 1) + " 秒后重试";
  }
  if (code === "invalid_api_key" || code === "missing_api_key") {
    return "模块授权已失效，请从后台重新获取并安装专属模块";
  }
  if (code === "network_blacklisted") return "当前出口网段已被管理员拉黑";
  if (code === "invalid_ip") return "当前出口 IP 地址无法识别";
  return "Gatekeeper 暂时无法处理请求，请稍后重试";
}

if (
  !/^https:\/\//i.test(baseUrl) ||
  (apiKey.indexOf("awl_") !== 0 && apiKey.indexOf("sg_") !== 0)
) {
  $notification.post(
    "Gatekeeper 自动加白",
    "模块参数不完整",
    "请填写 HTTPS 地址、域名和 Gatekeeper 授权令牌。",
  );
  finish("Gatekeeper：未配置", "请编辑模块参数 url、domain 和 key", false);
} else {
  var now = Date.now();
  var nextAllowedAt = Number($persistentStore.read(NEXT_REPORT_KEY) || 0);
  if (nextAllowedAt > now) {
    finish(
      "Gatekeeper：无需重复上报",
      "刚刚已经触发过上报，" +
        String(Math.ceil((nextAllowedAt - now) / 1000)) +
        " 秒后可再次执行",
      true,
    );
  } else {
    $persistentStore.write(
      String(now + cooldownSeconds * 1000),
      NEXT_REPORT_KEY,
    );

    function report(ipInfo, ipInfoError) {
      if (!ipInfo || !ipInfo.ip) {
        $persistentStore.write("0", NEXT_REPORT_KEY);
        var lookupReason = ipInfoError || "IPCheck.ing 返回内容无法识别";
        $notification.post(
          "Gatekeeper 自动加白",
          "未检测到出口 IP",
          lookupReason,
        );
        finish("Gatekeeper：IP 检测失败", lookupReason, false);
        return;
      }

      var currentIp = String(ipInfo.ip).trim();
      var lastReportedIp = String(
        $persistentStore.read(LAST_REPORTED_IP_KEY) || "",
      ).trim();
      var manuallyForced =
        typeof $script !== "undefined" &&
        $script.type === "generic" &&
        typeof $trigger !== "undefined" &&
        $trigger === "button";
      if (lastReportedIp === currentIp && !manuallyForced) {
        $persistentStore.write("0", NEXT_REPORT_KEY);
        finish(
          "Gatekeeper：IP 未变化",
          "当前出口 IP " +
            currentIp +
            "\n未调用上报接口\n检查时间：" +
            new Date().toLocaleString(),
          true,
        );
        return;
      }

      var payload = {
        source: manuallyForced ? "surge-manual" : "surge",
        deviceId: deviceId,
        deviceName: deviceName,
        ip: currentIp,
        ipInfo: ipInfo,
      };
      $httpClient.post(
        {
          url: baseUrl + "/api/v1/whitelist",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
            "X-Gatekeeper-Device-ID": deviceId,
          },
          body: JSON.stringify(payload),
          timeout: 15,
        },
        function (error, response, body) {
          var status = response && (response.status || response.statusCode);
          var data;
          try {
            data = JSON.parse(body || "{}");
          } catch (_error) {
            data = null;
          }

          if (error || status < 200 || status >= 300 || !data || !data.ok) {
            var reason = apiFailureReason(error, data);
            if (data && data.error === "rate_limit_exceeded") {
              $persistentStore.write(
                String(Date.now() + Number(data.retryAfter || 1) * 1000),
                NEXT_REPORT_KEY,
              );
            } else {
              $persistentStore.write("0", NEXT_REPORT_KEY);
            }
            $notification.post("Gatekeeper 自动加白", "上报失败", reason);
            finish("Gatekeeper：上报失败", reason, false);
            return;
          }

          var serverCooldown = Number(data.rateLimitSeconds || cooldownSeconds);
          if (isFinite(serverCooldown) && serverCooldown > 0) {
            $persistentStore.write(
              String(Date.now() + serverCooldown * 1000),
              NEXT_REPORT_KEY,
            );
          }
          $persistentStore.write(currentIp, LAST_REPORTED_IP_KEY);

          var networks = Array.isArray(data.ips)
            ? data.ips.map(function (item) {
                return typeof item === "string" ? item : item.ip;
              })
            : [];
          var title =
            "Gatekeeper " + data.slots + "/" + data.limit + " · " + data.ip;
          var content =
            (data.status === "added" ? "已加入网段" : "网段已在白名单") +
            (data.ipInfoRecorded
              ? " · IP 信息已更新"
              : " · " + (ipInfoError || "IP 信息查询失败")) +
            "\n" +
            networks.join("\n") +
            "\n更新时间：" +
            new Date().toLocaleString();
          var state = data.ip + "|" + networks.join(",");
          var previous = $persistentStore.read(STATE_KEY);
          if (previous !== state) {
            $persistentStore.write(state, STATE_KEY);
            $notification.post("Gatekeeper 自动加白", title, content);
          }
          finish(title, content, true);
        },
      );
    }

    $httpClient.get(
      {
        url: "https://64.ipcheck.ing/geo",
        headers: {
          Accept: "text/plain",
          "User-Agent": "curl/8.7.1",
        },
        timeout: 10,
      },
      function (error, response, body) {
        var status = response && (response.status || response.statusCode);
        if (error || status < 200 || status >= 300)
          return report(null, "IPCheck.ing 查询失败，请检查直连规则");
        var fields = {};
        String(body || "")
          .split(/\r?\n/)
          .forEach(function (line) {
            var separator = line.indexOf(":");
            if (separator > 0)
              fields[line.slice(0, separator).trim()] = line
                .slice(separator + 1)
                .trim();
          });
        report(
          fields.IP
            ? {
                source: "ipcheck.ing",
                ip: fields.IP,
                country: fields.Country || "",
                region: fields.Region || "",
                city: fields.City || "",
                isp: fields.Org || "",
              }
            : null,
          fields.IP ? null : "IPCheck.ing 返回内容无法识别",
        );
      },
    );
  }
}
