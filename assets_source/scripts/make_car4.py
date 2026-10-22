"""Car generation 4 ("Kestrel GT"): a de-branded, re-shaped derivative of "2019 Aston Martin Vantage DTM".

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car4.py -- \
          <2019_aston_martin_vantage_dtm.glb> <out_dir>
Out:  <out_dir>/kestrel_gt_raw.glb (flat materials, no textures), <out_dir>/kestrel_gt.json (numbers for the
      game's visual config), <out_dir>/kestrel_preview.blend

SOURCE AND LICENCE: "2019 Aston Martin Vantage DTM" by Dave Love SketchFab, CC BY 4.0
(https://sketchfab.com/3d-models/2019-aston-martin-vantage-dtm-266d89d6ca944f1baa7ff232a615cfbd;
evidence: assets_source/licenses/downloaded_cars_2026-10-18/). CC BY requires crediting the author and
stating what we changed (CREDITS.md). CC BY does NOT license the manufacturer's or sponsors' marks, so
everything that carries one is removed:
  - the livery atlases (Image_15/16/17: Hankook, Bosch, DEKRA, Baldessarini, DHL/Deutsche Post, Vynamic,
    numbers) are not used; body faces are split into our recolourable 'paint' and black trim from the
    atlas' blurred luminance only, so no decal survives;
  - tyre sidewall (Hankook), rim atlas, plate (Bosch / Aston wings), dash switch labels, cockpit atlas:
    replaced by flat PBR materials; race number and plate meshes deleted.
WHAT MAKES IT OURS (so it is no longer a recognisable copy of the real car):
  - SHAPE(): a smooth deformation (longer, lower nose; cabin pushed back; lower roof; wider rear haunches;
    shorter tail), wheelbase untouched, then a uniform scale to the game's 2.65 m wheelbase;
  - the source's front splitter fins, grille mesh, rear diffuser, wing and taillight units are deleted and
    replaced by our own designs (splitter with plates and canards, slatted grille, finned diffuser, a
    swan-neck wing, LED light bars);
  - flat materials with our paint/trim split; the game's part names (see game/web contract below).
GAME CONTRACT (web/src/scene/car.ts, damage.ts): model space +X left, +Y up, +Z forward (Blender: -Y forward),
  origin on the ground at the body's length centre; wheel_FL/FR/RL/RR empties at the hubs (spin about X),
  caliper_* empties at the hubs (steer only), bumper_front/bumper_rear/mirror_L/mirror_R detachable,
  drl_L/R + beam_L/R front lights, taillight_bar rear light, glass material named 'glass', paint 'paint'.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dtm_build import build  # noqa: E402

CFG = dict(
    name="kestrel_gt",
    remove=["EXT_NUMBER", "INT_PLATE", "DAMAGE_GLASS", "AM_BRAKELIGHTS", "AM_RAINLIGHT"],
    flat={"EXT_WINDOWS": "glass", "EXT_TIRE": "tyre", "EXT_RIMS": "rim", "EXT_DISC": "disc", "EXT_BRAKES": "caliper",
          "EXT_MESH": "trim", "BLACK": "trim", "INT_CARBON": "carbon", "INT_Steer_Carbon": "carbon"},
    interior_prefixes=("INT_", "ASTON_INTERIOR", "T5_"),
    body=("EXT_CARPAINT", "Image_15", 0.16),
    misc=("EXT_MISC", "Image_17", 0.16),
    wheel=dict(tyre=["EXT_TIRE"], rim=["EXT_RIMS"], disc=["EXT_DISC"], caliper=["EXT_BRAKES"]),
    lamps_glass=["EXT_LIGHTS"], lamps_emit=["AM_HEADLIGHTS"],
    lamp_zones=dict(front_z=0.5, rear_y=1.5, rear_z0=0.6, rear_z1=1.0),
    grille=["EXT_MESH"], underbody=["BLACK"], mirror_glass="MIRROR",
    mirror_box=dict(x=0.85, y0=-1.1, y1=0.1, z=0.5),
    zones=dict(front_y=-1.74, front_z=0.5, rear_y=1.74, rear_z=0.42, wing_y=1.3, wing_z=0.95, body_wing_y=2.05, body_wing_z=0.88),
)

if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:]
    build(CFG, args[0], args[1])
