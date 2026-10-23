import assert from 'node:assert/strict';
import test from 'node:test';
import { profileCsv } from '../src/profile-csv.js';

const bytes = (value) => new TextEncoder().encode(value);
const json = (value) => JSON.parse(new TextDecoder().decode(profileCsv(bytes(value))));
const errorCode = (fn, code) => assert.throws(fn, (error) => error instanceof Error && error.message === code);

test('profiles rows, columns, empty values and quoted values deterministically', () => {
  const input = 'name,notes,empty\r\nAda,"comma, and\nline",\r\nLin,"say ""hi""", \r\n';
  const expected = {
    schemaVersion: 1,
    rows: 2,
    columns: 3,
    fields: [
      { name: 'name', present: 2, missing: 0 },
      { name: 'notes', present: 2, missing: 0 },
      { name: 'empty', present: 1, missing: 1 },
    ],
  };
  assert.deepEqual(json(input), expected);
  assert.deepEqual(profileCsv(bytes(input)), profileCsv(bytes(input)));
});

test('supports header-only and LF input; whitespace is present', () => {
  assert.deepEqual(json('a,b'), {
    schemaVersion: 1, rows: 0, columns: 2,
    fields: [{ name: 'a', present: 0, missing: 0 }, { name: 'b', present: 0, missing: 0 }],
  });
  assert.deepEqual(json('a,b\n ,\n'), {
    schemaVersion: 1, rows: 1, columns: 2,
    fields: [{ name: 'a', present: 1, missing: 0 }, { name: 'b', present: 0, missing: 1 }],
  });
});

test('rejects empty documents, BOM and invalid UTF-8', () => {
  errorCode(() => profileCsv(bytes('')), 'CSV_INPUT_EMPTY');
  errorCode(() => profileCsv(bytes('\uFEFFa')), 'CSV_BOM_UNSUPPORTED');
  errorCode(() => profileCsv(Uint8Array.of(0xc3, 0x28)), 'CSV_INVALID_UTF8');
});

test('rejects malformed quoting and bare carriage returns', () => {
  for (const input of ['a\rb', 'a"b', '"a"x', '"unterminated']) {
    errorCode(() => profileCsv(bytes(input)), 'CSV_SYNTAX_INVALID');
  }
});

test('counts a one-column blank record as a row and rejects duplicate or invalid headers and width mismatch', () => {
  assert.deepEqual(json('a\n\n1'), {
    schemaVersion: 1, rows: 2, columns: 1,
    fields: [{ name: 'a', present: 1, missing: 1 }],
  });
  errorCode(() => profileCsv(bytes('a,a\n1,2')), 'CSV_DUPLICATE_HEADER');
  errorCode(() => profileCsv(bytes(',b\n1,2')), 'CSV_HEADER_INVALID');
  errorCode(() => profileCsv(bytes('a,b\n1')), 'CSV_ROW_WIDTH_INVALID');
});

test('enforces byte, row, column and field bounds', () => {
  errorCode(() => profileCsv(new Uint8Array(65_537)), 'CSV_INPUT_TOO_LARGE');
  errorCode(() => profileCsv(bytes(`${Array.from({ length: 33 }, (_, i) => `h${i}`).join(',')}`)), 'CSV_COLUMN_LIMIT');
  errorCode(() => profileCsv(bytes(`${'h'.repeat(129)}\nx`)), 'CSV_HEADER_INVALID');
  errorCode(() => profileCsv(bytes(`h\n${'x'.repeat(4_097)}`)), 'CSV_FIELD_TOO_LARGE');
  const tooManyRows = `h\n${Array.from({ length: 513 }, () => 'x').join('\n')}`;
  errorCode(() => profileCsv(bytes(tooManyRows)), 'CSV_ROW_LIMIT');
});

test('accepts exact CSV limits and applies UTF-8 byte bounds', () => {
  const maxRowsAndColumns = `${Array.from({ length: 32 }, (_, i) => `h${i}`).join(',')}\n${Array.from({ length: 512 }, () => Array(32).fill('x').join(',')).join('\n')}`;
  const profile = JSON.parse(new TextDecoder().decode(profileCsv(bytes(maxRowsAndColumns))));
  assert.equal(profile.rows, 512);
  assert.equal(profile.columns, 32);

  const exactInput = `h\n${Array.from({ length: 15 }, () => 'x'.repeat(4_096)).join('\n')}\n${'y'.repeat(4_079)}`;
  assert.equal(Buffer.byteLength(exactInput), 65_536);
  assert.equal(JSON.parse(new TextDecoder().decode(profileCsv(bytes(exactInput)))).rows, 16);

  const multibyteHeader = 'é'.repeat(64);
  const multibyteField = '界'.repeat(1_365) + 'a'; // 4,096 UTF-8 bytes
  const multibyte = JSON.parse(new TextDecoder().decode(profileCsv(bytes(`${multibyteHeader}\n${multibyteField}`))));
  assert.equal(multibyte.fields[0].name, multibyteHeader);
  assert.equal(multibyte.fields[0].present, 1);
  errorCode(() => profileCsv(bytes(`${'é'.repeat(65)}\nx`)), 'CSV_HEADER_INVALID');
  errorCode(() => profileCsv(bytes(`h\n${'界'.repeat(1_366)}`)), 'CSV_FIELD_TOO_LARGE');
});

test('treats quoted-empty and empty cells as missing but whitespace as present', () => {
  assert.deepEqual(json('a,b,c\n"",, '), {
    schemaVersion: 1,
    rows: 1,
    columns: 3,
    fields: [
      { name: 'a', present: 0, missing: 1 },
      { name: 'b', present: 0, missing: 1 },
      { name: 'c', present: 1, missing: 0 },
    ],
  });
});
