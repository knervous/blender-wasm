// Scratch: Blender (WebAssembly) and Babylon.js as one project, for
// https://playground.babylonjs.com/ once @knervous/blender-web is on npm.
//
// The playground page is not cross-origin isolated, so this runs the
// single-threaded (JSPI) build; the runtime comes from the package on the CDN.
// `BABYLON`, `engine` and `canvas` are the playground's globals.
import { Project } from "@knervous/blender-web";
import { createBlenderSession } from "@knervous/blender-web/browser";
import { BabylonSide } from "@knervous/blender-web/babylon";

const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.1/runtime/";

export const createScene = async function () {
    const scene = new BABYLON.Scene(engine);
    const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, 12, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    new BABYLON.HemisphericLight("sky", new BABYLON.Vector3(0, 1, 0), scene);

    // The adapter uses the playground's own Babylon.
    const side = new BabylonSide(BABYLON, scene);
    const session = createBlenderSession({
        runtimeUrl: RUNTIME,
        onProgress: (p) => console.log(`blender: ${p.detail} ${Math.round(p.fraction * 100)}%`),
    });
    const project = new Project({ session, scene: side });

    void (async () => {
        await project.newScene(); // Blender's startup cube, light and camera arrive as Babylon nodes
        console.log(`blender (${session.flavor}) booted in ${(session.bootMs / 1000).toFixed(1)} s`);

        await project.sync({
            script: `
import bpy
bpy.ops.mesh.primitive_monkey_add(location=(0, -3, 1))
monkey = bpy.context.object
row = monkey.modifiers.new("row", "ARRAY")
row.count = 3
bevel = monkey.modifiers.new("bevel", "BEVEL")
bevel.width = 0.02
`,
        });

        // Babylon edits travel back: a box made with Babylon's API, tracked, synced.
        const box = BABYLON.MeshBuilder.CreateBox("babylon_box", { size: 1.5 }, scene);
        box.position.set(3, 0.75, 0);
        side.track([box]);
        const { sent, received } = await project.sync();
        console.log(`sync: sent ${sent.length}, received ${received.length}`);
    })().catch(console.error);

    return scene;
};
