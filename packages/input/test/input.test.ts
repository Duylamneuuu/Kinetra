import assert from "node:assert/strict";
import test from "node:test";
import { InputRouter, type InputMap, type PhysicalInputSnapshot } from "../src/index.js";

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

test("getActionValue preserves signed axis range [-1, 1] for physical and semantic inputs", () => {
  const router = new InputRouter(map);

  // 1. Physical negative axis remains negative through getActionValue
  const negativeAxisSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    // move.forward has binding gamepad-axis 1 with scale -1. If axis is 0.8, raw * scale is -0.8
    gamepadAxes: [0, 0.8],
  };
  assert.equal(router.getActionValue("move.forward", negativeAxisSnapshot), -0.8);
  assert.equal(router.isActionPressed("move.forward", negativeAxisSnapshot), false);

  // 2. Semantic negative value remains negative
  router.setSemanticAction("move.forward", "press", -0.75);
  assert.equal(router.getActionValue("move.forward"), -0.75);
  // Semantic overrides physical snapshot when active
  assert.equal(router.getActionValue("move.forward", negativeAxisSnapshot), -0.75);

  // 3. Positive values still work
  router.setSemanticAction("move.forward", "press", 0.6);
  assert.equal(router.getActionValue("move.forward"), 0.6);
  const positiveAxisSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    gamepadAxes: [0, -0.6], // raw * -1 = +0.6
  };
  router.clearSemanticActions();
  assert.equal(router.getActionValue("move.forward", positiveAxisSnapshot), 0.6);

  // 4. Button actions still behave correctly
  const buttonPressedSnapshot: PhysicalInputSnapshot = {
    keys: new Set(["Space"]),
    gamepadButtons: [],
    gamepadAxes: [],
  };
  const buttonReleasedSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    gamepadAxes: [],
  };
  assert.equal(router.getActionValue("jump", buttonPressedSnapshot), 1);
  assert.equal(router.isActionPressed("jump", buttonPressedSnapshot), true);
  assert.equal(router.getActionValue("jump", buttonReleasedSnapshot), 0);
  assert.equal(router.isActionPressed("jump", buttonReleasedSnapshot), false);

  // Semantic button press and release
  router.setSemanticAction("jump", "press", 1);
  assert.equal(router.getActionValue("jump"), 1);
  assert.equal(router.isActionPressed("jump"), true);
  router.setSemanticAction("jump", "release");
  assert.equal(router.getActionValue("jump"), 0);
  assert.equal(router.isActionPressed("jump"), false);

  // 5. Result remains clamped to valid action range [-1, 1]
  router.setSemanticAction("move.forward", "press", 2.5);
  assert.equal(router.getActionValue("move.forward"), 1);
  router.setSemanticAction("move.forward", "press", -3.0);
  assert.equal(router.getActionValue("move.forward"), -1);
});

