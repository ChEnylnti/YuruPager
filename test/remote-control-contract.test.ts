import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeRemoteControlSchemas,
  REQUIRED_CLIENT_FIELDS,
  REQUIRED_PAIRING_RESPONSE_FIELDS,
  REQUIRED_REMOTE_CONTROL_METHODS,
  REQUIRED_REMOTE_CONTROL_NOTIFICATION,
  REQUIRED_STATUS_VALUES,
  summarizeRemoteControlStatus,
} from "../src/spike/remote-control-contract.js";

function completeSchemas(): Record<string, unknown> {
  return {
    "ClientRequest.json": {
      anyOf: [
        ...REQUIRED_REMOTE_CONTROL_METHODS.map((method) => ({
          properties: { method: { enum: [method] } },
        })),
      ],
    },
    "ServerNotification.json": {
      anyOf: [
        {
          properties: {
            method: { enum: [REQUIRED_REMOTE_CONTROL_NOTIFICATION] },
          },
        },
      ],
    },
    "v2/RemoteControlPairingStartResponse.json": {
      properties: Object.fromEntries(
        REQUIRED_PAIRING_RESPONSE_FIELDS.map((field) => [field, {}]),
      ),
    },
    "v2/RemoteControlClientsListResponse.json": {
      properties: Object.fromEntries(
        REQUIRED_CLIENT_FIELDS.map((field) => [field, {}]),
      ),
    },
    "v2/RemoteControlStatusReadResponse.json": {
      definitions: {
        RemoteControlConnectionStatus: { enum: [...REQUIRED_STATUS_VALUES] },
      },
      properties: {
        status: { $ref: "#/definitions/RemoteControlConnectionStatus" },
      },
    },
  };
}

test("accepts the complete official remote-control contract", () => {
  const result = analyzeRemoteControlSchemas(completeSchemas());
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missingMethods, []);
  assert.deepEqual(result.missingStatusValues, []);
});

test("fails closed when pairing and device lifecycle fields disappear", () => {
  const schemas = completeSchemas();
  const pairing = schemas["v2/RemoteControlPairingStartResponse.json"] as {
    properties: Record<string, unknown>;
  };
  delete pairing.properties.pairingCode;
  const clients = schemas["v2/RemoteControlClientsListResponse.json"] as {
    properties: Record<string, unknown>;
  };
  delete clients.properties.clientId;
  const status = schemas["v2/RemoteControlStatusReadResponse.json"] as {
    definitions: { RemoteControlConnectionStatus: { enum: string[] } };
  };
  status.definitions.RemoteControlConnectionStatus.enum =
    status.definitions.RemoteControlConnectionStatus.enum.filter(
      (value) => value !== "connected",
    );

  const result = analyzeRemoteControlSchemas(schemas);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingPairingResponseFields, ["pairingCode"]);
  assert.deepEqual(result.missingClientFields, ["clientId"]);
  assert.deepEqual(result.missingStatusValues, ["connected"]);
});

test("does not treat unrelated JSON-RPC methods as remote control support", () => {
  const schemas = completeSchemas();
  const request = schemas["ClientRequest.json"] as { anyOf: unknown[] };
  request.anyOf = [{ properties: { method: { enum: ["thread/list"] } } }];

  const result = analyzeRemoteControlSchemas(schemas);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingMethods, [...REQUIRED_REMOTE_CONTROL_METHODS]);
});

test("fails closed when an experimental schema file is absent", () => {
  const schemas = completeSchemas();
  delete schemas["v2/RemoteControlClientsListResponse.json"];

  const result = analyzeRemoteControlSchemas(schemas);
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingClientFields, [...REQUIRED_CLIENT_FIELDS]);
});

test("summarizes status without exposing installation identity", () => {
  const result = summarizeRemoteControlStatus({
    status: "disabled",
    environmentId: null,
    installationId: "private-installation-id",
    serverName: "private-server-name",
  });
  assert.equal(result.reachable, true);
  assert.equal(result.scope, "fresh_local_app_server");
  assert.equal(result.status, "disabled");
  assert.equal(result.environmentIdPresent, false);
  assert.deepEqual(result.fields, [
    "environmentId",
    "installationId",
    "serverName",
    "status",
  ]);
  assert.equal(JSON.stringify(result).includes("private-installation-id"), false);
});
