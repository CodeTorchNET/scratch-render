/* global render */
const {chromium} = require('playwright-chromium');
const test = require('tap').test;
const path = require('path');

const indexHTML = path.resolve(__dirname, 'index.html');

/* eslint-env browser */
/**
 * Runs in the page.
 * @param {object} options options
 * @returns {object} results results
 */
const scene = options => {
    const gl = render._gl;
    for (const id of Object.keys(render._allDrawables)) {
        const d = render._allDrawables[id];
        if (d) render.destroyDrawable(Number(id), d._ctPmTestGroup || 'sprite');
    }
    if (render._ctPmCameras) render._ctPmCameras.clear();
    render.setUseHighQualityRender(false);

    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 40, 20);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 15, 8);
    if (!window.ctPmSkin) window.ctPmSkin = render.createBitmapSkin(canvas, 1, [12, 6]);
    if (!window.ctPmBackdrop) {
        const bg = document.createElement('canvas');
        bg.width = 480;
        bg.height = 360;
        const g = bg.getContext('2d');
        for (let x = 0; x < 480; x += 40) {
            for (let y = 0; y < 360; y += 40) {
                g.fillStyle = ((x + y) / 40) % 2 ? '#22aa22' : '#aaaa22';
                g.fillRect(x, y, 40, 40);
            }
        }
        window.ctPmBackdrop = render.createBitmapSkin(bg, 1, [240, 180]);
    }

    const cam = options.camera;
    const toScreen = (x, y) => {
        const r = cam.dir * Math.PI / 180;
        const ox = x - cam.x;
        const oy = y - cam.y;
        return [cam.scale * ((ox * Math.cos(r)) - (oy * Math.sin(r))),
            cam.scale * ((ox * Math.sin(r)) + (oy * Math.cos(r)))];
    };

    const add = (group, skin, s) => {
        const id = render.createDrawable(group);
        render._allDrawables[id]._ctPmTestGroup = group;
        render.updateDrawableSkinId(id, skin);
        if (options.mode === 'baked') {
            render.updateDrawablePosition(id, toScreen(s.x, s.y));
            render.updateDrawableDirectionScale(id, s.dir - cam.dir, [s.scale * cam.scale, s.scale * cam.scale]);
        } else {
            render.updateDrawablePosition(id, [s.x, s.y]);
            render.updateDrawableDirectionScale(id, s.dir, [s.scale, s.scale]);
            if (options.mode === 'camera') render.ctPmSetDrawableCamera(id, 'default');
        }
        return id;
    };
    const stage = add('background', window.ctPmBackdrop, {x: 0, y: 0, dir: 90, scale: 100});
    const ids = options.sprites.map(s => add('sprite', window.ctPmSkin, s));
    if (options.mode === 'camera') {
        render.ctPmSetCamera('default', options.identityCamera ? {x: 0, y: 0, dir: 0, scale: 1} : cam);
    }

    const out = {};
    if (options.stamp) {
        const pen = render.createPenSkin();
        const penId = render.createDrawable('pen');
        render._allDrawables[penId]._ctPmTestGroup = 'pen';
        render.updateDrawableSkinId(penId, pen);
        render.penStamp(pen, ids[0]);
        render.updateDrawableVisible(ids[0], false);
        render.updateDrawableVisible(stage, false);
    }
    if (options.touching) out.touching = render.isTouchingDrawables(ids[0], [ids[1]]);
    if (options.pick) out.pick = options.pick.map(([x, y]) => ids.indexOf(render.pick(x, y)));
    out.bounds = ids.map(id => {
        const b = render.getBounds(id);
        return [b.left, b.right, b.bottom, b.top].map(v => Math.round(v * 100) / 100);
    });

    render.draw();
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    out.pixels = Array.from(pixels);
    return out;
};
/* eslint-env node */

const diffPixels = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
    }
    return n;
};

const SPRITES = [
    {x: 30, y: 20, dir: 90, scale: 100},
    {x: -60, y: -10, dir: 30, scale: 150},
    {x: 50, y: 30, dir: -100, scale: 80}
];

const CAMERAS = [
    {name: 'offset', cam: {x: 40, y: -25, dir: 0, scale: 1}},
    {name: 'zoom 200%', cam: {x: 10, y: 5, dir: 0, scale: 2}},
    {name: 'zoom 50%', cam: {x: 0, y: 0, dir: 0, scale: 0.5}},
    {name: 'rotated -90', cam: {x: 0, y: 0, dir: -90, scale: 1}},
    {name: 'rotated 37, zoomed, moved', cam: {x: -20, y: 15, dir: 37, scale: 1.7}}
];

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`file://${indexHTML}`);
    const run = options => page.evaluate(scene, options);

    await test('no camera / identity camera: pixels identical to an unbound drawable', async t => {
        const cam = {x: 0, y: 0, dir: 0, scale: 1};
        const plain = await run({camera: cam, sprites: SPRITES, mode: 'plain'});
        const identity = await run({camera: cam, sprites: SPRITES, mode: 'camera', identityCamera: true});
        t.equal(diffPixels(plain.pixels, identity.pixels), 0);
        t.same(plain.bounds, identity.bounds);
        t.end();
    });

    for (const {name, cam} of CAMERAS) {
        await test(`camera ${name}: drawn where PenguinMod draws it, backdrop included`, async t => {
            const pick = [[240, 180], [270, 160], [180, 190], [300, 150], [200, 200]];
            const baked = await run({camera: cam, sprites: SPRITES, mode: 'baked', touching: true, pick});
            const ours = await run({camera: cam, sprites: SPRITES, mode: 'camera', touching: true, pick});
            const differing = diffPixels(baked.pixels, ours.pixels);
            t.ok(differing <= 40, `${differing} of ${baked.pixels.length / 4} pixels differ`);
            t.equal(ours.touching, baked.touching, 'touching');
            t.same(ours.pick, baked.pick, 'picking at screen points');
            for (let i = 0; i < SPRITES.length; i++) {
                for (let k = 0; k < 4; k++) {
                    t.ok(Math.abs(ours.bounds[i][k] - baked.bounds[i][k]) <= 1.01,
                        `bounds ${i}.${k}: ${ours.bounds[i][k]} vs ${baked.bounds[i][k]}`);
                }
            }
            t.end();
        });
    }

    await test('a stamp lands where the sprite is seen (pen layer is not bound, as in PenguinMod)', async t => {
        const cam = CAMERAS[4].cam;
        const baked = await run({camera: cam, sprites: SPRITES, mode: 'baked', stamp: true});
        const ours = await run({camera: cam, sprites: SPRITES, mode: 'camera', stamp: true});
        const differing = diffPixels(baked.pixels, ours.pixels);
        t.ok(differing <= 40, `${differing} pixels differ`);
        t.end();
    });

    await browser.close();
})();
