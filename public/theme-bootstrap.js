// Applies the saved light/dark choice before first paint. It is a same-origin
// file, not inline, because the Content Security Policy is script-src 'self'.
(function () {
  try {
    var stored = localStorage.getItem("mc-theme");
    var dark =
      stored === "dark" ||
      (stored !== "light" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {}
})();
