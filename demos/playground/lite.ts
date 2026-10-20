// Scratch: Blender (WebAssembly) and Babylon Lite as one project, for
// https://liteplayground.babylonjs.com/ once @knervous/blender-web is on npm.
//
// The playground page is not cross-origin isolated, so this runs the
// single-threaded (JSPI) build; the runtime comes from the package on the CDN.
import * as LITE from "@babylonjs/lite";
import { Project } from "@knervous/blender-web";
import { createBlenderSession } from "@knervous/blender-web/browser";
import { LiteSide } from "@knervous/blender-web/lite";

const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.1/runtime/";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await LITE.createEngine(canvas);
    const scene = LITE.createSceneContext(engine);
    const camera = LITE.createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 12, LITE.vec3(0, 0, 0));
    LITE.addToScene(scene, camera);
    LITE.attachControl(camera, canvas, scene);
    LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 1.0));
    await LITE.registerScene(scene);
    void LITE.startEngine(engine);

    // Lite's own scene, kept in step with a Blender session in a worker.
    const side = new LiteSide(LITE, engine, scene);
    const session = createBlenderSession({
        runtimeUrl: RUNTIME,
        onProgress: (p) => console.log(`blender: ${p.detail} ${Math.round(p.fraction * 100)}%`),
    });
    const project = new Project({ session, scene: side });

    await project.newScene(); // Blender's startup cube, light and camera arrive as Lite nodes
    console.log(`blender (${session.flavor}) booted in ${(session.bootMs / 1000).toFixed(1)} s`);

    // Blender does the modelling: a monkey with an array and a bevel, coloured.
    await project.sync({
        script: `
import bpy
bpy.ops.mesh.primitive_monkey_add(location=(0, -3, 1))
monkey = bpy.context.object
for face in monkey.data.polygons:
    face.use_smooth = True
row = monkey.modifiers.new("row", "ARRAY")
row.count = 3
row.relative_offset_displace = (1.4, 0, 0)
mat = bpy.data.materials.new("orange")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.35, 0.05, 1)
monkey.data.materials.append(mat)
`,
    });

    // Lite edits travel back: move the cube with Lite's API, then sync.
    const cube = side.ids().map((id) => side.node(id)).find((n) => n?.name === "Cube");
    cube?.position.set(0, 2, 0);
    const { sent, received } = await project.sync();
    console.log(`sync: sent ${sent.length}, received ${received.length}`);
}

main().catch(console.error);
