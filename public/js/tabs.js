const validTabs = new Set([
  "users",
  "audit",
  "settings",
  "rules",
  "firewall",
  "api",
]);

export function createTabNavigation({ onActivate = () => {} } = {}) {
  const navigation = document.querySelector(".tabs");

  const activate = (requestedTab, updateHash = true) => {
    const tab = validTabs.has(requestedTab) ? requestedTab : "users";
    navigation.querySelectorAll("button[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".tab-content").forEach((element) => {
      element.classList.toggle("hidden", element.id !== `${tab}Tab`);
    });
    if (updateHash && window.location.hash !== `#${tab}`) {
      window.history.replaceState(null, "", `#${tab}`);
    }
    onActivate(tab);
  };

  navigation.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) activate(button.dataset.tab);
  });
  window.addEventListener("hashchange", () =>
    activate(window.location.hash.slice(1), false),
  );
  activate(window.location.hash.slice(1), false);
  return { activate };
}
