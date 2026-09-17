(() => {
  "use strict";
  const root = document.documentElement;
  root.classList.add("js-ready");
  const themeButton = document.querySelector(".theme-toggle");
  const menuButton = document.querySelector(".mobile-menu");
  const navigation = document.querySelector(".nav-links");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function updateThemeButton() {
    const isLight = root.dataset.theme === "light";
    const label = `Switch to ${isLight ? "dark" : "light"} mode`;
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
    themeColor.content = isLight ? "#f5f6f8" : "#101113";
  }
  updateThemeButton();
  themeButton.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem("aziz.theme", root.dataset.theme);
    } catch (_) {}
    updateThemeButton();
  });

  function setMenu(open) {
    navigation.classList.toggle("is-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.querySelector("span").textContent = open ? "−" : "+";
  }
  menuButton.addEventListener("click", () =>
    setMenu(menuButton.getAttribute("aria-expanded") !== "true"),
  );
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      menuButton.getAttribute("aria-expanded") === "true"
    ) {
      setMenu(false);
      menuButton.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-nav")) setMenu(false);
  });
  window
    .matchMedia("(max-width: 760px)")
    .addEventListener("change", () => setMenu(false));

  const form = document.querySelector('form[name="contact"]');
  const status = document.querySelector("#form-status");
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = "Sending…";
    form.setAttribute("aria-busy", "true");
    status.dataset.state = "pending";
    status.textContent = "Sending your message…";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Submission failed");
      status.dataset.state = "success";
      status.textContent =
        "Thanks! Your message has been sent. I’ll get back to you by email.";
      form.reset();
    } catch (_) {
      status.dataset.state = "error";
      status.textContent =
        "Your message couldn’t be confirmed. Please try again, or email contact@azizhazim.com. Your text is still here.";
    } finally {
      window.clearTimeout(timeout);
      form.removeAttribute("aria-busy");
      submit.disabled = false;
      submit.textContent = "Send message";
    }
  });
})();
