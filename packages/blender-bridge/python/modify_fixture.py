import argparse
from pathlib import Path
import sys
import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Headlessly modify Kinetra Blender fixture.")
    parser.add_argument("--output")
    parser.add_argument("--save")
    parser.add_argument("--width", type=float, default=4.0)
    parser.add_argument("--scale-x", type=float)
    return parser.parse_args(argv)


def main():
    args = parse_args()
    output_path = args.output or args.save
    if not output_path:
        output_path = bpy.data.filepath
    if not output_path:
        raise ValueError("No output path specified and active blend has no filepath")

    output = str(Path(output_path).resolve())
    width = args.scale_x if args.scale_x is not None else args.width

    # Find cube or active mesh object
    cube = bpy.data.objects.get("KinetraFixtureCube")
    if not cube:
        for obj in bpy.context.scene.objects:
            if obj.type == "MESH":
                cube = obj
                break

    if cube:
        # Scale along X axis
        cube.scale.x = width
        # Add custom property
        cube["kinetra_revision"] = 2
        cube["kinetra_scale_x"] = width

    Path(output).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=output)
    print("KINETRA_BLEND_MODIFIED_OK")


if __name__ == "__main__":
    main()
