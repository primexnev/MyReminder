// Where the MyReminder API runs: local worker during development, Cloudflare in production.
window.MYREMINDER_API = location.hostname === "localhost"
  ? "http://localhost:8787"
  : "https://myreminder-api.REPLACE_ME.workers.dev";
