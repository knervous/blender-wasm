// The Blender editor HUD inside the Babylon.js Playground (https://playground.babylonjs.com).
// @knervous/blender-web-editor docks over this scene: edit in Babylon, run
// Python or direct RNA calls in Blender (WebAssembly, in a worker), sync both ways.

// The editor from esm.sh, and Blender's runtime from jsDelivr (the core
// package's runtime/; keep its version the one the editor depends on).
const EDITOR = "https://esm.sh/@knervous/blender-web-editor@0.0.1";
const RUNTIME = "https://cdn.jsdelivr.net/npm/@knervous/blender-web@0.0.3/runtime/";
// A hosted Blender UI (the fork's `./build.sh web`, with its _headers) adds a
// "Blender UI" button that swaps to Blender's own interface and back.
const BLENDER_UI = null;

export const createScene = async function () {
    const scene = new BABYLON.Scene(engine);
    const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, 14, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);

    // The editor loads after the scene is returned, so the playground never waits on it.
    void (async () => {
        const [{ mountEditor }, { babylonViewport }] = await Promise.all([import(EDITOR), import(`${EDITOR}/babylon`)]);
        const editor = mountEditor({
            container: canvas.parentElement,                              // the HUD docks on its right
            viewport: babylonViewport(BABYLON, scene, { helpers: true }), // the playground's own BABYLON; grid + lights
            runtimeUrl: RUNTIME,                                          // single-threaded here: the page isn't isolated
            blenderUi: BLENDER_UI ?? undefined,
        });
        await editor.ready; // Blender's startup cube, light and camera are now Babylon nodes

        // The same project from code: a direct RNA call, then a sync brings it to Babylon.
        await editor.session.api.call("mesh.primitive_monkey_add", { location: [0, -3, 1] });
        await editor.project.sync();
        editor.refresh();
    })().catch(console.error);

    return scene;
};
