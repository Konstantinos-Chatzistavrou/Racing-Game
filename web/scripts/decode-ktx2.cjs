#!/usr/bin/env node
// Decode a KTX2/basisu GLB into a PNG-textured GLB that Blender can import.
//   npm i basis_universal        (once; ships the basisu CLI)
//   node scripts/decode-ktx2.cjs <in.glb> <out.glb>
// How it works: every image is extracted, decoded with `basisu -unpack` (writes into its cwd), the largest PNG
// (mip 0) is appended to the binary chunk, the image views are repointed at the PNGs and KHR_texture_basisu is
// dropped from the asset, so a plain glTF importer sees ordinary PNG textures.
const fs = require('fs'), cp = require('child_process'), path = require('path'), os = require('os');
const SRC = process.argv[2], DST = process.argv[3] || SRC.replace(/\.glb$/i, '_png.glb');
if (!SRC) { console.error('usage: node scripts/decode-ktx2.cjs <in.glb> [out.glb]'); process.exit(2); }
const BIN = process.env.BASISU || path.join(process.cwd(), 'node_modules/basis_universal/bin/basisu');
const b = fs.readFileSync(SRC);
let o = 12, j = null, bin = null;
while (o < b.length) {
  const l = b.readUInt32LE(o), t = b.readUInt32LE(o + 4);
  if (t === 0x4E4F534A) j = JSON.parse(b.subarray(o + 8, o + 8 + l).toString('utf8'));
  else if (t === 0x004E4942) bin = Buffer.from(b.subarray(o + 8, o + 8 + l));
  o += 8 + l;
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ktx2-'));
const views = j.bufferViews;
let outBin = Buffer.from(bin), tail = bin.length, decoded = 0;
(j.images || []).forEach((img, i) => {
  const bv = views[img.bufferView], start = bv.byteOffset || 0;
  const kf = path.join(work, i + '.ktx2');
  fs.writeFileSync(kf, bin.subarray(start, start + bv.byteLength));
  const d = path.join(work, 'o' + i);
  fs.mkdirSync(d, { recursive: true });
  try { cp.execFileSync(BIN, ['-unpack', kf], { cwd: d, stdio: 'ignore' }); } catch { return; }
  const pngs = fs.readdirSync(d).filter((f) => f.endsWith('.png'))
    .map((f) => ({ f, s: fs.statSync(path.join(d, f)).size })).sort((a, b2) => b2.s - a.s);
  if (!pngs.length) return;
  const png = fs.readFileSync(path.join(d, pngs[0].f));
  const pad = (4 - (tail % 4)) % 4;
  if (pad) { outBin = Buffer.concat([outBin, Buffer.alloc(pad)]); tail += pad; }
  views.push({ buffer: 0, byteOffset: tail, byteLength: png.length });
  outBin = Buffer.concat([outBin, png]); tail += png.length;
  img.bufferView = views.length - 1; img.mimeType = 'image/png'; delete img.extensions;
  decoded++;
});
for (const t of j.textures || []) {
  if (t.extensions && t.extensions.KHR_texture_basisu) { t.source = t.extensions.KHR_texture_basisu.source; delete t.extensions; }
}
for (const k of ['extensionsUsed', 'extensionsRequired']) if (j[k]) j[k] = j[k].filter((e) => e !== 'KHR_texture_basisu');
j.buffers = [{ byteLength: outBin.length }];
const jb = Buffer.from(JSON.stringify(j), 'utf8'), jpad = Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20), bpad = Buffer.alloc((4 - (outBin.length % 4)) % 4);
const h1 = Buffer.alloc(8); h1.writeUInt32LE(jb.length + jpad.length, 0); h1.writeUInt32LE(0x4E4F534A, 4);
const h2 = Buffer.alloc(8); h2.writeUInt32LE(outBin.length + bpad.length, 0); h2.writeUInt32LE(0x004E4942, 4);
const body = Buffer.concat([h1, jb, jpad, h2, outBin, bpad]);
const head = Buffer.alloc(12); head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
fs.writeFileSync(DST, Buffer.concat([head, body]));
console.log('decoded ' + decoded + ' of ' + (j.images || []).length + ' textures -> ' + DST + ' (' + ((12 + body.length) / 1e6).toFixed(2) + ' MB)');
