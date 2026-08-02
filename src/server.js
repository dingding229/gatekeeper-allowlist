import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`[gatekeeper] listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`[gatekeeper] received ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
