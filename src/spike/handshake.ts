import { CodexAppServerClient } from "../codex/json-rpc-client.js";

interface ModelListResponse {
  data?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
}

const client = new CodexAppServerClient();

try {
  await client.start();
  const initialized = await client.initialize({
    name: "yurupager-spike",
    title: "YuruPager Spike",
    version: "0.0.1",
  });
  const modelResponse = await client.request<ModelListResponse>("model/list", {
    limit: 5,
    includeHidden: false,
  });
  const models = modelResponse.data ?? modelResponse.models ?? [];

  process.stdout.write(
    `${JSON.stringify(
      {
        initialized: true,
        platformFamily: initialized.platformFamily,
        platformOs: initialized.platformOs,
        userAgent: initialized.userAgent,
        modelCount: models.length,
        modelShape: models[0] === undefined ? [] : Object.keys(models[0]).sort(),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.stop();
}

