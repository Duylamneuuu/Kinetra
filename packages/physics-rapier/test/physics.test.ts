import assert from "node:assert/strict";
import test from "node:test";
import { RapierPhysicsWorld } from "../src/index.js";

test("fixed-step simulation lands a dynamic ball on ground",async()=>{
  const physics=await RapierPhysicsWorld.create();
  try{
    physics.addFixedBox({
      id:"ground",position:{x:0,y:-0.5,z:0},halfExtents:{x:10,y:0.5,z:10},
    });
    physics.addDynamicBall({
      id:"ball",position:{x:0,y:4,z:0},radius:0.5,
    });

    for(let i=0;i<240;i++) physics.advance(1/60);

    const ball=physics.state("ball");
    assert.ok(ball.position.y>0.45&&ball.position.y<0.65);
    assert.ok(Math.abs(ball.linearVelocity.y)<0.1);
    assert.equal(physics.stats().fixedSteps,240);
  }finally{
    physics.dispose();
  }
});

test("fixed-step accumulator is independent of render delta partition",async()=>{
  const a=await RapierPhysicsWorld.create();
  const b=await RapierPhysicsWorld.create();
  try{
    a.addDynamicBall({id:"ball",position:{x:0,y:10,z:0},radius:0.5});
    b.addDynamicBall({id:"ball",position:{x:0,y:10,z:0},radius:0.5});

    for(let i=0;i<60;i++) a.advance(1/60);
    for(let i=0;i<30;i++) b.advance(1/30);

    assert.equal(a.stats().fixedSteps,60);
    assert.equal(b.stats().fixedSteps,60);
    assert.ok(Math.abs(a.state("ball").position.y-b.state("ball").position.y)<1e-6);
  }finally{
    a.dispose();b.dispose();
  }
});

test("kinematic character movement is clipped by world colliders",async()=>{
  const physics=await RapierPhysicsWorld.create({gravity:{x:0,y:0,z:0}});
  try{
    physics.addFixedBox({
      id:"wall",position:{x:2,y:1,z:0},halfExtents:{x:0.25,y:2,z:2},
    });
    physics.addKinematicCapsule({
      id:"player",position:{x:0,y:1,z:0},halfHeight:0.5,radius:0.4,
    });

    const movement=physics.moveKinematicCharacter({
      id:"player",desired:{x:4,y:0,z:0},
    });
    assert.ok(movement.x<4);
    physics.advance(1/60);
    assert.ok(physics.state("player").position.x<2);
  }finally{
    physics.dispose();
  }
});
