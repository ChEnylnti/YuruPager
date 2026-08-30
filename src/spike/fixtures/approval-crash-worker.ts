import { adaptServerRequest } from "../../codex/adapter.js";
import { CodexAppServerClient } from "../../codex/json-rpc-client.js";
import { SqliteDecisionLedger } from "../../reliability/sqlite-decision-ledger.js";
import { SqliteApprovalJournal } from "../../reliability/sqlite-approval-journal.js";

const [webSocketUrl, threadId, databasePath] = process.argv.slice(2);
if (
  webSocketUrl === undefined ||
  threadId === undefined ||
  databasePath === undefined
) {
  throw new Error("Usage: approval-crash-worker <ws-url> <thread-id> <db-path>");
}

let responseSubmitted = false;
const ledger = new SqliteDecisionLedger(databasePath);
const journal = new SqliteApprovalJournal(databasePath);
const client = new CodexAppServerClient({
  webSocketUrl,
  requestTimeoutMs: 30_000,
  onServerResponseWritten() {
    responseSubmitted = true;
    process.exit(86);
  },
});

client.setServerRequestHandler((request) => {
  const adapted = adaptServerRequest(request);
  if (adapted === null || adapted.domain.type !== "approval.requested") {
    throw new Error(`Expected approval request, received ${request.method}`);
  }
  const requestId = adapted.domain.requestId;
  ledger.decide(requestId, `crash-window:${requestId}`, "approve");
  journal.prepare(requestId);
  journal.beginDispatch(requestId);
  return adapted.createCodexResponse({ kind: "approval", decision: "approve" });
});

await client.start();
await client.initialize({
  name: "yurupager-crash-window-worker",
  version: "0.0.1",
});
await client.request("thread/resume", { threadId, excludeTurns: true });

await new Promise<void>((_resolve, reject) => {
  setTimeout(() => {
    reject(
      new Error(
        responseSubmitted
          ? "Response hook did not terminate worker"
          : "Pending approval was not replayed to crash worker",
      ),
    );
  }, 30_000);
});
