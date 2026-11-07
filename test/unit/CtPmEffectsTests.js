const test = require('tap').test;
const twgl = require('twgl.js');

global.window = {};
global.document = {
    createElement: () => ({getContext: () => {}})
};

const Drawable = require('../../src/Drawable');
const ShaderManager = require('../../src/ShaderManager');
const EffectTransform = require('../../src/EffectTransform');
const ctPmEffects = require('../../src/ct-pm-effects');
const MockSkin = require('../fixtures/MockSkin');

const NEW = ['red', 'green', 'blue', 'opaque', 'saturation', 'tintColor',
    'horizontal_shear', 'vertical_shear', 'repeat_x', 'repeat_y'];

const mockRenderer = drawable => ({
    skinWasAltered: () => {
        drawable._skinWasAltered();
    }
});

const makeDrawable = (size = [200, 50], center = [100, 25]) => {
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = size;
    drawable.skin.rotationCenter = center;
    return drawable;
};

test('new effects come after the vanilla seven, one bit each', t => {
    const vanilla = ['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost'];
    t.same(ShaderManager.EFFECTS.slice(0, 7), vanilla);
    t.same(ShaderManager.EFFECTS.slice(7), NEW);
    ShaderManager.EFFECTS.forEach((name, i) => t.equal(ShaderManager.EFFECT_INFO[name].mask, 1 << i, name));
    t.end();
});

test('a drawable with no effects has no geometry and no enabled bits', t => {
    const d = makeDrawable();
    t.equal(d.enabledEffects, 0);
    t.notOk(d._ctPmGeometry);
    d.updateEffect('horizontal_shear', 10);
    t.ok(d._ctPmGeometry);
    d.updateEffect('horizontal_shear', 0);
    t.equal(d._ctPmGeometry, null);
    t.equal(d.enabledEffects, 0);
    t.end();
});

/**
 * PenguinMod's vertex shader for one quad corner.
 * @param {Array<number>} p corner, components ±0.5
 * @param {object} u uniforms
 * @param {object} on which effects are enabled
 * @returns {Array<number>} shifted corner
 */
const pmVertex = (p, u, on) => {
    let x = p[0];
    let y = p[1];
    if (on.repeat_x && x < 0 && u.u_repeatX !== 1) x = 0.5 - u.u_repeatX;
    if (on.repeat_y && y < 0 && u.u_repeatY !== 1) y = 0.5 - u.u_repeatY;
    if (on.horizontal_shear && p[1] < 0) x += u.u_horizontalShear;
    if (on.vertical_shear && p[0] < 0) y += u.u_verticalShear;
    return [x, y];
};

test('shear/repeat in the model matrix put the quad corners exactly where PenguinMod\'s vertex shader does', t => {
    const cases = [
        {horizontal_shear: 10},
        {vertical_shear: -25},
        {repeat_x: 3},
        {repeat_y: 2.5},
        {repeat_x: -2, horizontal_shear: 7, vertical_shear: 3, repeat_y: 4}
    ];
    for (const effects of cases) {
        for (const direction of [90, 30, -120]) {
            const d = makeDrawable();
            d.updateProperties({position: [12, -7], direction, scale: [150, -80]});
            const plain = twgl.m4.copy(d.getUniforms().u_modelMatrix);
            for (const name of Object.keys(effects)) d.updateEffect(name, effects[name]);
            const withEffects = d.getUniforms().u_modelMatrix;
            for (const corner of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
                const ours = twgl.m4.transformPoint(withEffects, [corner[0], corner[1], 0]);
                const shifted = pmVertex(corner, d._uniforms, effects);
                const pm = twgl.m4.transformPoint(plain, [shifted[0], shifted[1], 0]);
                t.ok(Math.abs(ours[0] - pm[0]) < 1e-3 && Math.abs(ours[1] - pm[1]) < 1e-3,
                    `${JSON.stringify(effects)} dir ${direction} corner ${corner}: ${ours} vs ${pm}`);
            }
        }
    }
    t.end();
});

test('bounds follow the sheared/repeated quad', t => {
    const d = makeDrawable([200, 50], [100, 25]);
    t.equal(d.getAABB().width, 200);
    d.updateEffect('horizontal_shear', 10);
    t.equal(Math.round(d.getAABB().width), 400);
    t.equal(Math.round(d.getAABB().height), 50);
    d.updateEffect('horizontal_shear', 0);
    d.updateEffect('repeat_x', 3);
    t.equal(Math.round(d.getAABB().width), 600);
    d.updateEffect('repeat_x', 0);
    t.equal(Math.round(d.getAABB().width), 200);
    t.end();
});

test('the inverse matrix maps a point of the sheared quad back into the texture', t => {
    const d = makeDrawable([100, 100], [50, 50]);
    d.updateEffect('horizontal_shear', 10);
    d.updateMatrix();
    const m = d._uniforms.u_modelMatrix;
    const corner = twgl.m4.transformPoint(m, [0.5, -0.5, 0]);
    const inv = d._inverseMatrix;
    const back = twgl.m4.transformPoint(inv, corner);
    t.ok(Math.abs(back[0] - 0.5) < 1e-6 && Math.abs(back[1] + 0.5) < 1e-6);
    t.end();
});

const colourDrawable = effects => {
    const d = makeDrawable([10, 10], [5, 5]);
    for (const name of Object.keys(effects)) d.updateEffect(name, effects[name]);
    return d;
};

const transform = (effects, rgba) => {
    const out = new Uint8ClampedArray(rgba);
    return Array.from(EffectTransform.transformColor(colourDrawable(effects), out));
};

const near = (t, actual, expected, message) => {
    t.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 1), `${message}: ${actual} ≈ ${expected}`);
};

test('CPU colour path: red/green/blue multipliers, applied after ghost', t => {
    near(t, transform({red: 100}, [100, 100, 100, 255]), [255, 100, 100, 255], 'red 100 = ×5, clamped');
    near(t, transform({red: -100}, [100, 100, 100, 255]), [0, 100, 100, 255], 'red -100 = ×-3, clamped');
    near(t, transform({green: 25}, [100, 100, 100, 255]), [100, 200, 100, 255], 'green 25 = ×2');
    near(t, transform({blue: -25}, [100, 100, 100, 255]), [100, 100, 0, 255], 'blue -25 = ×0');
    near(t, transform({ghost: 50, red: 25}, [100, 100, 100, 255]), [100, 50, 50, 128], 'ghost first, then ×2');
    t.end();
});

test('CPU colour path: opaque multiplies alpha only', t => {
    near(t, transform({opaque: 50}, [40, 40, 40, 64]), [40, 40, 40, 255], 'opaque');
    near(t, transform({opaque: 1}, [40, 40, 40, 64]), [40, 40, 40, 64], 'opaque 1 = ×1');
    t.end();
});

test('CPU colour path: tint multiplies the straight colour', t => {
    const tint = 0x808080 + 1;
    near(t, transform({tintColor: tint}, [200, 100, 50, 255]), [100, 50, 25, 255], 'grey tint halves');
    near(t, transform({tintColor: 1}, [200, 100, 50, 255]), [0, 0, 0, 255], 'black tint');
    near(t, transform({tintColor: 0xff0000 + 1}, [200, 100, 50, 255]), [200, 0, 0, 255], 'red tint');
    near(t, transform({tintColor: 0x808080 + 1}, [100, 50, 25, 128]), [50, 25, 13, 128], 'premultiplied');
    t.end();
});

test('CPU colour path: saturation', t => {
    near(t, transform({saturation: -100}, [255, 0, 0, 255]), [255, 255, 255, 255], 'no saturation: value only');
    near(t, transform({saturation: -50}, [255, 0, 0, 255]), [255, 128, 128, 255], 'half');
    near(t, transform({saturation: 100}, [255, 128, 128, 255]), [255, 1, 1, 255], 'doubled');
    t.end();
});

test('CPU colour path keeps the vanilla effects working alongside', t => {
    near(t, transform({tintColor: 0x808080 + 1, brightness: 50}, [200, 100, 50, 255]), [228, 178, 153, 255],
        'tint then brightness');
    const vanillaOnly = transform({color: 50}, [255, 0, 0, 255]);
    const withRed = transform({color: 50, red: 0.0001}, [255, 0, 0, 255]);
    near(t, withRed, vanillaOnly, 'color effect same in both paths');
    t.end();
});

test('repeat tiles texture coordinates like fract(t * N)', t => {
    const d = colourDrawable({repeat_x: 2, repeat_y: -3});
    const out = EffectTransform.transformPoint(d, [0.75, 0.5, 0], twgl.v3.create());
    t.ok(Math.abs(out[0] - 0.5) < 1e-9);
    t.ok(Math.abs(out[1] - 0.5) < 1e-9);
    const one = colourDrawable({repeat_x: 1});
    const same = EffectTransform.transformPoint(one, [0.75, 0.5, 0], twgl.v3.create());
    t.ok(Math.abs(same[0] - 0.75) < 1e-9);
    t.end();
});

test('converters keep values finite', t => {
    for (const name of NEW) {
        const info = ShaderManager.EFFECT_INFO[name];
        for (const x of [Infinity, -Infinity, NaN, 1e12]) {
            t.ok(Number.isFinite(info.converter(x)), `${name}(${x})`);
        }
    }
    t.equal(ctPmEffects.EFFECTS.tintColor.converter(0xff8800 + 1), 0xff8800);
    t.end();
});
