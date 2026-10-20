// The Blender editor HUD inside the Babylon Lite Playground (https://liteplayground.babylonjs.com).
// @knervous/blender-web-editor docks over this scene: edit in Lite, run
// Python or direct RNA calls in Blender (WebAssembly, in a worker), sync both ways.
import * as LITE from "@babylonjs/lite";
import { mountEditor } from "@knervous/blender-web-editor@0.0.1";
import { liteViewport } from "@knervous/blender-web-editor@0.0.1/lite";

// Blender's runtime from jsDelivr: the core package's runtime/, at the
// version the editor depends on.
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.3/runtime/";
// A hosted Blender UI (the fork's `./build.sh web`, with its _headers) adds a
// "Blender UI" button that swaps to Blender's own interface and back.
const BLENDER_UI: string | undefined = undefined;

async function main(): Promise<void> {
    // The app's scene: engine, camera, light and render loop stay the app's.
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await LITE.createEngine(canvas);
    const scene = LITE.createSceneContext(engine);
    const camera = LITE.createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 14, LITE.vec3(0, 0, 0));
    LITE.addToScene(scene, camera);
    LITE.attachControl(camera, canvas, scene);
    LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 1));
    await LITE.registerScene(scene);
    void LITE.startEngine(engine); // the render loop; settles only when the engine stops

    // The editor over it (single-threaded Blender here: the page isn't isolated).
    const editor = mountEditor({
        container: canvas.parentElement!, // the HUD docks on its right
        viewport: liteViewport(LITE, engine, scene, canvas),
        runtimeUrl: RUNTIME,
        blenderUi: BLENDER_UI,
    });
    await editor.ready; // Blender's startup cube, light and camera are now Lite nodes

    // The same project from code: a direct RNA call, then a sync brings it to Lite.
    await editor.session!.api.call("mesh.primitive_monkey_add", { location: [0, -3, 1] });
    await editor.project!.sync();
    editor.refresh();
}

main().catch(console.error);
