// Force feedback protocol tests without hardware: the exact bytes the drivers send.
//   - Logitech classic commands (constant force, autocentre off, stop, rotation range)
//   - HID report packing / unpacking (bit fields, signed values, array selections)
//   - PidDriver against a fake USB HID PID wheel whose descriptor follows the PID 1.0 specification's
//     example layout (Set Effect, Set Constant Force, Effect Operation, Device Control, Device Gain,
//     Create New Effect + PID Block Load feature reports): the init sequence and the force sign
// Usage: node tools/test_ffb.mjs   (exit code 1 on failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbtest-'));
// transpile src/ffb/{report,drivers}.ts to ES modules (relative imports get .mjs)
for (const f of ['report', 'drivers']) {
  const src = fs.readFileSync(path.join(here, '../src/ffb', f + '.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from '\.\/(\w+)'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(tmp, f + '.mjs'), js);
}
const R = await import(pathToFileURL(path.join(tmp, 'report.mjs')).href);
const D = await import(pathToFileURL(path.join(tmp, 'drivers.mjs')).href);
fs.rmSync(tmp, { recursive: true, force: true });

let fails = 0, checks = 0;
const hex = (b) => [...(b ?? [])].map((x) => x.toString(16).padStart(2, '0')).join(' ');
function eq(name, got, want) {
  checks++;
  const g = Array.isArray(want) || want instanceof Uint8Array ? hex(got) : String(got), w = Array.isArray(want) || want instanceof Uint8Array ? hex(want) : String(want);
  if (g !== w) { fails++; console.log(`FAIL ${name}: got [${g}] want [${w}]`); }
}

// ---- Logitech classic ------------------------------------------------------------------------------------------------
const L = D.LogitechClassic;
eq('logi zero', L.constantForce(0), [0x11, 0x08, 0x80, 0x80, 0, 0, 0]);
eq('logi full left', L.constantForce(1), [0x11, 0x08, 0x01, 0x80, 0, 0, 0]);
eq('logi full right', L.constantForce(-1), [0x11, 0x08, 0xff, 0x80, 0, 0, 0]);
eq('logi clamp', L.constantForce(5), [0x11, 0x08, 0x01, 0x80, 0, 0, 0]);
eq('logi autocentre off', L.autocenterOff(), [0xf5, 0, 0, 0, 0, 0, 0]);
eq('logi stop all', L.stopAll(), [0xf3, 0, 0, 0, 0, 0, 0]);
eq('logi range 900', L.range(900), [0xf8, 0x81, 0x84, 0x03, 0, 0, 0]);
eq('logi range 200', L.range(200), [0xf8, 0x81, 0xc8, 0x00, 0, 0, 0]);
eq('logi range clamp', L.range(5000), [0xf8, 0x81, 0x84, 0x03, 0, 0, 0]);
{
  const sent = [];
  const dev = { sendReport: async (id, b) => sent.push([id, ...new Uint8Array(b)]) };
  const drv = new L(dev, 0xc24f);
  await drv.init();
  await drv.setForce(0.5);
  await drv.setForce(0.5);          // unchanged: no report
  await drv.setRange(540);
  await drv.stop();
  eq('logi sequence count', sent.length, 6);
  eq('logi init[0]', sent[0], [0, 0xf5, 0, 0, 0, 0, 0, 0]);
  eq('logi force 0.5', sent[2], [0, 0x11, 0x08, 0x41, 0x80, 0, 0, 0]);   // 0x80 - 0.5 * 0x7f = 64.5 -> 65
  eq('logi range 540', sent[3], [0, 0xf8, 0x81, 0x1c, 0x02, 0, 0, 0]);
  const dfp = new L({ sendReport: async (id, b) => sent.push([id, ...new Uint8Array(b)]) }, 0xc294);
  const n = sent.length; await dfp.setRange(540);
  eq('logi no range on old wheels', sent.length, n);
}

// ---- report packing ---------------------------------------------------------------------------------------------------
const PID = 0x0f, GD = 0x01, ORD = 0x0a;
const u = R.usage;
const v = (us, size, min, max, count = us.length) => ({ usages: us.map((x) => u(...x)), reportSize: size, reportCount: count, logicalMinimum: min, logicalMaximum: max });
const arr = (us, size, min, max, count = 1) => ({ ...v(us, size, min, max, count), isArray: true });
const pad = (size) => ({ isConstant: true, usages: [], reportSize: size, reportCount: 1, logicalMinimum: 0, logicalMaximum: 0 });

const constRep = { reportId: 5, items: [v([[PID, 0x22]], 8, 1, 40), v([[PID, 0x70]], 16, -10000, 10000)] };
eq('pack constant -5000', R.packReport(constRep, new Map([[u(PID, 0x22), 1], [u(PID, 0x70), -5000]])), [0x01, 0x78, 0xec]);
eq('pack constant clamp', R.packReport(constRep, new Map([[u(PID, 0x22), 1], [u(PID, 0x70), 99999]])), [0x01, 0x10, 0x27]);
{
  const { values } = R.unpackReport(constRep, new Uint8Array([0x02, 0x78, 0xec]));
  eq('unpack signed', values.get(u(PID, 0x70)), -5000);
  eq('unpack block', values.get(u(PID, 0x22)), 2);
}
// bit fields that don't fill bytes: 2 x 1-bit axes, 1-bit direction enable, 5-bit pad, then a 16-bit value
const bits = { items: [v([[GD, 0x30], [GD, 0x31]], 1, 0, 1), v([[PID, 0x56]], 1, 0, 1), pad(5), v([[PID, 0x50]], 16, 0, 32767)] };
eq('pack bits', R.packReport(bits, new Map([[u(GD, 0x30), 1], [u(PID, 0x56), 1], [u(PID, 0x50), 0x1234]])), [0x05, 0x34, 0x12]);
const opRep = { reportId: 10, items: [v([[PID, 0x22]], 8, 1, 40), arr([[PID, 0x79], [PID, 0x7a], [PID, 0x7b]], 8, 1, 3), v([[PID, 0x7c]], 8, 0, 255)] };
eq('pack array start', R.packReport(opRep, new Map([[u(PID, 0x22), 3], [u(PID, 0x7c), 1]]), [u(PID, 0x79)]), [3, 1, 1]);
eq('pack array stop', R.packReport(opRep, new Map([[u(PID, 0x22), 3]]), [u(PID, 0x7b)]), [3, 3, 0]);
eq('pack array none', R.packReport(opRep, new Map(), []), [0, 0, 0]);
{
  const ranged = { items: [{ isArray: true, isRange: true, usageMinimum: u(PID, 0x97), usageMaximum: u(PID, 0x9c), reportSize: 8, reportCount: 1, logicalMinimum: 1, logicalMaximum: 6 }] };
  eq('pack usage range', R.packReport(ranged, new Map(), [u(PID, 0x9a)]), [4]);
  eq('unpack usage range', R.unpackReport(ranged, new Uint8Array([4])).selected[0], u(PID, 0x9a));
}

// ---- PID driver against a fake wheel ------------------------------------------------------------------------------------
const setEffect = { reportId: 1, items: [
  v([[PID, 0x22]], 8, 1, 40),
  arr([[PID, 0x26], [PID, 0x27], [PID, 0x30], [PID, 0x31], [PID, 0x32], [PID, 0x33], [PID, 0x34], [PID, 0x40], [PID, 0x41], [PID, 0x42], [PID, 0x43], [PID, 0x28]], 8, 1, 12),
  v([[PID, 0x50], [PID, 0x54], [PID, 0x51], [PID, 0xa7]], 16, 0, 32767),
  v([[PID, 0x52]], 8, 0, 255), v([[PID, 0x53]], 8, 1, 8),
  v([[GD, 0x30], [GD, 0x31]], 1, 0, 1), v([[PID, 0x56]], 1, 0, 1), pad(5),
  v([[ORD, 1], [ORD, 2]], 16, 0, 35999),
] };
const control = { reportId: 12, items: [arr([[PID, 0x97], [PID, 0x98], [PID, 0x99], [PID, 0x9a], [PID, 0x9b], [PID, 0x9c]], 8, 1, 6)] };
const gain = { reportId: 13, items: [v([[PID, 0x7e]], 8, 0, 255)] };
const create = { reportId: 0x11, items: [arr([[PID, 0x26], [PID, 0x27]], 8, 1, 12), v([[PID, 0xac]], 16, 0, 511)] };
const blockLoad = { reportId: 0x12, items: [v([[PID, 0x22]], 8, 1, 40), arr([[PID, 0x8c], [PID, 0x8d], [PID, 0x8e]], 8, 1, 3), v([[PID, 0xac]], 16, 0, 65535)] };
const collections = [{ usagePage: GD, usage: 0x04, children: [{ usagePage: PID, usage: 0x21, outputReports: [setEffect] }],
  inputReports: [], outputReports: [constRep, opRep, control, gain], featureReports: [create, blockLoad] }];
{
  eq('supportsPid yes', D.supportsPid({ collections }), true);
  eq('supportsPid no', D.supportsPid({ collections: [{ outputReports: [{ reportId: 0, items: [v([[0xff00, 1]], 8, 0, 255)] }] }] }), false);
  const out = [], feat = [];
  const dev = {
    collections,
    sendReport: async (id, b) => out.push([id, ...new Uint8Array(b)]),
    sendFeatureReport: async (id, b) => feat.push([id, ...new Uint8Array(b)]),
    receiveFeatureReport: async () => new DataView(new Uint8Array([0x12, 3, 1, 0, 0]).buffer),   // block 3, load success
  };
  const drv = new D.PidDriver(dev);
  await drv.init();
  eq('pid reset', out[0], [12, 4]);
  eq('pid enable', out[1], [12, 1]);
  eq('pid gain', out[2], [13, 255]);
  eq('pid create', feat[0], [0x11, 1, 0, 0]);
  // set effect: block 3, constant (1), duration 32767 (max = infinite on most firmware), repeat 0, sample 0, delay 0, gain 255,
  // trigger 8 (= none), X axis on, direction enable, direction 9000 (90 deg) on ordinal 1 (ordinal 2 unused with one axis)
  eq('pid set effect', out[3], [1, 3, 1, 0xff, 0x7f, 0, 0, 0, 0, 0, 0, 255, 8, 0x05, 0x28, 0x23, 0, 0]);
  eq('pid constant 0', out[4], [5, 3, 0, 0]);
  eq('pid start', out[5], [10, 3, 1, 1]);
  await drv.setForce(0.5);
  eq('pid left = -X', out[6], [5, 3, 0x78, 0xec]);
  await drv.setForce(-1);
  eq('pid right = +X full', out[7], [5, 3, 0x10, 0x27]);
  await drv.setForce(-1);
  eq('pid unchanged not resent', out.length, 8);
  await drv.stop();
  eq('pid stop: zero', out[8], [5, 3, 0, 0]);
  eq('pid stop: op stop', out[9], [10, 3, 3, 1]);
  eq('pid stop: stop all', out[10], [12, 3]);
  // a device without a block pool: falls back to block 1
  const dev2 = { ...dev, collections: [{ outputReports: [constRep, opRep, setEffect] }], receiveFeatureReport: async () => { throw new Error('no'); } };
  out.length = 0;
  await new D.PidDriver(dev2).init();
  eq('pid block 1 fallback', out[0][1], 1);
}

console.log(`${checks - fails}/${checks} force-feedback checks passed`);
process.exit(fails ? 1 : 0);
