import "./styles.css";

const menuButton = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const navigation = document.querySelector<HTMLElement>("#navigation")!;
const closeMenu = () => {
  menuButton.setAttribute("aria-expanded", "false");
  navigation.classList.remove("is-open");
};
menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
});
navigation.addEventListener("click", (event) => {
  if ((event.target as Element).closest("a")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    menuButton.getAttribute("aria-expanded") === "true"
  ) {
    closeMenu();
    menuButton.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target as Element).closest(".header-inner")) closeMenu();
});
window.matchMedia("(min-width: 769px)").addEventListener("change", (event) => {
  if (event.matches) closeMenu();
});

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panel = document.querySelector<HTMLElement>("#preview-panel")!;
const previewImage =
  document.querySelector<HTMLImageElement>("#preview-image")!;
const previewDescription = document.querySelector<HTMLElement>(
  "#preview-description",
)!;
const activateTab = (tab: HTMLButtonElement) => {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  panel.setAttribute("aria-labelledby", tab.id);
  previewImage.src = tab.dataset.image!;
  previewImage.alt = tab.dataset.alt!;
  previewDescription.textContent = tab.dataset.description!;
};
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabs[next]);
    tabs[next].focus();
  });
});

document
  .querySelector<HTMLButtonElement>("#copy-checksum")!
  .addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const status = document.querySelector<HTMLElement>("#copy-status")!;
    const value = button.dataset.checksum!;
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = "SHA-256 校验值已复制";
    } catch {
      status.textContent = "请展开下方校验值，手动选择并复制";
      document.querySelector<HTMLDetailsElement>("#checksum-details")!.open =
        true;
    }
  });

if ("IntersectionObserver" in window) {
  const sectionLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>(".nav-link"),
  ];
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sectionLinks.forEach((link) => {
          if (link.hash === `#${entry.target.id}`)
            link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        });
      }
    },
    { rootMargin: "-15% 0px -60% 0px" },
  );
  document
    .querySelectorAll("section[id]")
    .forEach((section) => observer.observe(section));
}
