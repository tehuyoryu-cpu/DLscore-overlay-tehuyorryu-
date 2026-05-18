// popup_guard.js

if (window.__popupInitialized) {
  console.warn("popup already initialized");
} else {
  window.__popupInitialized = true;
}

window.addEventListener("error", e => {
  console.error("popup error", e.error);
});

window.addEventListener("unhandledrejection", e => {
  console.error("promise rejection", e.reason);
});