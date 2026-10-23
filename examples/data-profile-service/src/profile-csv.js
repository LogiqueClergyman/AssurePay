const INPUT_LIMIT = 65_536;
const ROW_LIMIT = 512;
const COLUMN_LIMIT = 32;
const FIELD_LIMIT = 4_096;
const HEADER_LIMIT = 128;

function fail(code) {
  throw new Error(code);
}

function utf8Length(value) {
  return Buffer.byteLength(value, 'utf8');
}

function pushChar(field, char) {
  const next = field.value + char;
  if (utf8Length(next) > FIELD_LIMIT) fail('CSV_FIELD_TOO_LARGE');
  field.value = next;
}

function parseRecords(text) {
  const records = [];
  let record = [];
  let field = { value: '' };
  let state = 'start';
  let endedWithSeparator = false;

  const finishField = () => {
    record.push(field.value);
    field = { value: '' };
    state = 'start';
  };
  const finishRecord = () => {
    finishField();
    records.push(record);
    record = [];
    endedWithSeparator = true;
  };
  const newlineAt = (index) => {
    const char = text[index];
    if (char === '\n') return { length: 1, value: '\n' };
    if (char === '\r' && text[index + 1] === '\n') return { length: 2, value: '\r\n' };
    if (char === '\r') fail('CSV_SYNTAX_INVALID');
    return undefined;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const newline = newlineAt(i);
    if (newline) {
      if (state === 'quoted') {
        pushChar(field, newline.value);
      } else {
        finishRecord();
      }
      i += newline.length - 1;
      continue;
    }

    endedWithSeparator = false;
    if (state === 'start') {
      if (char === ',') finishField();
      else if (char === '"') state = 'quoted';
      else {
        pushChar(field, char);
        state = 'unquoted';
      }
    } else if (state === 'unquoted') {
      if (char === ',') finishField();
      else if (char === '"') fail('CSV_SYNTAX_INVALID');
      else pushChar(field, char);
    } else if (state === 'quoted') {
      if (char === '"') state = 'afterQuote';
      else pushChar(field, char);
    } else if (state === 'afterQuote') {
      if (char === '"') {
        pushChar(field, '"');
        state = 'quoted';
      } else if (char === ',') finishField();
      else fail('CSV_SYNTAX_INVALID');
    }
  }

  if (state === 'quoted') fail('CSV_SYNTAX_INVALID');
  if (!endedWithSeparator) {
    finishField();
    records.push(record);
  }
  return records;
}

/** Parse the frozen CSV profile v1 grammar and return deterministic UTF-8 JSON. */
export function profileCsv(input) {
  if (!(input instanceof Uint8Array)) fail('CSV_INPUT_INVALID');
  if (input.byteLength > INPUT_LIMIT) fail('CSV_INPUT_TOO_LARGE');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    fail('CSV_INVALID_UTF8');
  }
  if (text.length === 0) fail('CSV_INPUT_EMPTY');
  if (text.charCodeAt(0) === 0xfeff) fail('CSV_BOM_UNSUPPORTED');

  const records = parseRecords(text);
  if (records.length === 0) fail('CSV_INPUT_EMPTY');
  const headers = records[0];
  if (headers.length > COLUMN_LIMIT) fail('CSV_COLUMN_LIMIT');
  if (headers.some((name) => name.length === 0 || utf8Length(name) > HEADER_LIMIT)) fail('CSV_HEADER_INVALID');
  if (new Set(headers).size !== headers.length) fail('CSV_DUPLICATE_HEADER');

  const data = records.slice(1);
  if (data.length > ROW_LIMIT) fail('CSV_ROW_LIMIT');
  for (const row of data) {
    if (row.length !== headers.length) fail('CSV_ROW_WIDTH_INVALID');
  }

  const fields = headers.map((name, column) => {
    let missing = 0;
    for (const row of data) if (row[column] === '') missing += 1;
    return { name, present: data.length - missing, missing };
  });
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    rows: data.length,
    columns: headers.length,
    fields,
  }));
}
