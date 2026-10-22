"""Car generation 4b ("Harrier GT"): a de-branded, re-shaped derivative of "2018 Mercedes C-Coupé DTM".

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car5.py -- \
          <2018_mercedes_c-coupe_dtm.glb> <out_dir>

SOURCE AND LICENCE: "2018 Mercedes C-Coupé DTM" by Dave Love SketchFab, CC BY 4.0
(https://sketchfab.com/3d-models/2018-mercedes-c-coupe-dtm-5708f2acc5ef40839b6eb50970e1c173; evidence:
assets_source/licenses/downloaded_cars_2026-10-18/). CC BY does not license the manufacturer's or sponsors'
marks (Mercedes-AMG, Petronas Syntium, Remus, Hankook ...): the livery atlas, tyre sidewalls, plates and number are
not used, the signature parts are replaced; see dtm_build.py and make_car4.py for the full list of what is changed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dtm_build import build  # noqa: E402

CFG = dict(
    name="harrier_gt",
    remove=["EXT_Number", "INT_Driver_Plate", "INT_Plate", "DAMAGE_GLASS", "EXT_Rim_Blur"],
    flat={"EXT_Windows": "glass", "EXT_Windows_Frame": "trim", "EXT_Tire": "tyre", "EXT_Tire_Tread": "tyre", "EXT_Tire_Inside": "tyre",
          "EXT_Rims": "rim", "EXT_Rim_Hub": "rim", "EXT_Disc": "disc", "EXT_Brakes": "caliper", "EXT_Mesh": "trim", "INT_Carbon": "carbon"},
    interior_prefixes=("INT_", "T5_"),
    interior_max_polys=5000,
    body=("EXT_CarPaint", "Image_0", 0.10),
    misc=("EXT_Misc", "Image_1", 0.10),
    wheel=dict(tyre=["EXT_Tire", "EXT_Tire_Tread", "EXT_Tire_Inside"], rim=["EXT_Rims", "EXT_Rim_Hub"], disc=["EXT_Disc"], caliper=["EXT_Brakes"]),
    lamps_glass=["EXT_Lights", "EXT_Lights_A"], lamps_emit=[],
    lamp_zones=dict(front_z=0.38, rear_y=1.5, rear_z0=0.55, rear_z1=1.0),
    grille=["EXT_Mesh"], underbody=[], mirror_glass="Mirror",
    mirror_box=dict(x=0.85, y0=-1.1, y1=0.1, z=0.5),
    zones=dict(front_y=-1.74, front_z=0.68, rear_y=1.74, rear_z=0.42, wing_y=1.3, wing_z=0.95, body_wing_y=2.05, body_wing_z=0.88),
    body_cut=dict(x=0.55, y=-2.05, z0=0.38, z1=0.66), grille_top=0.52,
    shape=dict(nose_len=0.10, nose_drop=0.05, nose_taper=0.10, cabin_back=0.10, roof_drop=0.03, haunch=0.07, tail_cut=0.28),
    parts=dict(wing_half_width=0.9, wing_z=1.14, slats=4, grille_w=1.15, diffuser_fins=(-0.4, 0.0, 0.4)),
)

if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:]
    build(CFG, args[0], args[1])
