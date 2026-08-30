import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDatabase, createDatabase, migrateAndSeed } from "./database.js";

const config = loadConfig();
const database = createDatabase(config);

try {
  await migrateAndSeed(database, config.localAlphaPassword);
  const app = await buildApp({ config, database, serveWeb: process.env.NODE_ENV === "production" });
  const close = async () => {
    await app.close();
    await closeDatabase(database);
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  console.error(error);
  await closeDatabase(database);
  process.exit(1);
}
