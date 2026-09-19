import RAPIER from "@dimforge/rapier3d-compat";

export interface Vec3 {x:number;y:number;z:number}
export interface BodyState {
  id:string;
  position:Vec3;
  rotation:{x:number;y:number;z:number;w:number};
  linearVelocity:Vec3;
}

export interface PhysicsStats {
  bodies:number;
  colliders:number;
  fixedSteps:number;
  accumulatorSeconds:number;
}

interface BodyEntry {
  id:string;
  body:RAPIER.RigidBody;
  collider?:RAPIER.Collider;
}

let rapierReady:Promise<void>|undefined;

export async function initRapier():Promise<void>{
  rapierReady??=RAPIER.init();
  await rapierReady;
}

export class RapierPhysicsWorld {
  readonly fixedDeltaSeconds:number;
  readonly world:RAPIER.World;
  #bodies=new Map<string,BodyEntry>();
  #accumulator=0;
  #fixedSteps=0;

  private constructor(input:{gravity:Vec3;fixedDeltaSeconds:number}){
    this.fixedDeltaSeconds=input.fixedDeltaSeconds;
    this.world=new RAPIER.World(input.gravity);
    this.world.timestep=input.fixedDeltaSeconds;
  }

  static async create(input:{
    gravity?:Vec3;
    fixedDeltaSeconds?:number;
  }={}):Promise<RapierPhysicsWorld>{
    await initRapier();
    const fixedDeltaSeconds=input.fixedDeltaSeconds??1/60;
    if(!(fixedDeltaSeconds>0)) throw new RangeError("fixedDeltaSeconds must be > 0");
    return new RapierPhysicsWorld({
      gravity:input.gravity??{x:0,y:-9.81,z:0},
      fixedDeltaSeconds,
    });
  }

  addFixedBox(input:{
    id:string;
    position:Vec3;
    halfExtents:Vec3;
  }):void{
    this.#assertNewId(input.id);
    const body=this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        input.position.x,input.position.y,input.position.z,
      ),
    );
    const collider=this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        input.halfExtents.x,input.halfExtents.y,input.halfExtents.z,
      ),
      body,
    );
    this.#bodies.set(input.id,{id:input.id,body,collider});
  }

  addDynamicBall(input:{
    id:string;
    position:Vec3;
    radius:number;
    restitution?:number;
  }):void{
    this.#assertNewId(input.id);
    const body=this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(
        input.position.x,input.position.y,input.position.z,
      ),
    );
    const colliderDesc=RAPIER.ColliderDesc.ball(input.radius);
    if(input.restitution!==undefined) colliderDesc.setRestitution(input.restitution);
    const collider=this.world.createCollider(colliderDesc,body);
    this.#bodies.set(input.id,{id:input.id,body,collider});
  }

  addKinematicCapsule(input:{
    id:string;
    position:Vec3;
    halfHeight:number;
    radius:number;
  }):void{
    this.#assertNewId(input.id);
    const body=this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        input.position.x,input.position.y,input.position.z,
      ),
    );
    const collider=this.world.createCollider(
      RAPIER.ColliderDesc.capsule(input.halfHeight,input.radius),
      body,
    );
    this.#bodies.set(input.id,{id:input.id,body,collider});
  }

  moveKinematicCharacter(input:{
    id:string;
    desired:Vec3;
    offset?:number;
  }):Vec3{
    const entry=this.#require(input.id);
    if(!entry.collider) throw new Error(`Body "${input.id}" has no collider`);

    const controller=this.world.createCharacterController(input.offset??0.01);
    try{
      controller.computeColliderMovement(entry.collider,input.desired);
      const movement=controller.computedMovement();
      const current=entry.body.translation();
      entry.body.setNextKinematicTranslation({
        x:current.x+movement.x,
        y:current.y+movement.y,
        z:current.z+movement.z,
      });
      return{x:movement.x,y:movement.y,z:movement.z};
    }finally{
      this.world.removeCharacterController(controller);
    }
  }

  advance(realDeltaSeconds:number):number{
    if(!Number.isFinite(realDeltaSeconds)||realDeltaSeconds<0){
      throw new RangeError("realDeltaSeconds must be finite and non-negative");
    }
    this.#accumulator+=Math.min(realDeltaSeconds,0.25);
    let steps=0;
    while(this.#accumulator+Number.EPSILON>=this.fixedDeltaSeconds){
      this.world.step();
      this.#accumulator-=this.fixedDeltaSeconds;
      this.#fixedSteps+=1;
      steps+=1;
    }
    return steps;
  }

  state(id:string):BodyState{
    const body=this.#require(id).body;
    const p=body.translation();
    const q=body.rotation();
    const v=body.linvel();
    return{
      id,
      position:{x:p.x,y:p.y,z:p.z},
      rotation:{x:q.x,y:q.y,z:q.z,w:q.w},
      linearVelocity:{x:v.x,y:v.y,z:v.z},
    };
  }

  stats():PhysicsStats{
    return{
      bodies:this.world.bodies.len(),
      colliders:this.world.colliders.len(),
      fixedSteps:this.#fixedSteps,
      accumulatorSeconds:this.#accumulator,
    };
  }

  remove(id:string):void{
    const entry=this.#require(id);
    this.world.removeRigidBody(entry.body);
    this.#bodies.delete(id);
  }

  dispose():void{
    this.#bodies.clear();
    this.world.free();
  }

  #assertNewId(id:string):void{
    if(this.#bodies.has(id)) throw new Error(`Physics body "${id}" already exists`);
  }

  #require(id:string):BodyEntry{
    const entry=this.#bodies.get(id);
    if(!entry) throw new Error(`Unknown physics body "${id}"`);
    return entry;
  }
}
