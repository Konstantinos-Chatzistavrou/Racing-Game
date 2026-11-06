// Photorealistic 2048x2048 CanvasTexture atlas for Times Square LED megascreens & NYC storefront signage.
// Layout (UV y=1 is top of canvas with flipY=true):
//   Rows 0..3 (top 1536 px, 4 rows x 2 cols of 1024x384 px each): 8 Times Square LED mega-billboards (kinds 0..7)
//   Rows 4..5 (bottom 512 px, 4 rows x 2 cols of 1024x128 px each): 8 NYC street-level storefront & neon signs (kinds 0..7)
import * as THREE from 'three/webgpu';

let cachedAtlas: THREE.CanvasTexture | null = null;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBillboard(ctx: CanvasRenderingContext2D, idx: number, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);

  if (idx === 0) {
    // 0: LUXURY FASHION / PARFUMS EDITORIAL ("MAISON NOIR PARIS // NEW YORK")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#07080c');
    bg.addColorStop(0.55, '#181210');
    bg.addColorStop(1, '#2b1b12');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Warm golden studio key light glow
    const glow = ctx.createRadialGradient(w * 0.68, h * 0.48, 10, w * 0.68, h * 0.48, h * 0.78);
    glow.addColorStop(0, 'rgba(255, 206, 138, 0.92)');
    glow.addColorStop(0.45, 'rgba(214, 134, 66, 0.38)');
    glow.addColorStop(1, 'rgba(10, 8, 12, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Luxury glass perfume flacon with refraction highlights
    const bx = w * 0.63, by = h * 0.24, bw = w * 0.14, bh = h * 0.56;
    const flacon = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    flacon.addColorStop(0, '#fff3d1');
    flacon.addColorStop(0.3, '#d4943a');
    flacon.addColorStop(0.7, '#7a4514');
    flacon.addColorStop(1, '#f7c873');
    ctx.fillStyle = flacon;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,245,220,0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner amber liquid + black & gold label
    ctx.fillStyle = '#0c0b0e';
    ctx.fillRect(bx + bw * 0.18, by + bh * 0.28, bw * 0.64, bh * 0.36);
    ctx.strokeStyle = '#e5b869';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + bw * 0.18, by + bh * 0.28, bw * 0.64, bh * 0.36);
    ctx.fillStyle = '#f8e3b4';
    ctx.font = '700 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('N° 5', bx + bw * 0.5, by + bh * 0.49);

    // Bottle cap
    ctx.fillStyle = '#e8c47c';
    ctx.fillRect(bx + bw * 0.32, by - bh * 0.16, bw * 0.36, bh * 0.15);

    // Editorial typography on left
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6c280';
    ctx.font = '600 18px "Inter", "Helvetica Neue", sans-serif';
    ctx.fillText('FIFTH AVENUE FLAGSHIP · PARIS · NEW YORK', 54, 68);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 68px Georgia, "Times New Roman", serif';
    ctx.fillText('L’OR DE NUIT', 52, 152);
    ctx.fillStyle = 'rgba(255,240,215,0.85)';
    ctx.font = '300 28px Georgia, serif';
    ctx.fillText('EAU DE PARFUM INTENSE', 54, 198);
    ctx.fillStyle = '#d4af37';
    ctx.fillRect(54, 224, 190, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '500 20px "Inter", sans-serif';
    ctx.fillText('MAISON VALENTIN · 725 FIFTH AVE', 54, 326);
  } else if (idx === 1) {
    // 1: BROADWAY MUSICAL MARQUEE ("METROPOLIS LIVE ON BROADWAY")
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.65);
    bg.addColorStop(0, '#8f111d');
    bg.addColorStop(0.55, '#42060d');
    bg.addColorStop(1, '#120205');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Chase bulb marquee border
    ctx.strokeStyle = '#f5be4f';
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.fillStyle = '#fff1b8';
    for (let bx = 28; bx < w - 24; bx += 28) {
      ctx.beginPath(); ctx.arc(bx, 18, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(bx, h - 18, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    for (let by = 36; by < h - 24; by += 28) {
      ctx.beginPath(); ctx.arc(18, by, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(w - 18, by, 4.5, 0, Math.PI * 2); ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd97d';
    ctx.font = '700 22px "Inter", sans-serif';
    ctx.fillText('★ WINNER OF 9 TONY AWARDS · IMPERIAL THEATRE · W 45TH ST ★', w * 0.5, 76);

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 195, 75, 0.85)';
    ctx.shadowBlur = 24;
    ctx.font = '900 84px "Impact", "Arial Black", sans-serif';
    ctx.fillText('EMPIRE OF LIGHTS', w * 0.5, 188);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#ffcf70';
    ctx.font = '700 30px Georgia, serif';
    ctx.fillText('“THE MOST ELECTRIFYING NIGHT ON BROADWAY” — THE NEW YORK TIMES', w * 0.5, 246);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w * 0.32, 278, w * 0.36, 52);
    ctx.fillStyle = '#5a0812';
    ctx.font = '800 24px "Inter", sans-serif';
    ctx.fillText('TONIGHT AT 8:00 PM · TICKETS AT BOX OFFICE', w * 0.5, 312);
  } else if (idx === 2) {
    // 2: NASDAQ / GLOBAL MARKETS LIVE FINANCIAL TOWER
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#040d1a');
    bg.addColorStop(0.5, '#071b30');
    bg.addColorStop(1, '#030912');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Subtle cyber grid
    ctx.strokeStyle = 'rgba(38, 150, 235, 0.16)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (let gy = 0; gy < h; gy += 36) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    // Header bar
    ctx.fillStyle = '#0b2d4f';
    ctx.fillRect(0, 0, w, 58);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '800 26px "Inter", sans-serif';
    ctx.fillText('TIMES SQUARE MARKETSITE // GLOBAL INDICES LIVE', 36, 38);

    //Glowing area chart on right half
    ctx.save();
    ctx.beginPath();
    const cx0 = w * 0.48, cy0 = 80, cw = w * 0.48, ch = 190;
    const pts = [0.68, 0.62, 0.65, 0.54, 0.48, 0.52, 0.38, 0.41, 0.28, 0.22, 0.26, 0.14];
    ctx.moveTo(cx0, cy0 + ch);
    for (let i = 0; i < pts.length; i++) {
      ctx.lineTo(cx0 + (i / (pts.length - 1)) * cw, cy0 + pts[i] * ch);
    }
    ctx.lineTo(cx0 + cw, cy0 + ch);
    ctx.closePath();
    const cg = ctx.createLinearGradient(0, cy0, 0, cy0 + ch);
    cg.addColorStop(0, 'rgba(16, 235, 138, 0.55)');
    cg.addColorStop(1, 'rgba(16, 235, 138, 0.02)');
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = '#10eb8a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = cx0 + (i / (pts.length - 1)) * cw, py = cy0 + pts[i] * ch;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // Ticker rows on left
    const rows = [
      ['NDX 100', '20,842.65', '+1.84%'],
      ['S&P 500', '5,914.20', '+1.12%'],
      ['NVDA', '142.88', '+4.65%'],
      ['AAPL', '234.50', '+1.92%'],
    ];
    rows.forEach(([sym, val, chg], i) => {
      const ry = 104 + i * 44;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 26px monospace';
      ctx.fillText(sym, 36, ry);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(val, 190, ry);
      ctx.fillStyle = '#10eb8a';
      ctx.fillText(chg, 355, ry);
    });

    // Bottom ticker ribbon
    ctx.fillStyle = '#061527';
    ctx.fillRect(0, h - 68, w, 68);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 24px monospace';
    ctx.fillText('▲ MSFT 448.10 (+1.4%)   ▲ AMZN 212.40 (+2.1%)   ▲ GOOGL 189.30 (+1.7%)   ▲ META 612.00 (+2.9%)', 32, h - 26);
  } else if (idx === 3) {
    // 3: TECH FLAGSHIP SMARTPHONE LAUNCH ("AETHER 16 PRO · TITANIUM")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#05070e');
    bg.addColorStop(0.5, '#0c182e');
    bg.addColorStop(1, '#060a14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Sleek angled smartphone hardware silhouette
    ctx.save();
    ctx.translate(w * 0.7, h * 0.54);
    ctx.rotate(-0.22);
    const pw = 210, ph = 320;
    const frameG = ctx.createLinearGradient(-pw / 2, -ph / 2, pw / 2, ph / 2);
    frameG.addColorStop(0, '#e2e8f0');
    frameG.addColorStop(0.4, '#475569');
    frameG.addColorStop(1, '#94a3b8');
    ctx.fillStyle = frameG;
    roundRect(ctx, -pw / 2 - 6, -ph / 2 - 6, pw + 12, ph + 12, 32);
    ctx.fill();

    const scrG = ctx.createLinearGradient(-pw / 2, -ph / 2, pw / 2, ph / 2);
    scrG.addColorStop(0, '#0284c7');
    scrG.addColorStop(0.45, '#38bdf8');
    scrG.addColorStop(0.75, '#1e1b4b');
    scrG.addColorStop(1, '#f43f5e');
    ctx.fillStyle = scrG;
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, 26);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 20px "Inter", sans-serif';
    ctx.fillText('NEW YORK FIFTH AVENUE CUBE', 56, 78);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 68px "Inter", "Helvetica Neue", sans-serif';
    ctx.fillText('Aether 16 Pro', 54, 158);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '400 32px "Inter", sans-serif';
    ctx.fillText('Forged in grade-5 titanium. Built for night.', 56, 212);
    ctx.fillStyle = '#38bdf8';
    roundRect(ctx, 56, 256, 240, 52, 26);
    ctx.fill();
    ctx.fillStyle = '#030712';
    ctx.font = '800 22px "Inter", sans-serif';
    ctx.fillText('AVAILABLE NOW', 88, 290);
  } else if (idx === 4) {
    // 4: ICONIC RED & WHITE BEVERAGE WAVE ("SOLARIS COLA · REAL TASTE")
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#6b040b');
    bg.addColorStop(0.45, '#d90718');
    bg.addColorStop(1, '#85050f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Dynamic white silk wave
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.72);
    ctx.bezierCurveTo(w * 0.3, h * 0.42, w * 0.62, h * 0.96, w, h * 0.58);
    ctx.lineTo(w, h * 0.78);
    ctx.bezierCurveTo(w * 0.62, h * 1.12, w * 0.3, h * 0.58, 0, h * 0.88);
    ctx.closePath();
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 86px Georgia, "Times New Roman", serif';
    ctx.fillText('Solaris Classic', w * 0.5, 156);
    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillText('ICE COLD · ZERO SUGAR · TIMES SQUARE EDITION', w * 0.5, 214);
  } else if (idx === 5) {
    // 5: AUTOMOTIVE / SUPERCAR WORLD SERIES ("OPEN GRID // MIDTOWN GP")
    const bg = ctx.createLinearGradient(0, 0, w, 0);
    bg.addColorStop(0, '#07090e');
    bg.addColorStop(0.55, '#111827');
    bg.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Diagonal racing speed stripes
    ctx.fillStyle = '#ff2a4b';
    ctx.beginPath();
    ctx.moveTo(w * 0.58, 0); ctx.lineTo(w * 0.66, 0); ctx.lineTo(w * 0.52, h); ctx.lineTo(w * 0.44, h);
    ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(w * 0.68, 0); ctx.lineTo(w * 0.72, 0); ctx.lineTo(w * 0.58, h); ctx.lineTo(w * 0.54, h);
    ctx.fill();

    ctx.fillStyle = '#ff2a4b';
    ctx.font = '800 22px "Inter", sans-serif';
    ctx.fillText('FIA GT WORLD STREET SERIES · NEW YORK', 48, 72);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 76px "Impact", "Arial Black", sans-serif';
    ctx.fillText('OPEN GRID GP', 48, 166);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillText('VELA GT-R · 9,000 RPM NATURALLY ASPIRATED', 48, 224);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px monospace';
    ctx.fillText('7TH AVE · BROADWAY · 5TH AVE · 34TH ST CIRCUIT', 48, 318);
  } else if (idx === 6) {
    // 6: 24-HOUR LIVE NETWORK NEWS & WEATHER ("NY1 / METRO NEWS HD")
    ctx.fillStyle = '#08142c';
    ctx.fillRect(0, 0, w, h);

    // Studio skyline accent
    const sg = ctx.createLinearGradient(0, 0, w, h * 0.7);
    sg.addColorStop(0, '#0f295c');
    sg.addColorStop(1, '#1d4ed8');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h * 0.68);

    // "LIVE" badge
    ctx.fillStyle = '#dc2626';
    roundRect(ctx, 42, 34, 118, 44, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px "Inter", sans-serif';
    ctx.fillText('● LIVE', 60, 65);
    ctx.fillStyle = '#93c5fd';
    ctx.font = '700 24px "Inter", sans-serif';
    ctx.fillText('MANHATTAN SKYLINE CAM · MIDTOWN WEST 54°F', 182, 65);

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 58px "Inter", sans-serif';
    ctx.fillText('MIDTOWN NIGHT GRAND PRIX', 42, 156);
    ctx.fillStyle = '#fde047';
    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillText('SEVENTH AVENUE & TIMES SQUARE CORRIDOR CLOSED FOR STREET CIRCUIT', 42, 210);

    // Lower third breaking news banner
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(0, h - 110, w, 54);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 26px "Inter", sans-serif';
    ctx.fillText('BREAKING NEWS   RECORD LAP TIMES SET ACROSS RAIN-SLICKED SEVENTH AVENUE', 42, h - 74);

    // Bottom yellow ticker
    ctx.fillStyle = '#facc15';
    ctx.fillRect(0, h - 56, w, 56);
    ctx.fillStyle = '#090d16';
    ctx.font = '800 24px monospace';
    ctx.fillText('TRANSIT: 1/2/3 N/Q/R/W ON TIME · FDR DRIVE CLEAR · WEATHER: LIGHT RAIN ENDING · 54°F', 42, h - 20);
  } else {
    // 7: IMAX 70MM BLOCKBUSTER KEY ART ("SHADOW OVER MANHATTAN")
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#041f2e');
    bg.addColorStop(0.55, '#0c3b4f');
    bg.addColorStop(0.75, '#7c2d12');
    bg.addColorStop(1, '#090a0f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Anamorphic orange horizon flare
    const fl = ctx.createRadialGradient(w * 0.5, h * 0.56, 8, w * 0.5, h * 0.56, w * 0.55);
    fl.addColorStop(0, 'rgba(255, 180, 90, 0.95)');
    fl.addColorStop(0.35, 'rgba(249, 115, 22, 0.45)');
    fl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fl;
    ctx.fillRect(0, h * 0.32, w, h * 0.48);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '600 20px "Inter", sans-serif';
    ctx.fillText('FILMED FOR IMAX 70MM · AMC EMPIRE 25 TIMES SQUARE', w * 0.5, 68);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 76px "Inter", "Arial Black", sans-serif';
    ctx.fillText('REDLINE MANHATTAN', w * 0.5, 178);
    ctx.fillStyle = '#fed7aa';
    ctx.font = '700 26px "Inter", sans-serif';
    ctx.fillText('EVERY STREET HAS A PRICE · IN THEATRES FRIDAY', w * 0.5, 232);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.65)';
    ctx.font = '500 15px monospace';
    ctx.fillText('METRO PICTURES PRESENTS A NIGHT RUN PRODUCTION "REDLINE MANHATTAN" SOUNDTRACK AVAILABLE IN DOLBY ATMOS', w * 0.5, 342);
  }

  ctx.restore();
}

function drawShopSign(ctx: CanvasRenderingContext2D, idx: number, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x, y);

  const specs: { bg: string; border: string; fg: string; sub: string; title: string; tag: string }[] = [
    { bg: '#0c111d', border: '#38bdf8', fg: '#ffffff', sub: '#38bdf8', title: 'DUANE READE · PHARMACY', tag: '24 HOUR PRESCRIPTIONS · MARKET' },
    { bg: '#16090b', border: '#f59e0b', fg: '#fde68a', sub: '#f87171', title: 'BROADWAY ARTISAN PIZZA', tag: 'COAL FIRED BRICK OVEN · EST. 1964' },
    { bg: '#091410', border: '#34d399', fg: '#ecfdf5', sub: '#6ee7b7', title: 'MIDTOWN GOURMET DELI', tag: 'BOAR’S HEAD · HOT GRILL · COFFEE 24HR' },
    { bg: '#0a0d18', border: '#60a5fa', fg: '#ffffff', sub: '#93c5fd', title: 'METRO NATIONAL BANK', tag: '24H ATM · PRIVATE CLIENT · VAULT' },
    { bg: '#14110c', border: '#d4af37', fg: '#fffbeb', sub: '#fcd34d', title: 'TOURNEAU & CO. HOROLOGY', tag: 'FINE SWISS TIMEPIECES · FIFTH AVE' },
    { bg: '#110c18', border: '#f472b6', fg: '#fdf2f8', sub: '#f9a8d4', title: 'PARAMOUNT LOUNGE & BAR', tag: 'LIVE JAZZ · COCKTAILS · LATE KITCHEN' },
    { bg: '#0e1318', border: '#e2e8f0', fg: '#f8fafc', sub: '#94a3b8', title: 'BLUE BOTTLE ESPRESSO', tag: 'SINGLE ORIGIN ROASTERS · BAKERY' },
    { bg: '#180c0c', border: '#ef4444', fg: '#ffffff', sub: '#fca5a5', title: 'TIMES SQUARE ELECTRONICS', tag: 'CAMERAS · AUDIO · LENSES · DUTY FREE' },
  ];
  const s = specs[idx % specs.length];
  ctx.fillStyle = s.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = s.border;
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, w - 16, h - 16);

  ctx.textAlign = 'center';
  ctx.fillStyle = s.fg;
  ctx.shadowColor = s.border;
  ctx.shadowBlur = 12;
  ctx.font = '800 44px "Inter", "Helvetica Neue", Arial, sans-serif';
  ctx.fillText(s.title, w * 0.5, 64);
  ctx.shadowBlur = 0;

  ctx.fillStyle = s.sub;
  ctx.font = '700 20px "Inter", monospace';
  ctx.fillText(s.tag, w * 0.5, 102);

  ctx.restore();
}

export function getSignAtlasTexture(): THREE.CanvasTexture {
  if (cachedAtlas) return cachedAtlas;
  const W = 2048, H = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);

  // Top 1536 px: 4 rows x 2 cols of 1024x384 billboards (indices 0..7)
  for (let i = 0; i < 8; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawBillboard(ctx, i, col * 1024, row * 384, 1024, 384);
  }
  // Bottom 512 px: 4 rows x 2 cols of 1024x128 storefront signs (indices 0..7)
  for (let i = 0; i < 8; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawShopSign(ctx, i, col * 1024, 1536 + row * 128, 1024, 128);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cachedAtlas = tex;
  return tex;
}
