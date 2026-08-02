/* Gatekeeper Surge automatic allowlist client. */

var STATE_KEY = "gatekeeper_allowlist_state";

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
  function report(ipInfo) {
    var payload = { source: "surge" };
    if (ipInfo && ipInfo.ip) {
      payload.ip = ipInfo.ip;
      payload.ipInfo = ipInfo;
    }
    $httpClient.post(
      {
        url: baseUrl + "/api/v1/whitelist",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
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
          var reason = error
            ? String(error)
            : "HTTP " +
              String(status || "?") +
              " " +
              String(body || "").slice(0, 80);
          $notification.post("Gatekeeper 自动加白", "上报失败", reason);
          finish("Gatekeeper：上报失败", reason, false);
          return;
        }

        var networks = Array.isArray(data.ips)
          ? data.ips.map(function (item) {
              return typeof item === "string" ? item : item.ip;
            })
          : [];
        var title =
          "Gatekeeper " + data.slots + "/" + data.limit + " · " + data.ip;
        var content =
          (data.status === "added" ? "已加入网段" : "网段已在白名单") +
          (data.ipInfoRecorded ? " · IP 信息已更新" : " · IP 信息查询失败") +
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
      if (error || status < 200 || status >= 300) return report(null);
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
      );
    },
  );
}
