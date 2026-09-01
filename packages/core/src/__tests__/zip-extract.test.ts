import * as zlib from 'zlib';
import { extractZipEntry, listZipEntries } from '../zip-extract.js';

interface FixtureEntry {
  name: string;
  content: Buffer;
  method: 0 | 8;
  dataDescriptor?: boolean;
}

// Hand-rolled writer so the test does not depend on the reader under test.
function buildZip(entries: FixtureEntry[], comment = ''): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.method === 8 ? zlib.deflateRawSync(entry.content) : entry.content;
    const name = Buffer.from(entry.name, 'utf8');
    const flags = entry.dataDescriptor ? 0x0008 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : data.length, 18);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = [local, name, data];
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(0, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(entry.content.length, 12);
      localRecord.push(descriptor);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    const record = Buffer.concat(localRecord);
    localParts.push(record);
    offset += record.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const commentBytes = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd, commentBytes]);
}

describe('zip-extract', () => {
  const binary = Buffer.from('#!/bin/sh\necho luau-lsp 1.69.0\n'.repeat(40));

  test('lists entries and extracts stored and deflated content', () => {
    const archive = buildZip([
      { name: 'luau-lsp', content: binary, method: 8 },
      { name: 'README.txt', content: Buffer.from('release notes'), method: 0 },
    ]);
    expect(listZipEntries(archive).map((entry) => entry.name)).toEqual(['luau-lsp', 'README.txt']);
    expect(extractZipEntry(archive, 'luau-lsp').equals(binary)).toBe(true);
    expect(extractZipEntry(archive, 'README.txt').toString()).toBe('release notes');
  });

  test('uses central directory sizes when the local header defers to a data descriptor', () => {
    const archive = buildZip([{ name: 'luau-lsp.exe', content: binary, method: 8, dataDescriptor: true }]);
    expect(extractZipEntry(archive, 'luau-lsp.exe').equals(binary)).toBe(true);
  });

  test('finds the end of central directory behind an archive comment', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('a'), method: 0 }], 'built by ci');
    expect(extractZipEntry(archive, 'a.txt').toString()).toBe('a');
  });

  test('rejects missing entries, non-archives, and unknown compression methods', () => {
    const archive = buildZip([{ name: 'a.txt', content: Buffer.from('a'), method: 0 }]);
    expect(() => extractZipEntry(archive, 'b.txt')).toThrow(/no entry named b.txt/);
    expect(() => listZipEntries(Buffer.from('definitely not a zip'))).toThrow(/Not a zip archive/);

    const bogusMethod = Buffer.from(archive);
    const centralOffset = bogusMethod.readUInt32LE(bogusMethod.length - 22 + 16);
    bogusMethod.writeUInt16LE(12, centralOffset + 10);
    expect(() => extractZipEntry(bogusMethod, 'a.txt')).toThrow(/Unsupported zip compression method 12/);
  });

  test('rejects a size mismatch between the directory and the decompressed data', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: Buffer.from('abc'), method: 8 }]));
    const centralOffset = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt32LE(99, centralOffset + 24);
    expect(() => extractZipEntry(archive, 'a.txt')).toThrow(/decompressed to 3 bytes, expected 99/);
  });
});
