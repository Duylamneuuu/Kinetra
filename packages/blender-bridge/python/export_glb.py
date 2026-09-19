import argparse
import json
from pathlib import Path

import bpy


def parse_args():
    argv = []
    if "--" in __import__("sys").argv:
        argv = __import__("sys").argv[__import__("sys").argv.index("--") + 1 :]

    parser = argparse.ArgumentParser(description="Export the open Blender scene to Kinetra GLB.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--apply-modifiers", action="store_true", default=False)
    return parser.parse_args(argv)


def collect_manifest(output_path: str):
    objects = []
    for obj in bpy.context.scene.objects:
        objects.append(
            {
                "name": obj.name,
                "type": obj.type,
                "parent": obj.parent.name if obj.parent else None,
            }
        )

    actions = sorted(action.name for action in bpy.data.actions)
    armatures = sorted(obj.name for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    meshes = sorted(obj.name for obj in bpy.context.scene.objects if obj.type == "MESH")

    return {
        "blenderVersion": ".".join(str(part) for part in bpy.app.version),
        "output": output_path,
        "objects": objects,
        "actions": actions,
        "armatures": armatures,
        "meshes": meshes,
    }


def main():
    args = parse_args()
    output = str(Path(args.output).resolve())
    Path(output).parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_apply=args.apply_modifiers,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_yup=True,
    )

    manifest = collect_manifest(output)
    manifest_path = args.manifest or f"{output}.manifest.json"
    Path(manifest_path).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("KINETRA_BLENDER_EXPORT_OK")
    print(json.dumps({"output": output, "manifest": manifest_path}))


if __name__ == "__main__":
    main()
