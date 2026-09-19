import {
  NavMeshQuery,
  exportNavMesh,
  importNavMesh,
  init,
  type NavMesh,
} from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";

export interface Vec3 {x:number;y:number;z:number}

let ready:Promise<void>|undefined;

export async function initNavigation():Promise<void>{
  ready??=init();
  await ready;
}

export class RecastNavMesh {
  #query:NavMeshQuery;

  private constructor(private readonly navMesh:NavMesh){
    this.#query=new NavMeshQuery(navMesh);
  }

  static async bake(input:{
    positions:number[];
    indices:number[];
  }):Promise<RecastNavMesh>{
    await initNavigation();
    const result=generateSoloNavMesh(input.positions,input.indices);
    if(!result.success){
      throw new Error(`NavMesh bake failed: ${result.error ?? "unknown error"}`);
    }
    return new RecastNavMesh(result.navMesh);
  }

  static async fromBytes(bytes:Uint8Array):Promise<RecastNavMesh>{
    await initNavigation();
    return new RecastNavMesh(importNavMesh(bytes).navMesh);
  }

  toBytes():Uint8Array{
    return exportNavMesh(this.navMesh);
  }

  closestPoint(position:Vec3):Vec3{
    const result=this.#query.findClosestPoint(position);
    if(!result.success) throw new Error("No closest point found on navmesh");
    return{x:result.point.x,y:result.point.y,z:result.point.z};
  }

  computePath(start:Vec3,end:Vec3):Vec3[]{
    const result=this.#query.computePath(start,end);
    if(!result.success){
      throw new Error(`Path query failed: ${result.error ?? "unknown error"}`);
    }
    return result.path.map((point:{x:number;y:number;z:number})=>({
      x:point.x,y:point.y,z:point.z,
    }));
  }

  dispose():void{
    this.#query.destroy();
    this.navMesh.destroy();
  }
}
