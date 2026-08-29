import app from "./app.ts";
import config from "./config/config.ts";

// Without these the first thing a Reviewer does is authorise, and the token
// exchange answers 502 for a reason nothing on screen can explain. Say so
// here instead. `NOTION_OAUTH_CLIENT_SECRET` is `.env` only — never committed.
const missing = (["clientId", "clientSecret"] as const).filter(
  (key) => !config.notion[key],
);
if (missing.length) {
  console.error(
    `Missing Notion OAuth credentials: ${missing.join(", ")}. See .env.example.`,
  );
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
