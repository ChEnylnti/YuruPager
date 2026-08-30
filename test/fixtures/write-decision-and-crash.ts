import { SqliteDecisionLedger } from "../../src/reliability/sqlite-decision-ledger.js";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("Database path is required");
}

const ledger = new SqliteDecisionLedger(databasePath);
ledger.decide("request-after-crash", "crash-key", "approve");
process.exit(23);

