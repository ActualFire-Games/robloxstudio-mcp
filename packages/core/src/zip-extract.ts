import * as zlib from 'zlib';

// Minimal reader for the single-file release archives luau-lsp publishes.
// Node has no built-in zip container support, and pulling in a zip dependency
// for one 5 MB file is not worth it. Handles stored and deflated entries only;
// no zip64, no encryption, no multi-disk archives.
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_MIN_LENGTH = 22;
const CENTRAL_DIRECTORY_ENTRY_MIN_LENGTH = 46;
const LOCAL_FILE_HEADER_MIN_LENGTH = 30;
const MAX_ARCHIVE_COMMENT_LENGTH = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - END_OF_CENTRAL_DIRECTORY_MIN_LENGTH - MAX_ARCHIVE_COMMENT_LENGTH);
  for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_MIN_LENGTH; offset >= lowest; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Not a zip archive: end of central directory record not found');
}

export function listZipEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_SENTINEL || directoryOffset + directorySize > eocd) {
    throw new Error('Unsupported or malformed zip archive: central directory out of bounds');
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_DIRECTORY_ENTRY_MIN_LENGTH > archive.length
      || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new Error('Malformed zip archive: bad central directory entry');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + CENTRAL_DIRECTORY_ENTRY_MIN_LENGTH;
    if (nameStart + nameLength > archive.length) {
      throw new Error('Malformed zip archive: entry name out of bounds');
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new Error('Unsupported zip archive: zip64 entries are not supported');
    }
    entries.push({
      name: archive.toString('utf8', nameStart, nameStart + nameLength),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function extractZipEntry(archive: Buffer, entryName: string): Buffer {
  const entry = listZipEntries(archive).find((candidate) => candidate.name === entryName);
  if (!entry) {
    throw new Error(`Zip archive has no entry named ${entryName}`);
  }
  const header = entry.localHeaderOffset;
  if (header + LOCAL_FILE_HEADER_MIN_LENGTH > archive.length
    || archive.readUInt32LE(header) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Malformed zip archive: bad local header for ${entryName}`);
  }
  // Sizes come from the central directory: with a data descriptor (flag bit 3)
  // the local header's own size fields are zero.
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const dataStart = header + LOCAL_FILE_HEADER_MIN_LENGTH + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) {
    throw new Error(`Malformed zip archive: data for ${entryName} out of bounds`);
  }
  const data = archive.subarray(dataStart, dataEnd);

  let content: Buffer;
  if (entry.method === METHOD_STORED) {
    content = Buffer.from(data);
  } else if (entry.method === METHOD_DEFLATE) {
    content = zlib.inflateRawSync(data);
  } else {
    throw new Error(`Unsupported zip compression method ${entry.method} for ${entryName}`);
  }
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`Zip entry ${entryName} decompressed to ${content.length} bytes, expected ${entry.uncompressedSize}`);
  }
  return content;
}
