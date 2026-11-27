// A minimal, reproducible zip writer: the same files always give the same bytes (fixed timestamps, sorted names,
// deflate at a fixed level), so a rebuild without changes leaves the committed add-on zip untouched.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;        // 1980-01-01 00:00

/** Zips the files directly inside `dir` (no subfolders) into `out`. */
function zipDir(out, dir) {
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();
  const local = [], central = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(dir, name));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const fname = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(fname.length, 26);
    local.push(head, fname, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(fname.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, fname);
    offset += head.length + fname.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...local, cdBuf, end]));
}

module.exports = { zipDir };
