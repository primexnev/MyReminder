// Where the MyReminder API runs: local worker during development, Cloudflare in production.
window.MYREMINDER_API = location.hostname === "localhost"
  ? "http://localhost:8787"
  : "https://myreminder-api.primexnev.workers.dev";

// Public half of the push key pair (the private half is a Cloudflare secret).
window.MYREMINDER_VAPID = "BFSvguLr9nAAjIBK7g20q5qYDNMHF_WvOYAdfkhIeCUwDSl5RPb9FaqJb780BbfBAXosaSa-BM1PbsF2-L8i5DY";
