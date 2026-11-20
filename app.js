document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    const status = document.getElementById("copy-status");
    if (!target) return;

    const text = target.textContent ? target.textContent.trim() : "";
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      if (status) status.textContent = "Install command copied to clipboard.";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1800);
    } catch {
      if (status) status.textContent = "Copy failed. Please copy the command manually.";
    }
  });
});
