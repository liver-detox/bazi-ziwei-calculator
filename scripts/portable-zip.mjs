// Apple's zip can write UTF-8 path bytes without the ZIP language-encoding flag.
// Normalize both headers so Windows and standard ZIP readers decode them alike.
export function normalizeZipNames(bytes) {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50
    || bytes.readUInt16LE(end + 20) !== 0 || bytes.readUInt32LE(end + 4) !== 0) {
    throw new Error("Unsupported ZIP end record");
  }
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff
    || bytes.readUInt16LE(end + 8) !== count
    || offset + bytes.readUInt32LE(end + 12) !== end) throw new Error("Unsupported ZIP64 or split archive");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central header");
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + length);
    utf8.decode(name);
    const local = bytes.readUInt32LE(offset + 42);
    if (bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 26) !== length
      || !bytes.subarray(local + 30, local + 30 + length).equals(name)
      || (bytes.readUInt16LE(offset + 8) & 1) !== 0) throw new Error("Invalid ZIP local header");
    bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 0x0800, offset + 8);
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 0x0800, local + 6);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (offset !== end) throw new Error("ZIP directory size mismatch");
  return bytes;
}
