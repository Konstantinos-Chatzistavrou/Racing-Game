// HID report packing / unpacking from a WebHID report description (the parsed report descriptor), plus the minimal
// WebHID types we use (TypeScript's DOM lib has none). No DOM access here: unit-tested in tools/test_ffb.mjs.
//
// A report is a list of items in descriptor order; each item has reportCount fields of reportSize bits, packed
// little-endian. Variable items carry one value per usage; array items carry the INDEX of the selected usage
// (logicalMinimum + position in the usage list), 0 / out of range = none. Usages are extended: (page << 16) | id.

export interface HIDReportItem {
  isArray?: boolean; isConstant?: boolean; isRange?: boolean;
  usages?: number[]; usageMinimum?: number; usageMaximum?: number;
  reportSize: number; reportCount: number; logicalMinimum: number; logicalMaximum: number;
}
export interface HIDReportInfo { reportId?: number; items?: HIDReportItem[] }
export interface HIDCollectionInfo {
  usagePage?: number; usage?: number; type?: number;
  children?: HIDCollectionInfo[]; inputReports?: HIDReportInfo[]; outputReports?: HIDReportInfo[]; featureReports?: HIDReportInfo[];
}
export interface HIDDevice {
  opened: boolean; vendorId: number; productId: number; productName: string; collections: HIDCollectionInfo[];
  open(): Promise<void>; close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

export const usage = (page: number, id: number) => ((page << 16) | id) >>> 0;
const usagesOf = (it: HIDReportItem): number[] => {
  if (it.isRange && it.usageMinimum !== undefined && it.usageMaximum !== undefined) {
    const out: number[] = [];
    for (let u = it.usageMinimum; u <= it.usageMaximum && out.length < 4096; u++) out.push(u);
    return out;
  }
  return it.usages ?? [];
};

/** Does this report contain a field for usage u (variable) or offer u as an array choice? */
export function hasUsage(r: HIDReportInfo, u: number): boolean {
  return (r.items ?? []).some((it) => !it.isConstant && usagesOf(it).includes(u));
}

/**
 * Pack a report. values: usage -> number for variable fields (clamped to the logical range; negative values in two's
 * complement); select: usages to choose in array fields (the first array item offering a usage takes it).
 */
export function packReport(r: HIDReportInfo, values: Map<number, number>, select: number[] = []): Uint8Array {
  const items = r.items ?? [];
  let bits = 0;
  for (const it of items) bits += it.reportSize * it.reportCount;
  const out = new Uint8Array(Math.ceil(bits / 8));
  let pos = 0;
  const put = (v: number, size: number) => {
    let x = BigInt.asUintN(size, BigInt(Math.trunc(v)));
    for (let b = 0; b < size; b++, pos++) {
      if (x & 1n) out[pos >> 3] |= 1 << (pos & 7);
      x >>= 1n;
    }
  };
  const chosen = new Set<number>();
  for (const it of items) {
    const us = usagesOf(it);
    for (let i = 0; i < it.reportCount; i++) {
      let v = 0;
      if (it.isConstant) v = 0;
      else if (it.isArray) {
        const pick = select.find((u) => !chosen.has(u) && us.includes(u));
        if (pick !== undefined) { chosen.add(pick); v = it.logicalMinimum + us.indexOf(pick); }
      } else {
        const u = us[Math.min(i, us.length - 1)];
        if (u !== undefined && values.has(u)) v = Math.max(it.logicalMinimum, Math.min(it.logicalMaximum, Math.round(values.get(u)!)));
      }
      put(v, it.reportSize);
    }
  }
  return out;
}

/** Unpack a report's variable fields (usage -> value, signed if the logical minimum is negative) and array selections. */
export function unpackReport(r: HIDReportInfo, data: DataView | Uint8Array, offsetBytes = 0): { values: Map<number, number>; selected: number[] } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const values = new Map<number, number>(), selected: number[] = [];
  let pos = offsetBytes * 8;
  const get = (size: number, signed: boolean) => {
    let x = 0n;
    for (let b = 0; b < size; b++, pos++) if (bytes[pos >> 3] & (1 << (pos & 7))) x |= 1n << BigInt(b);
    return Number(signed ? BigInt.asIntN(size, x) : x);
  };
  for (const it of r.items ?? []) {
    const us = usagesOf(it);
    for (let i = 0; i < it.reportCount; i++) {
      const v = get(it.reportSize, it.logicalMinimum < 0);
      if (it.isConstant) continue;
      if (it.isArray) { const k = v - it.logicalMinimum; if (k >= 0 && k < us.length) selected.push(us[k]); }
      else { const u = us[Math.min(i, us.length - 1)]; if (u !== undefined) values.set(u, v); }
    }
  }
  return { values, selected };
}

/** Logical range of the field carrying usage u in report r (for scaling magnitudes / directions). */
export function rangeOf(r: HIDReportInfo, u: number): { min: number; max: number } | null {
  for (const it of r.items ?? []) if (!it.isArray && usagesOf(it).includes(u)) return { min: it.logicalMinimum, max: it.logicalMaximum };
  return null;
}

/** Every report of a kind anywhere in the collection tree, with the usage of the collection it sits in. */
export function allReports(cols: HIDCollectionInfo[], kind: 'outputReports' | 'featureReports' | 'inputReports'): { r: HIDReportInfo; collection: number }[] {
  const out: { r: HIDReportInfo; collection: number }[] = [];
  const walk = (c: HIDCollectionInfo, parent: number) => {
    const cu = c.usagePage !== undefined && c.usage !== undefined ? usage(c.usagePage, c.usage) : parent;
    for (const r of c[kind] ?? []) out.push({ r, collection: cu });
    for (const ch of c.children ?? []) walk(ch, cu);
  };
  for (const c of cols) walk(c, 0);
  return out;
}
