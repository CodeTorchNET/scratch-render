const test = require('tap').test;

global.window = {};
global.document = {
    createElement: () => ({getContext: () => {}})
};

const Drawable = require('../../src/Drawable');
const Rectangle = require('../../src/Rectangle');
const ctPmCamera = require('../../src/ct-pm-camera');
const MockSkin = require('../fixtures/MockSkin');

class FakeRenderer {
    constructor () {
        this._allDrawables = [];
        this.dirty = false;
        this._xRight = 240;
        this._yTop = 180;
    }
}
ctPmCamera.install(FakeRenderer);

const makeDrawable = (renderer, id, props) => {
    const drawable = new Drawable(id, renderer);
    drawable.skin = new MockSkin(0, {skinWasAltered: () => drawable._skinWasAltered()});
    drawable.skin.size = [40, 20];
    drawable.skin.rotationCenter = [20, 10];
    drawable.updateProperties(Object.assign({position: [30, -12], direction: 90, scale: [100, 100]}, props));
    if (renderer._allDrawables) renderer._allDrawables[id] = drawable;
    return drawable;
};

const matrix = drawable => Array.from(drawable.getUniforms().u_modelMatrix);

/**
 * PenguinMod's translateForCamera.
 * @param {object} cam cam
 * @param {number} x world x
 * @param {number} y world y
 * @returns {Array<number>} screen screen
 */
const pmToScreen = (cam, x, y) => {
    const r = cam.dir * Math.PI / 180;
    const ox = x - cam.x;
    const oy = y - cam.y;
    return [
        cam.scale * ((ox * Math.cos(r)) - (oy * Math.sin(r))),
        cam.scale * ((ox * Math.sin(r)) + (oy * Math.cos(r)))
    ];
};

/**
 * Where a model matrix puts a point of the unit quad.
 * @param {Array<number>} m model matrix
 * @param {number} u quad x, 0..1
 * @param {number} v quad y, 0..1
 * @returns {Array<number>} [x, y] x, y
 */
const corner = (m, u, v) => {
    const x = u - 0.5;
    const y = v - 0.5;
    return [(m[0] * x) + (m[4] * y) + m[12], (m[1] * x) + (m[5] * y) + m[13]];
};

const near = (t, a, b, message) => t.ok(Math.abs(a - b) < 1e-4, `${message}: ${a} vs ${b}`);

test('a drawable with no camera, or on a camera at its identity, keeps the exact same matrix', t => {
    const renderer = new FakeRenderer();
    const plain = makeDrawable({}, 0, {direction: 37, scale: [150, -80]});
    const bound = makeDrawable(renderer, 1, {direction: 37, scale: [150, -80]});
    renderer.ctPmSetDrawableCamera(1, 'default');
    t.same(matrix(bound), matrix(plain), 'bound to a camera that was never moved');
    t.notOk(bound._ctPmCamera);

    renderer.ctPmSetCamera('default', {x: 0, y: 0, dir: 0, scale: 1});
    t.same(matrix(bound), matrix(plain), 'camera explicitly at identity');
    t.same(bound.scale, plain.scale);

    renderer.ctPmSetCamera('default', {x: 5, y: 0, dir: 0, scale: 1});
    t.notSame(matrix(bound), matrix(plain));
    renderer.ctPmSetCamera('default', null);
    t.same(matrix(bound), matrix(plain), 'back to identity');
    t.end();
});

test('bound drawables are drawn exactly where PenguinMod put them', t => {
    const cameras = [
        {x: 100, y: 50, dir: 0, scale: 1},
        {x: 0, y: 0, dir: 0, scale: 2},
        {x: 0, y: 0, dir: -90, scale: 1},
        {x: -33.5, y: 12.25, dir: 37, scale: 0.6},
        {x: 10, y: 10, dir: 180, scale: -1.5}
    ];
    for (const cam of cameras) {
        for (const props of [{direction: 90}, {direction: -20, scale: [130, 70]}]) {
            const renderer = new FakeRenderer();
            const world = makeDrawable({}, 0, props);
            const d = makeDrawable(renderer, 1, props);
            d._highQuality = true;
            world._highQuality = true;
            renderer.ctPmSetDrawableCamera(1, 'main');
            renderer.ctPmSetCamera('main', cam);
            const wm = matrix(world);
            const m = matrix(d);
            for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
                const w = corner(wm, u, v);
                const expected = pmToScreen(cam, w[0], w[1]);
                const got = corner(m, u, v);
                near(t, got[0], expected[0], `x ${JSON.stringify(cam)} ${JSON.stringify(props)}`);
                near(t, got[1], expected[1], `y ${JSON.stringify(cam)} ${JSON.stringify(props)}`);
            }
        }
    }
    t.end();
});

test('without high quality pen, the on-screen position is rounded (as PenguinMod rounds it)', t => {
    const renderer = new FakeRenderer();
    const d = makeDrawable(renderer, 1, {position: [10, 10]});
    renderer.ctPmSetDrawableCamera(1, 'default');
    renderer.ctPmSetCamera('default', {x: 0.4, y: 0, dir: 0, scale: 1});
    const m = matrix(d);
    t.equal(m[12], 10, 'x 9.6 rounded');
    t.equal(m[13], 10);
    t.end();
});

test('bounds, AABB and texture scale follow the camera', t => {
    const renderer = new FakeRenderer();
    const d = makeDrawable(renderer, 1, {position: [0, 0]});
    renderer.ctPmSetDrawableCamera(1, 'default');
    renderer.ctPmSetCamera('default', {x: 10, y: 0, dir: 0, scale: 2});
    const aabb = d.getAABB();
    const expected = new Rectangle();
    expected.initFromBounds(-60, 20, -20, 20);
    const r3 = v => Math.round(v * 1000) / 1000;
    t.same([aabb.left, aabb.right, aabb.bottom, aabb.top].map(r3),
        [expected.left, expected.right, expected.bottom, expected.top]);
    t.same(d.scale, [200, 200], 'textures are picked for the on-screen size');
    t.notOk(ctPmCamera.rotated(d));
    renderer.ctPmSetCamera('default', {x: 10, y: 0, dir: 30, scale: 2});
    t.ok(ctPmCamera.rotated(d), 'rotated camera: SVGs never use nearest sampling');
    t.end();
});

test('rebinding and unbinding; other cameras do not touch the drawable', t => {
    const renderer = new FakeRenderer();
    const plain = makeDrawable({}, 0);
    const d = makeDrawable(renderer, 1);
    renderer.ctPmSetCamera('a', {x: 50, y: 0, dir: 0, scale: 1});
    renderer.ctPmSetCamera('b', {x: 0, y: 50, dir: 0, scale: 1});
    renderer.ctPmSetDrawableCamera(1, 'a');
    t.equal(d.getUniforms().u_modelMatrix[12], plain.getUniforms().u_modelMatrix[12] - 50);
    renderer.ctPmSetDrawableCamera(1, 'b');
    t.equal(d.getUniforms().u_modelMatrix[13], plain.getUniforms().u_modelMatrix[13] - 50);
    renderer.ctPmSetCamera('a', {x: 999, y: 0, dir: 0, scale: 1});
    t.equal(d.getUniforms().u_modelMatrix[12], plain.getUniforms().u_modelMatrix[12], 'camera a no longer applies');
    renderer.ctPmSetDrawableCamera(1, null);
    t.same(matrix(d), matrix(plain), 'unbound');
    t.notOk(renderer._ctPmCamera('a', false).drawables.has(1));
    t.end();
});

test('destroyed drawables are forgotten', t => {
    const renderer = new FakeRenderer();
    for (let id = 1; id <= 200; id++) {
        makeDrawable(renderer, id);
        renderer.ctPmSetDrawableCamera(id, 'default');
        delete renderer._allDrawables[id];
    }
    t.ok(renderer._ctPmCamera('default', false).drawables.size < 64);
    renderer.ctPmSetCamera('default', {x: 1, y: 2, dir: 3, scale: 4});
    t.equal(renderer._ctPmCamera('default', false).drawables.size, 0);
    t.end();
});

test('non-finite camera values cannot poison the matrix', t => {
    const renderer = new FakeRenderer();
    const d = makeDrawable(renderer, 1);
    renderer.ctPmSetDrawableCamera(1, 'default');
    renderer.ctPmSetCamera('default', {x: Infinity, y: NaN, dir: 0, scale: Infinity});
    t.ok(matrix(d).every(Number.isFinite));
    t.same(renderer.ctPmGetCamera('default'), {x: 0, y: 0, dir: 0, scale: 1});
    t.end();
});

test('fencing under a camera keeps the sprite on screen and answers in world space', t => {
    const renderer = new FakeRenderer();
    const d = makeDrawable(renderer, 1, {position: [0, 0]});
    d._highQuality = true;
    renderer.ctPmSetDrawableCamera(1, 'default');
    renderer.ctPmSetCamera('default', {x: 100, y: 0, dir: 0, scale: 2});
    const [x, y] = ctPmCamera.fencedPosition(renderer, d, [1000, 0], new Rectangle());
    const screenX = 2 * (x - 100);
    t.equal(screenX - 40, 225, 'left edge at 225 on screen');
    t.equal(y, 0);
    t.same(ctPmCamera.fencedPosition(renderer, d, [110, 5], new Rectangle()), [110, 5]);
    t.end();
});
