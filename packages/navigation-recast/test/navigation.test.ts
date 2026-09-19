import assert from "node:assert/strict";
import test from "node:test";
import { RecastNavMesh } from "../src/index.js";

const positions=[
  -5,0,-5,
   5,0,-5,
   5,0, 5,
  -5,0, 5,
];
const indices=[0,2,1,0,3,2];

test("bakes, queries, serializes and reloads a synthetic navmesh",async()=>{
  const nav=await RecastNavMesh.bake({positions,indices});
  try{
    const path=nav.computePath({x:-3,y:0,z:-3},{x:3,y:0,z:3});
    assert.ok(path.length>=2);
    assert.ok(Math.abs(path[0]!.x+3)<0.5);
    assert.ok(Math.abs(path.at(-1)!.x-3)<0.5);

    const bytes=nav.toBytes();
    assert.ok(bytes.byteLength>0);

    const restored=await RecastNavMesh.fromBytes(bytes);
    try{
      const closest=restored.closestPoint({x:0,y:2,z:0});
      assert.ok(Math.abs(closest.y)<0.2);
    }finally{
      restored.dispose();
    }
  }finally{
    nav.dispose();
  }
});
