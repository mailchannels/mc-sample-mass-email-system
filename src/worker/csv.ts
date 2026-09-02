import type { CsvParserState, RecipientInput } from "./types";
import { base64FromBytes, bytesFromBase64 } from "./utils";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function initialCsvState(): CsvParserState {
  return {
    row: [],
    fieldBase64: "",
    inQuotes: false,
    quotePending: false,
    sawCarriageReturn: false,
    firstRow: true,
  };
}

/**
 * Incremental RFC 4180-ish parser. It retains raw field bytes between R2 range
 * chunks, so splitting a multi-byte UTF-8 character or quoted newline is safe.
 */
export function parseCsvChunk(
  chunk: Uint8Array,
  previous: CsvParserState,
  isFinal: boolean,
): { state: CsvParserState; rows: string[][] } {
  const state: CsvParserState = { ...previous, row: [...previous.row] };
  let field = concatBytes(bytesFromBase64(state.fieldBase64), new Uint8Array());
  const fieldParts: number[] = [...field];
  const rows: string[][] = [];

  const finishField = () => {
    state.row.push(decoder.decode(new Uint8Array(fieldParts)));
    fieldParts.length = 0;
  };
  const finishRow = () => {
    finishField();
    if (state.row.some((cell) => cell.length > 0)) rows.push(state.row);
    state.row = [];
  };

  for (let index = 0; index < chunk.length; index++) {
    const byte = chunk[index];
    if (state.sawCarriageReturn) {
      state.sawCarriageReturn = false;
      if (byte === 0x0a) continue;
    }

    if (state.inQuotes) {
      if (state.quotePending) {
        if (byte === 0x22) {
          fieldParts.push(0x22);
          state.quotePending = false;
          continue;
        }
        state.inQuotes = false;
        state.quotePending = false;
        // Fall through and handle the delimiter/newline after the closing quote.
      } else if (byte === 0x22) {
        state.quotePending = true;
        continue;
      } else {
        fieldParts.push(byte);
        continue;
      }
    }

    if (byte === 0x22 && fieldParts.length === 0) {
      state.inQuotes = true;
    } else if (byte === 0x2c) {
      finishField();
    } else if (byte === 0x0a) {
      finishRow();
    } else if (byte === 0x0d) {
      finishRow();
      state.sawCarriageReturn = true;
    } else {
      fieldParts.push(byte);
    }
  }

  if (isFinal) {
    if (state.quotePending) {
      state.inQuotes = false;
      state.quotePending = false;
    }
    if (fieldParts.length > 0 || state.row.length > 0) finishRow();
  }
  state.fieldBase64 = base64FromBytes(new Uint8Array(fieldParts));
  return { state, rows };
}

export function rowsToRecipients(rows: string[][], state: CsvParserState): RecipientInput[] {
  const output: RecipientInput[] = [];
  for (const rawRow of rows) {
    const row = [...rawRow];
    if (state.firstRow) {
      state.firstRow = false;
      row[0] = row[0]?.replace(/^\uFEFF/, "") ?? "";
      const normalized = row.map(normalizeHeader);
      if (normalized.some((header) => ["email", "emailaddress"].includes(header))) {
        state.headers = normalized;
        continue;
      }
      state.headers = ["email", "firstname", "lastname", "topics"];
    }

    const headers = state.headers ?? ["email", "firstname", "lastname", "topics"];
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index]?.trim() ?? "";
    });
    const address = (record.email || record.emailaddress || row[0] || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) continue;
    const topics = (record.topics || record.topic || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    output.push({
      email: address,
      firstName: record.firstname || record.fname || record.first || "",
      lastName: record.lastname || record.lname || record.last || "",
      topics,
      data: { ...record, email: address },
    });
  }
  return output;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]/g, "");
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}
