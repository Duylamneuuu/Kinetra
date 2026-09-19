import argparse
from pathlib import Path
import sys
import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    return parser.parse_args(argv)


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0))
    cube = bpy.context.active_object
    cube.name = "KinetraFixtureCube"

    material = bpy.data.materials.new(name="KinetraOrange")
    material.diffuse_color = (1.0, 0.25, 0.05, 1.0)
    cube.data.materials.append(material)

    output = str(Path(args.output).resolve())
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=output)
    print("KINETRA_BLEND_FIXTURE_OK")


if __name__ == "__main__":
    main()
