// Close-up probe for tools/drive.mjs (PROBE=web/tools/probe_car.js): freezes the chase camera at a
// fixed spot around the player's car (CAR_VIEW below, car-local metres: +X left, +Y up, +Z forward
// from the CG), waits for the frame, and returns model stats: triangles, geometry/texture memory,
// GLB download sizes and load times, for the hero (player) and traffic (AI car 0) models.
// drive.mjs saves the frame as probe.png. Another view: prepend window.CAR_VIEW = { eye, look }.
(async () => {
  const VIEW = window.CAR_VIEW ?? { eye: [2.9, 0.35, 4.3], look: [0, -0.1, 0.6] };
  const g = window.__game, v = g.visual, cam = g.camera;
  g.rig.update = () => {
    cam.position.set(...VIEW.eye);
    v.root.localToWorld(cam.position);
    const t = v.root.position.clone().set(...VIEW.look);
    v.root.localToWorld(t);
    cam.lookAt(t);
    cam.fov = 40;
    cam.updateProjectionMatrix();
  };
  const stats = (root) => {
    let tris = 0, geo = 0, tex = 0;
    const seenG = new Set(), seenT = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const gm = o.geometry;
      tris += (gm.index ? gm.index.count : gm.attributes.position.count) / 3;
      if (!seenG.has(gm)) {
        seenG.add(gm);
        for (const a of Object.values(gm.attributes)) geo += a.array.byteLength;
        if (gm.index) geo += gm.index.array.byteLength;
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const k of Object.keys(m)) {
          const t = m[k];
          if (!t || !t.isTexture || seenT.has(t)) continue;
          seenT.add(t);
          // compressed: the transcoded mip chain as uploaded; otherwise RGBA8 + 1/3 for mips
          if (t.mipmaps?.length && t.isCompressedTexture) tex += t.mipmaps.reduce((s, mm) => s + mm.data.byteLength, 0);
          else if (t.image?.width) tex += t.image.width * t.image.height * 4 * 1.33;
        }
      }
    });
    return { tris: Math.round(tris), meshes: seenG.size, textures: seenT.size, geometryMB: +(geo / 1048576).toFixed(2), textureMB: +(tex / 1048576).toFixed(2) };
  };
  const res = performance.getEntriesByType('resource').filter((e) => /\.glb|basis_transcoder/.test(e.name))
    .map((e) => `${e.name.split('/').pop()} ${(e.transferSize / 1024).toFixed(0)} KB ${e.duration.toFixed(0)} ms`);
  await new Promise((r) => setTimeout(r, 1500));
  return JSON.stringify({
    hero: stats(v.model), traffic: g.ai.cars[0] ? stats(g.ai.cars[0].model) : null,
    // physics hub in model space (car.ts puts the wheel node there); the model's own hub: y 0.368
    wheelFL: v.model.getObjectByName('wheel_FL')?.position.toArray().map((x) => +x.toFixed(3)),
    aiCars: g.ai.cars.length, renderInfo: { calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles },
    resources: res,
  });
})()
