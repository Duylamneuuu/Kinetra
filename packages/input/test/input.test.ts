import assert from "node:assert/strict";
import test from "node:test";
import { InputRouter, type InputMap } from "../src/index.js";

const map:InputMap={
  schemaVersion:1,
  actions:[
    {id:"move.forward",type:"axis",bindings:[
      {kind:"key",code:"KeyW",scale:1},
      {kind:"gamepad-axis",axis:1,scale:-1,deadzone:0.2},
    ]},
    {id:"jump",type:"button",bindings:[
      {kind:"key",code:"Space"},
      {kind:"gamepad-button",button:0},
    ]},
  ],
};

test("named actions unify keyboard and gamepad",()=>{
  const router=new InputRouter(map);
  assert.equal(router.value("move.forward",{keys:new Set(["KeyW"]),gamepadButtons:[],gamepadAxes:[]}),1);
  assert.equal(router.value("move.forward",{keys:new Set(),gamepadButtons:[],gamepadAxes:[0,-0.8]}),0.8);
  assert.equal(router.value("jump",{keys:new Set(),gamepadButtons:[1],gamepadAxes:[]}),1);
});

test("bindings can be remapped without changing gameplay action IDs",()=>{
  const router=new InputRouter(map);
  router.remap("jump",[{kind:"key",code:"KeyJ"}]);
  assert.equal(router.value("jump",{keys:new Set(["Space"]),gamepadButtons:[],gamepadAxes:[]}),0);
  assert.equal(router.value("jump",{keys:new Set(["KeyJ"]),gamepadButtons:[],gamepadAxes:[]}),1);
});

test("semantic action injection and step lifecycle",()=>{
  const router=new InputRouter();
  assert.equal(router.hasAction("player.moveRight"),true);
  assert.equal(router.isActionPressed("player.moveRight"),false);

  router.setSemanticAction("player.moveRight","press",1);
  assert.equal(router.isActionPressed("player.moveRight"),true);
  assert.equal(router.getActionValue("player.moveRight"),1);

  router.endStep();
  assert.equal(router.isActionPressed("player.moveRight"),false);
  assert.equal(router.getActionValue("player.moveRight"),0);

  router.setSemanticAction("player.jump","hold",1);
  assert.equal(router.isActionPressed("player.jump"),true);
  router.endStep();
  assert.equal(router.isActionPressed("player.jump"),true);

  router.setSemanticAction("player.jump","release");
  assert.equal(router.isActionPressed("player.jump"),false);
});

