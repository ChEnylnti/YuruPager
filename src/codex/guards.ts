export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function readNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function requireString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = readString(value, key);
  if (field === undefined) {
    throw new ProtocolShapeError(`Expected ${key} to be a string`);
  }
  return field;
}

export class ProtocolShapeError extends Error {
  override readonly name = "ProtocolShapeError";
}

