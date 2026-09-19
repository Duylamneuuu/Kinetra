import { spawn } from "node:child_process";

export interface BlenderExportOptions {
  blenderExecutable: string;
  sourceBlend: string;
  outputGlb: string;
  pythonScript: string;
}

export interface ProcessRunner {
  run(executable: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export class NodeProcessRunner implements ProcessRunner {
  run(executable: string, args: string[]): Promise<{ code:number; stdout:string; stderr:string }> {
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
      let stdout="", stderr="";
      child.stdout.on("data",(chunk:Buffer)=>stdout+=chunk.toString("utf8"));
      child.stderr.on("data",(chunk:Buffer)=>stderr+=chunk.toString("utf8"));
      child.once("error",reject);
      child.once("exit",(code)=>resolve({code:code??-1,stdout,stderr}));
    });
  }
}

export function blenderHeadlessArgs(input: BlenderExportOptions): string[] {
  return [
    "--background",
    input.sourceBlend,
    "--python",
    input.pythonScript,
    "--",
    "--output",
    input.outputGlb,
  ];
}

export async function runBlenderExport(
  input: BlenderExportOptions,
  runner: ProcessRunner = new NodeProcessRunner(),
): Promise<void> {
  const result=await runner.run(input.blenderExecutable,blenderHeadlessArgs(input));
  if(result.code!==0){
    throw new Error(`Blender export failed with code ${result.code}: ${result.stderr.trim()}`);
  }
}
